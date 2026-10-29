import { app, BrowserWindow, Notification, screen, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db, getSettings, setSettings, type WindowState } from './store'
import { emit } from './events'
import { setPanelHost } from './web/panel'

let mainWindow: BrowserWindow | undefined

export const UI_SCALE_MIN = 0.75
export const UI_SCALE_MAX = 1.5
const clampScale = (s: number) => Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round((Number.isFinite(s) ? s : 1) * 100) / 100))

/**
 * Download progress on the taskbar button: 0–1 = share done, >1 = busy without a known size, <0 = nothing running.
 * `waiting`: a download needs the user's click; the button turns yellow and flashes while NexusForge is in the background.
 */
export function setDownloadProgress(value: number, waiting = false): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (value < 0) win.setProgressBar(-1)
  else if (waiting) win.setProgressBar(value > 1 ? 1 : Math.max(0.05, value), { mode: 'paused' })
  else if (value > 1) win.setProgressBar(2, { mode: 'indeterminate' })
  else win.setProgressBar(Math.max(0.01, value), { mode: 'normal' })
  if (waiting && !win.isFocused()) win.flashFrame(true)
}

/** A finished install while the user is in a game or another window: a Windows notification. */
export function notifyInBackground(title: string, body?: string): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  n.show()
}

/** Applies Settings › Interface size to the main window (the whole UI scales; web pages in the panel don't). */
export function applyUiScale(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.setZoomFactor(clampScale(getSettings().uiScale ?? 1))
}

export function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
}

function restoreState(): WindowState {
  const saved = db().get('window')
  // Drop positions that are no longer on any screen (monitor unplugged).
  if (saved.x !== undefined && saved.y !== undefined) {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea
      return saved.x! >= b.x - 50 && saved.y! >= b.y - 50 && saved.x! < b.x + b.width - 100 && saved.y! < b.y + b.height - 100
    })
    if (!visible) return { width: saved.width, height: saved.height, maximized: saved.maximized }
  }
  return saved
}

export function createMainWindow(): BrowserWindow {
  const state = restoreState()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#070709',
    title: 'NexusForge',
    // The .ico has the small sizes drawn for their size (title bar, taskbar, Alt+Tab).
    icon: join(import.meta.dirname, `../../resources/icon.${process.platform === 'win32' ? 'ico' : 'png'}`),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  if (state.maximized) win.maximize()
  setPanelHost(win)
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  win.on('focus', () => win.flashFrame(false))
  win.webContents.on('did-finish-load', applyUiScale)
  // Ctrl + mouse wheel: bigger or smaller interface, remembered like the setting.
  win.webContents.on('zoom-changed', (_e, direction) => {
    const next = clampScale((getSettings().uiScale ?? 1) + (direction === 'in' ? 0.05 : -0.05))
    setSettings({ uiScale: next })
    applyUiScale()
    emit('settings:changed', getSettings())
  })

  const saveState = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const maximized = win.isMaximized()
    // While maximized keep the last normal bounds so un-maximizing restores them.
    const b = maximized ? db().get('window') : win.getBounds()
    db().set('window', { x: b.x, y: b.y, width: b.width, height: b.height, maximized })
  }
  win.on('resized', saveState)
  win.on('moved', saveState)
  win.on('close', saveState)
  win.on('maximize', () => {
    saveState()
    emit('window:maximized', true)
  })
  win.on('unmaximize', () => {
    saveState()
    emit('window:maximized', false)
  })
  win.once('ready-to-show', () => win.show())

  const url = rendererUrl()
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url.split('#')[0])) {
      event.preventDefault()
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(url)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}
