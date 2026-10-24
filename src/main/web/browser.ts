// Web pages NexusForge loads as a real browser: sites behind bot checks (ModDB) and download pages where a
// person has to click (Nexus "Slow download" for free accounts). Everything runs inside the main window's
// site panel; nothing opens a separate window. The user browses as themselves in a persistent session per
// site; NexusForge only captures the file they download.

import { session, WebContentsView, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { safeName, shortId } from '../util/fs'
import { BROWSER_UA } from '../sources/http'
import { scoped } from '../logger'
import { addPanelEntry, isPanelShown, markInteractive, removePanelEntry, setPanelHint, showPanelEntry } from './panel'
import { PAGE_HELPERS, type PageHelper, type PageHelperState } from './helpers'

const log = scoped('browser')

function prepareSession(partition: string): Session {
  const s = session.fromPartition(partition)
  // The default Electron user agent contains "Electron/…", which some sites treat as a bot.
  s.setUserAgent(BROWSER_UA.replace(' NexusForge/1.0', ''))
  return s
}

function newView(partition: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  return view
}

const isNxm = (u: string) => /^nxm:\/\//i.test(u)

/** Pop-ups (login, download mirrors) open in the same view so the capture keeps working. */
function keepInView(wc: WebContents, onNxm?: (url: string) => void): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (isNxm(url)) onNxm?.(url)
    else if (/^https?:\/\//i.test(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isNxm(url)) {
      e.preventDefault()
      onNxm?.(url)
    }
  })
  wc.on('will-frame-navigate', (e) => {
    if (isNxm(e.url)) {
      e.preventDefault()
      onNxm?.(e.url)
    }
  })
}

/** Social logins (Google, Discord, Steam, Apple, Microsoft) that sites open as pop-ups talking back to the page. */
const AUTH_POPUP = /^https:\/\/(accounts\.google\.com|(www\.)?discord\.com\/(oauth2|login)|steamcommunity\.com\/openid|appleid\.apple\.com|login\.live\.com|login\.microsoftonline\.com|(www\.)?twitch\.tv\/login|id\.twitch\.tv)/i

/**
 * A page view in a site's persistent session (sign-in pages). Pop-ups open in the same view, except social logins:
 * those need a real pop-up (it reports back to the page that opened it), shown as a small window over NexusForge.
 */
export function siteView(partition: string): WebContentsView {
  prepareSession(partition)
  const view = newView(partition)
  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (AUTH_POPUP.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          title: 'Sign in',
          backgroundColor: '#101114',
          webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false }
        }
      }
    }
    if (/^https?:\/\//i.test(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })
  return view
}

/** Forgets a site's login: cookies, storage and cache of its session. */
export async function clearSiteSession(partition: string): Promise<void> {
  const s = session.fromPartition(partition)
  await s.clearStorageData()
  await s.clearCache()
}

// ---------------------------------------------------------------------------
// Page loader for sites behind bot checks

let htmlQueue: Promise<unknown> = Promise.resolve()

const CHALLENGE_PROBE = `(() => {
  const t = document.title || ''
  const challenged = /just a moment|attention required|verify you are human|checking your browser/i.test(t) ||
    !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile, #challenge-stage')
  return { challenged, ready: document.readyState === 'complete', title: t }
})()`

/**
 * Loads a page in the background and returns its HTML once any bot check has passed. If the check needs a
 * click, the page appears in the site panel so the user can solve it. Calls are serialized.
 */
export function browserHtml(url: string, partition = 'persist:web', timeoutMs = 90_000): Promise<string> {
  const run = async (): Promise<string> => {
    prepareSession(partition)
    const id = shortId('page')
    const view = newView(partition)
    const wc = view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      host = url
    }
    let cancelled = false
    addPanelEntry({ id, title: host, hint: `Loading ${host}…`, view, show: false, onCancel: () => (cancelled = true) })
    try {
      await wc.loadURL(url).catch(() => {})
      const started = Date.now()
      let shown = false
      while (Date.now() - started < timeoutMs) {
        if (cancelled || wc.isDestroyed()) throw new Error('The page was closed before it finished loading.')
        const state = (await wc.executeJavaScript(CHALLENGE_PROBE).catch(() => ({ challenged: true, ready: false, title: '' }))) as {
          challenged: boolean
          ready: boolean
        }
        if (!state.challenged && state.ready) return (await wc.executeJavaScript('document.documentElement.outerHTML')) as string
        if (state.challenged && !shown && Date.now() - started > 8000) {
          shown = true
          markInteractive(id, true)
          setPanelHint(id, `${host} wants to make sure you're human. Confirm it here once; NexusForge continues by itself.`)
          showPanelEntry(id)
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      throw new Error(`${host} did not finish loading (bot check not passed).`)
    } finally {
      removePanelEntry(id)
    }
  }
  const next = htmlQueue.catch(() => {}).then(run)
  htmlQueue = next
  return next
}

// ---------------------------------------------------------------------------
// Download captures

export interface CaptureHandlers {
  onStart(fileName: string, total: number): void
  onProgress(received: number, total: number, speed: number): void
  onDone(filePath: string): void
  onError(message: string): void
  /** The page offered an nxm:// link (Nexus "Mod Manager Download"). */
  onNxm?(url: string): void
  /** What the user has to do on the page; `shown` = the page is (being) put in front of them. */
  onNeedsUser?(hint: string, shown: boolean): void
}

interface Capture {
  id: string
  wc: WebContents
  saveDir: string
  handlers: CaptureHandlers
  finished: boolean
  started: boolean
}

const captures = new Map<number, Capture>()
const hooked = new WeakSet<Session>()

function captureFor(wc: WebContents | undefined | null, s: Session): Capture | undefined {
  if (wc && captures.has(wc.id)) return captures.get(wc.id)
  // Downloads started from a frame or service worker belong to the most recent open capture of that session.
  return [...captures.values()].filter((c) => !c.finished && !c.wc.isDestroyed() && c.wc.session === s).pop()
}

function hookSession(s: Session, partition: string): void {
  if (hooked.has(s)) return
  hooked.add(s)
  s.on('will-download', (_event, item, wc) => {
    const capture = captureFor(wc, s)
    if (!capture) return
    const fileName = safeName(item.getFilename() || 'download.zip')
    const path = join(capture.saveDir, `${capture.id}-${fileName}`)
    item.setSavePath(path)
    capture.started = true
    capture.handlers.onStart(fileName, item.getTotalBytes())
    let lastBytes = 0
    let lastTime = Date.now()
    item.on('updated', () => {
      const now = Date.now()
      const received = item.getReceivedBytes()
      const speed = ((received - lastBytes) / Math.max(1, now - lastTime)) * 1000
      lastBytes = received
      lastTime = now
      capture.handlers.onProgress(received, item.getTotalBytes(), speed)
    })
    item.once('done', (_e, state) => {
      capture.finished = true
      if (state === 'completed') capture.handlers.onDone(path)
      else capture.handlers.onError(state === 'cancelled' ? 'Download cancelled' : 'Download interrupted')
      setTimeout(() => removePanelEntry(capture.id), 400)
    })
    // The file is on its way; the page isn't needed on screen anymore.
    if (isPanelShown(capture.id)) setTimeout(() => removePanelEntry(capture.id), 900)
  })
  // Chromium asks before handing unknown schemes (nxm://) to the OS; take them ourselves instead.
  s.setPermissionRequestHandler((wc, permission, callback, details) => {
    const external = (details as { externalURL?: string }).externalURL
    if (permission === 'openExternal' && external && isNxm(external)) captureFor(wc, s)?.handlers.onNxm?.(external)
    callback(false)
  })
  log.info(`download capture enabled for ${partition}`)
}

export interface CaptureHandle {
  focus(): void
  close(): void
}

/**
 * Opens a download page in the site panel and captures the file the page (or the user) downloads.
 * `interactive: false` loads it in the background; it only appears if the download doesn't start by itself.
 */
export function openCapture(opts: {
  id: string
  pageUrl: string
  partition: string
  title: string
  hint: string
  saveDir: string
  interactive: boolean
  helper?: PageHelper
  handlers: CaptureHandlers
}): CaptureHandle {
  const s = prepareSession(opts.partition)
  hookSession(s, opts.partition)
  const view = newView(opts.partition)
  const wc = view.webContents
  const capture: Capture = { id: opts.id, wc, saveDir: opts.saveDir, handlers: opts.handlers, finished: false, started: false }
  captures.set(wc.id, capture)
  keepInView(wc, (url) => opts.handlers.onNxm?.(url))

  let closedByUs = false
  const cleanup = () => {
    clearInterval(helperTimer)
    clearTimeout(fallbackTimer)
    for (const [k, v] of captures) if (v === capture) captures.delete(k)
  }
  wc.once('destroyed', () => {
    cleanup()
    if (!capture.finished && !closedByUs) {
      capture.finished = true
      opts.handlers.onError('The download page was closed before the download started.')
    }
  })

  const needsUser = (hint: string, show: boolean) => {
    if (capture.started || capture.finished) return
    if (show) markInteractive(opts.id, true)
    setPanelHint(opts.id, hint)
    opts.handlers.onNeedsUser?.(hint, show)
  }

  // Site helpers point at the button the user has to click (they never click it themselves).
  const helper = opts.helper ? PAGE_HELPERS[opts.helper] : undefined
  let lastStep = ''
  const runHelper = async () => {
    if (!helper || capture.started || capture.finished || wc.isDestroyed()) return
    const state = (await wc
      .executeJavaScriptInIsolatedWorld(1001, [{ code: helper.script }])
      .catch(() => undefined)) as PageHelperState | undefined
    if (!state) return
    const hint = helper.hint(state)
    const step = `${state.step}|${state.loggedOut}`
    if (hint && step !== lastStep) {
      lastStep = step
      needsUser(hint, opts.interactive || isPanelShown(opts.id))
    }
  }
  const helperTimer = setInterval(() => void runHelper(), 1500)
  wc.on('did-finish-load', () => void runHelper())

  // Background pages come forward when the site doesn't start the download within 20 s.
  const fallbackTimer = setTimeout(() => {
    if (opts.interactive || capture.started || capture.finished) return
    needsUser(`${opts.title}: the site didn't start the download by itself. Click its download link here.`, true)
    showPanelEntry(opts.id)
  }, 20_000)

  if (opts.interactive) markInteractive(opts.id, true)
  addPanelEntry({
    id: opts.id,
    title: opts.title,
    hint: opts.hint,
    view,
    show: opts.interactive,
    onCancel: () => {
      capture.finished = true
      closedByUs = true
      opts.handlers.onError('Download cancelled')
      removePanelEntry(opts.id)
    }
  })
  void wc.loadURL(opts.pageUrl)

  return {
    focus: () => {
      showPanelEntry(opts.id)
    },
    close: () => {
      capture.finished = true
      closedByUs = true
      removePanelEntry(opts.id)
    }
  }
}

/** Mark a capture as handled elsewhere (e.g. an nxm link was turned into a direct download) and close it. */
export function finishCapture(id: string): void {
  for (const c of captures.values()) {
    if (c.id === id) c.finished = true
  }
  removePanelEntry(id)
}
