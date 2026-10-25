import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db, type WindowState } from './store'
import { emit } from './events'
import { setPanelHost } from './web/panel'

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
    backgroundColor: '#030405',
    title: 'NexusForge',
    icon: join(import.meta.dirname, '../../resources/icon.png'),
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
