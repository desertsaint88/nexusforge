import { createWriteStream, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { DownloadItem, DownloadRequest } from '@shared/types'
import { db } from '../store'
import { paths } from '../paths'
import { emit, toast } from '../events'
import { scoped } from '../logger'
import { safeName, shortId, walkFiles } from '../util/fs'
import { sourceDownloadPlan } from '../sources/registry'
import type { DownloadPlan } from '../sources/types'
import { USER_AGENT } from '../sources/http'
import { installMod } from '../mods/manager'
import { finishCapture, openCapture } from '../web/browser'
import { downloadWorkshopItem } from '../steam/steamcmd'
import { addonSlug, extractGma } from '../steam/gma'
import { extractLzma } from '../mods/archive'
import { getGame } from '../library/library'
import { findPreset } from '../library/presets'

const log = scoped('downloads')

const items = new Map<string, DownloadItem>()
const requests = new Map<string, DownloadRequest>()
const controllers = new Map<string, AbortController>()
const windows = new Map<string, { focus(): void; close(): void }>()
let loaded = false

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  for (const d of db().get('downloads')) {
    // Anything that was mid-flight when the app closed is gone.
    const active = d.state === 'downloading' || d.state === 'queued' || d.state === 'installing' || d.state === 'waiting'
    items.set(d.id, { ...d, state: active ? 'failed' : d.state, error: active && !d.error ? 'Interrupted' : d.error, speed: 0, hint: undefined })
  }
}

function persist(): void {
  const list = [...items.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100)
  db().set('downloads', list)
}

function update(item: DownloadItem, patch: Partial<DownloadItem>, save = false): void {
  Object.assign(item, patch)
  emit('downloads:update', { ...item })
  if (save) persist()
}

export function listDownloads(): DownloadItem[] {
  ensureLoaded()
  return [...items.values()].sort((a, b) => b.startedAt - a.startedAt)
}

function fileNameFrom(res: Response | undefined, url: string): string {
  const cd = res?.headers.get('content-disposition') ?? ''
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i)
  let name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain?.[1]
  if (!name) {
    try {
      name = decodeURIComponent(basename(new URL(res?.url || url).pathname))
    } catch {
      name = undefined
    }
  }
  return safeName(name || 'download.zip')
}

export async function startDownload(req: DownloadRequest): Promise<DownloadItem> {
  ensureLoaded()
  const plan = await sourceDownloadPlan(req.sourceId, req.modId, req.versionId, req.gameId)
  const item: DownloadItem = {
    id: shortId('d'),
    name: req.name ?? req.modId,
    fileName: '',
    url: plan.kind === 'url' ? plan.url : plan.kind === 'browser' ? plan.pageUrl : `steam://workshop/${plan.appId}/${plan.itemId}`,
    sourceId: req.sourceId,
    modRef: { sourceId: req.sourceId, modId: req.modId, versionId: req.versionId },
    gameId: req.gameId,
    state: 'queued',
    received: 0,
    total: 0,
    speed: 0,
    startedAt: Date.now(),
    thumbnail: req.thumbnail
  }
  items.set(item.id, item)
  requests.set(item.id, req)
  update(item, {}, true)
  void execute(item, req, plan)
  return item
}

function execute(item: DownloadItem, req: DownloadRequest, plan: DownloadPlan): Promise<void> {
  if (plan.kind === 'browser') return runBrowser(item, req, plan)
  if (plan.kind === 'steamcmd') return runSteam(item, req, plan)
  return runUrl(item, req, plan.url, plan.headers, plan.fileName)
}

async function runUrl(item: DownloadItem, req: DownloadRequest, url: string, headers?: Record<string, string>, fileNameHint?: string): Promise<void> {
  const controller = new AbortController()
  controllers.set(item.id, controller)
  update(item, { state: 'downloading', url, received: 0, total: 0, error: undefined, hint: undefined })
  try {
    let file: string
    if (url.startsWith('file:')) {
      const src = fileURLToPath(url)
      const fileName = safeName(basename(src))
      file = join(paths.downloads(), `${item.id}-${fileName}`)
      const st = await fsp.stat(src)
      update(item, { fileName, total: st.size })
      await fsp.copyFile(src, file)
      update(item, { received: st.size })
    } else {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`Server answered ${res.status} ${res.statusText}`)
      const fileName = fileNameHint ? safeName(fileNameHint) : fileNameFrom(res, url)
      file = join(paths.downloads(), `${item.id}-${fileName}`)
      update(item, { fileName, total: Number(res.headers.get('content-length') ?? 0) })
      let received = 0
      let lastEmit = 0
      let lastBytes = 0
      let lastTime = Date.now()
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length
          const now = Date.now()
          if (now - lastEmit > 200) {
            const speed = ((received - lastBytes) / Math.max(1, now - lastTime)) * 1000
            lastBytes = received
            lastTime = now
            lastEmit = now
            update(item, { received, speed })
          }
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(file), { signal: controller.signal })
      update(item, { received, total: item.total || received, speed: 0 })
    }
    await finished(item, req, file)
  } catch (err) {
    const aborted = controller.signal.aborted
    fail(item, aborted ? undefined : (err as Error).message, aborted)
    const partial = (await fsp.readdir(paths.downloads()).catch(() => [] as string[])).find((f) => f.startsWith(`${item.id}-`))
    if (partial && !item.filePath) await fsp.rm(join(paths.downloads(), partial), { force: true })
  } finally {
    controllers.delete(item.id)
  }
}

/**
 * Downloads that come from a web page, inside NexusForge's site panel: either the site starts the file by
 * itself (ModDB, loaded in the background) or the user clicks the highlighted button (Nexus free accounts).
 */
function runBrowser(item: DownloadItem, req: DownloadRequest, plan: Extract<DownloadPlan, { kind: 'browser' }>): Promise<void> {
  return new Promise<void>((resolve) => {
    const interactive = plan.interactive !== false
    update(
      item,
      interactive
        ? { state: 'waiting', hint: plan.hint, pageUrl: plan.pageUrl, error: undefined }
        : { state: 'downloading', hint: plan.hint, pageUrl: plan.pageUrl, error: undefined, received: 0, total: 0 },
      true
    )
    let handedOff = false
    const handle = openCapture({
      id: item.id,
      pageUrl: plan.pageUrl,
      partition: plan.partition,
      title: item.name,
      hint: plan.hint,
      saveDir: paths.downloads(),
      interactive,
      helper: plan.helper,
      handlers: {
        onNeedsUser: (hint, shown) => update(item, shown ? { state: 'waiting', hint } : { hint }),
        onStart: (fileName, total) => update(item, { state: 'downloading', fileName, total, received: 0, hint: undefined }),
        onProgress: (received, total, speed) => update(item, { received, total: total || item.total, speed }),
        onDone: (file) => {
          windows.delete(item.id)
          update(item, { received: item.total || item.received, speed: 0 })
          void finished(item, req, file).finally(resolve)
        },
        onError: (message) => {
          windows.delete(item.id)
          if (handedOff) return
          if (item.state === 'waiting' || item.state === 'downloading') fail(item, message, /closed|cancelled/i.test(message))
          resolve()
        },
        onNxm: async (url) => {
          if (!plan.resolveNxm) return
          try {
            const direct = await plan.resolveNxm(url)
            handedOff = true
            finishCapture(item.id)
            await runUrl(item, req, direct)
            resolve()
          } catch (err) {
            const msg = (err as Error).message
            toast(
              'info',
              'Use "Manual download" instead',
              msg === 'NEXUS_NO_KEY'
                ? 'The "Mod Manager Download" button needs you signed in to Nexus Mods under Accounts. Until then, use "Manual download" → "Slow download" in the panel; NexusForge catches the file.'
                : msg
            )
          }
        }
      }
    })
    windows.set(item.id, handle)
  })
}

/** Workshop items: SteamCMD downloads them, Garry's Mod .gma/.bin files are unpacked into addon folders. */
async function runSteam(item: DownloadItem, req: DownloadRequest, plan: Extract<DownloadPlan, { kind: 'steamcmd' }>): Promise<void> {
  update(item, { state: 'downloading', hint: 'Starting SteamCMD…', fileName: plan.title, error: undefined })
  try {
    const dir = await downloadWorkshopItem(plan.appId, plan.itemId, (s) => update(item, { hint: s }))
    const files = await walkFiles(dir)
    const total = files.reduce((a, f) => a + f.size, 0)
    update(item, { received: total, total, hint: 'Preparing files…' })
    const staging = join(paths.downloads(), `${item.id}-workshop`)
    await fsp.rm(staging, { recursive: true, force: true })
    const game = req.gameId ? getGame(req.gameId) : undefined
    const slug = addonSlug(plan.title, plan.itemId)
    const gma = files.find((f) => /\.gma$/i.test(f.rel))
    const bin = files.find((f) => /_legacy\.bin$|\.bin$/i.test(f.rel))
    if (plan.appId === '4000' && (gma || bin)) {
      // Garry's Mod: unpack to addons/<slug>/ (works for every GMod install, including ones that relocate .gma files).
      const raw = gma?.abs ?? (await extractLzma(bin!.abs, join(staging, 'unbin')))
      const head = await fsp.open(raw, 'r').then(async (h) => {
        const b = Buffer.alloc(4)
        await h.read(b, 0, 4, 0)
        await h.close()
        return b.toString('ascii')
      })
      if (head === 'GMAD') {
        await extractGma(raw, join(staging, 'addon', slug))
      } else if (head === 'DUP3' || head === 'GMSV') {
        // Old Workshop dupes and saves: an addon folder mounts them into GMod's dupes/ and saves/ menus.
        const [sub, ext] = head === 'DUP3' ? ['dupes', '.dupe'] : ['saves', '.gms']
        await fsp.mkdir(join(staging, 'addon', slug, sub), { recursive: true })
        await fsp.copyFile(raw, join(staging, 'addon', slug, sub, `${slug}${ext}`))
      } else {
        throw new Error("This Garry's Mod Workshop item is not an addon, dupe or save NexusForge knows.")
      }
      await fsp.rm(join(staging, 'unbin'), { recursive: true, force: true })
      await finished(item, req, join(staging, 'addon'))
    } else {
      // Games where every mod is its own folder get one named after the item.
      const wrap = game && findPreset(game)?.keepWrapper
      const target = wrap ? join(staging, 'item', slug) : join(staging, 'item')
      await fsp.cp(dir, target, { recursive: true })
      await finished(item, req, join(staging, 'item'))
    }
  } catch (err) {
    fail(item, (err as Error).message, false)
  }
}

function fail(item: DownloadItem, message: string | undefined, cancelled: boolean): void {
  update(item, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message, speed: 0, hint: undefined, finishedAt: Date.now() }, true)
  if (!cancelled && message) {
    log.warn(`download failed for ${item.name}: ${message}`)
    toast('error', `Download failed: ${item.name}`, message)
  }
}

async function finished(item: DownloadItem, req: DownloadRequest, file: string): Promise<void> {
  update(item, { filePath: file, hint: undefined }, true)
  log.info(`downloaded ${item.name} -> ${file}`)
  if (item.gameId) await installDownloaded(item, item.gameId, req)
  else update(item, { state: 'completed', finishedAt: Date.now() }, true)
}

async function installDownloaded(item: DownloadItem, gameId: string, req?: DownloadRequest): Promise<void> {
  if (!item.filePath) throw new Error('Nothing downloaded yet')
  update(item, { state: 'installing', gameId })
  try {
    const mod = await installMod(gameId, item.filePath, {
      name: req?.name ?? item.name,
      version: req?.version,
      author: req?.author,
      summary: req?.summary,
      thumbnail: req?.thumbnail ?? item.thumbnail,
      source: item.modRef ? { ...item.modRef, url: item.pageUrl ?? item.url, name: req?.name ?? item.name } : undefined,
      requires: req?.requires
    })
    update(item, { state: 'completed', installedModId: mod.id, finishedAt: Date.now() }, true)
    toast('success', `Installed ${mod.name}`, 'Deploy to apply it to the game.')
  } catch (err) {
    update(item, { state: 'failed', error: `Install failed: ${(err as Error).message}`, finishedAt: Date.now() }, true)
    toast('error', `Couldn't install ${item.name}`, (err as Error).message)
  }
}

export function cancelDownload(id: string): void {
  controllers.get(id)?.abort()
  const w = windows.get(id)
  if (w) {
    windows.delete(id)
    w.close()
    const item = items.get(id)
    if (item && (item.state === 'waiting' || item.state === 'downloading')) fail(item, undefined, true)
  }
}

/** Brings the page of a waiting download back into the site panel (or reopens it). */
export async function focusDownload(id: string): Promise<void> {
  const w = windows.get(id)
  if (w) return w.focus()
  const item = items.get(id)
  if (item) await retryDownload(id)
}

export async function retryDownload(id: string): Promise<DownloadItem> {
  ensureLoaded()
  const item = items.get(id)
  if (!item) throw new Error('Download not found')
  if (item.state === 'downloading' || item.state === 'installing') return item
  // Its page is still open (waiting for a click): bring it back instead of opening a second one.
  const open = windows.get(id)
  if (open) {
    open.focus()
    return item
  }
  const req =
    requests.get(id) ??
    (item.modRef
      ? { sourceId: item.modRef.sourceId, modId: item.modRef.modId, versionId: item.modRef.versionId ?? '', gameId: item.gameId, name: item.name, thumbnail: item.thumbnail }
      : undefined)
  if (!req) throw new Error('This download cannot be retried')
  if (item.filePath && item.state === 'failed' && item.gameId) {
    await installDownloaded(item, item.gameId, req)
    return item
  }
  const plan = await sourceDownloadPlan(req.sourceId, req.modId, req.versionId, req.gameId)
  void execute(item, req, plan)
  return item
}

export async function installDownload(id: string, gameId: string): Promise<DownloadItem> {
  ensureLoaded()
  const item = items.get(id)
  if (!item) throw new Error('Download not found')
  await installDownloaded(item, gameId, requests.get(id))
  return item
}

/** Removes finished entries and the archives they downloaded. */
export async function clearDownloads(): Promise<DownloadItem[]> {
  ensureLoaded()
  for (const [id, item] of items) {
    if (item.state === 'downloading' || item.state === 'installing' || item.state === 'queued' || item.state === 'waiting') continue
    if (item.filePath && item.filePath.startsWith(paths.downloads())) await fsp.rm(item.filePath, { recursive: true, force: true }).catch(() => {})
    items.delete(id)
    requests.delete(id)
  }
  persist()
  return listDownloads()
}
