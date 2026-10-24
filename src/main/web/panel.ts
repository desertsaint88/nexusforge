// The site panel: web pages NexusForge needs the user for (Nexus "Slow download", bot checks) are shown inside
// the main window, over a placeholder the renderer draws, instead of in separate browser windows.
// Several pages can wait at once; one is shown at a time.

import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import type { SitePanelState } from '@shared/types'
import { emit } from '../events'

interface Entry {
  id: string
  title: string
  hint: string
  view: WebContentsView
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
    waiting: [...entries.values()].map((x) => ({ id: x.id, title: x.title }))
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
  e.view.webContents.focus()
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

export function setPanelHint(id: string, hint: string): void {
  const e = entries.get(id)
  if (!e || e.hint === hint) return
  e.hint = hint
  if (shownId === id) publish()
}

/** Removes a page from the panel and closes it. */
export function removePanelEntry(id: string): void {
  const e = entries.get(id)
  if (!e) return
  const wasShown = shownId === id
  if (wasShown) detach()
  entries.delete(id)
  panelWanted.delete(id)
  const wc = e.view.webContents
  if (!wc.isDestroyed()) wc.close()
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
