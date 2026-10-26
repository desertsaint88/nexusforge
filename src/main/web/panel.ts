// The site panel: web pages NexusForge needs the user for (Nexus "Slow download", bot checks) are shown inside
// the main window, over a placeholder the renderer draws, instead of in separate browser windows.
// Several pages can wait at once; one is shown at a time.

import { BrowserWindow, shell, WebContentsView, type Rectangle } from 'electron'
import type { SitePanelState } from '@shared/types'
import { emit } from '../events'

interface Entry {
  id: string
  title: string
  hint: string
  view: WebContentsView
  /** The site's bot check refused this page. */
  blocked?: boolean
  /** Called when the user cancels from the panel header. */
  onCancel?(): void
}

const entries = new Map<string, Entry>()
let host: BrowserWindow | undefined
let shownId: string | undefined
let bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

export function setPanelHost(win: BrowserWindow): void {
  host = win
  win.on('closed', () => {
    if (host === win) host = undefined
  })
}

function hostWindow(): BrowserWindow | undefined {
  if (host && !host.isDestroyed()) return host
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
}

export function panelState(): SitePanelState {
  const e = shownId ? entries.get(shownId) : undefined
  const wc = e?.view.webContents
  let url = ''
  try {
    url = wc && !wc.isDestroyed() ? wc.getURL() : ''
  } catch {
    url = ''
  }
  return {
    open: Boolean(e),
    id: e?.id,
    title: e?.title ?? '',
    hint: e?.hint ?? '',
    url,
    loading: Boolean(wc && !wc.isDestroyed() && wc.isLoading()),
    canGoBack: Boolean(wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()),
    waiting: [...entries.values()].map((x) => ({ id: x.id, title: x.title })),
    blocked: Boolean(e?.blocked)
  }
}

function publish(): void {
  emit('sitepanel:state', panelState())
}

function attach(e: Entry): void {
  const win = hostWindow()
  if (!win) return
  if (shownId && shownId !== e.id) detach()
  win.contentView.addChildView(e.view)
  if (bounds.width > 0 && bounds.height > 0) e.view.setBounds(bounds)
  shownId = e.id
  if (win.isMinimized()) win.restore()
  win.focus()
  const wc = e.view.webContents as Electron.WebContents | undefined
  if (wc && !wc.isDestroyed()) wc.focus()
}

function detach(): void {
  const e = shownId ? entries.get(shownId) : undefined
  shownId = undefined
  const win = hostWindow()
  if (e && win) {
    try {
      win.contentView.removeChildView(e.view)
    } catch {
      // already removed
    }
  }
}

/** Registers a page. `show` puts it in front right away; otherwise it loads in the background. */
export function addPanelEntry(opts: { id: string; title: string; hint: string; view: WebContentsView; show: boolean; onCancel?(): void }): void {
  const e: Entry = { id: opts.id, title: opts.title, hint: opts.hint, view: opts.view, onCancel: opts.onCancel }
  entries.set(e.id, e)
  opts.view.setBorderRadius(14)
  opts.view.setBackgroundColor('#101114')
  const wc = opts.view.webContents
  const refresh = () => {
    if (shownId === e.id) publish()
  }
  wc.on('did-start-loading', refresh)
  wc.on('did-stop-loading', refresh)
  wc.on('did-navigate', refresh)
  wc.on('did-navigate-in-page', refresh)
  if (opts.show) attach(e)
  publish()
}

export function showPanelEntry(id: string): boolean {
  const e = entries.get(id)
  if (!e) return false
  attach(e)
  publish()
  return true
}

export function isPanelShown(id: string): boolean {
  return shownId === id
}

/** The page is still registered in the panel (shown or waiting in the background). */
export function isPanelEntry(id: string): boolean {
  return entries.has(id)
}

export function setPanelHint(id: string, hint: string): void {
  const e = entries.get(id)
  if (!e || e.hint === hint) return
  e.hint = hint
  if (shownId === id) publish()
}

const BLOCKED_HINT =
  "The site's bot check (Cloudflare) keeps refusing this window. Click “Open in my browser” and finish there; for an account, copy your API key there and NexusForge picks it up."

/** Marks a page whose bot check failed even after a retry; the panel then offers the user's own browser. */
export function setPanelBlocked(id: string, blocked: boolean): void {
  const e = entries.get(id)
  if (!e || Boolean(e.blocked) === blocked) return
  e.blocked = blocked
  if (blocked) e.hint = BLOCKED_HINT
  if (shownId === id) publish()
}

/** Opens the page shown in the panel in the default browser. */
export async function openShownExternally(): Promise<void> {
  const e = shownId ? entries.get(shownId) : undefined
  const wc = e?.view.webContents
  const url = wc && !wc.isDestroyed() ? wc.getURL() : ''
  if (!/^https?:\/\//i.test(url)) throw new Error('No web page is open.')
  await shell.openExternal(url)
}

/**
 * Removes a page from the panel and closes it. `keepPage` only takes it off screen: a download the page started
 * runs inside that page, and closing it would cancel the download.
 */
export function removePanelEntry(id: string, keepPage = false): void {
  const e = entries.get(id)
  if (!e) return
  const wasShown = shownId === id
  if (wasShown) detach()
  entries.delete(id)
  panelWanted.delete(id)
  // During shutdown the view's page can already be gone.
  const wc = e.view.webContents as Electron.WebContents | undefined
  if (!keepPage && wc && !wc.isDestroyed()) wc.close()
  // The next page that needs the user takes its place; otherwise the panel closes.
  const next = wasShown ? [...entries.values()].find((x) => panelWanted.has(x.id)) : undefined
  if (next) attach(next)
  publish()
}

/** Pages the user should see next when the current one finishes (interactive ones). */
const panelWanted = new Set<string>()
export function markInteractive(id: string, wanted: boolean): void {
  if (wanted) panelWanted.add(id)
  else panelWanted.delete(id)
}

export function hidePanel(): void {
  detach()
  publish()
}

export function setPanelBounds(r: Rectangle): void {
  bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) }
  const e = shownId ? entries.get(shownId) : undefined
  if (e && bounds.width > 0 && bounds.height > 0) e.view.setBounds(bounds)
}

export function panelNavigate(action: 'back' | 'reload'): void {
  const e = shownId ? entries.get(shownId) : undefined
  const wc = e?.view.webContents
  if (!wc || wc.isDestroyed()) return
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  if (action === 'reload') wc.reload()
}

export function cancelShownPanel(): void {
  const e = shownId ? entries.get(shownId) : undefined
  if (!e) return
  if (e.onCancel) e.onCancel()
  else removePanelEntry(e.id)
}
