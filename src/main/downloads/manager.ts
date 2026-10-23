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
import { safeName, shortId } from '../util/fs'
import { openSourcePage, sourceDownloadUrl } from '../sources/registry'
import { USER_AGENT } from '../sources/http'
import { installMod } from '../mods/manager'

const log = scoped('downloads')

const items = new Map<string, DownloadItem>()
const requests = new Map<string, DownloadRequest>()
const controllers = new Map<string, AbortController>()
let loaded = false

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  for (const d of db().get('downloads')) {
    // Anything that was mid-flight when the app closed is gone.
    const state = d.state === 'downloading' || d.state === 'queued' || d.state === 'installing' ? 'failed' : d.state
    items.set(d.id, { ...d, state, error: state === 'failed' && !d.error ? 'Interrupted' : d.error, speed: 0 })
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
  let url: string
  try {
    url = await sourceDownloadUrl(req.sourceId, req.modId, req.versionId, req.gameId)
  } catch (err) {
    if ((err as Error).message === 'NEXUS_MANUAL') {
      await openSourcePage(req.sourceId, req.modId, req.gameId)
      throw new Error('Nexus Mods only allows direct downloads with a Premium API key. The file page was opened in your browser; drop the downloaded archive onto NexusForge to install it.')
    }
    throw err
  }
  const item: DownloadItem = {
    id: shortId('d'),
    name: req.name ?? req.modId,
    fileName: '',
    url,
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
  void run(item, req)
  return item
}

async function run(item: DownloadItem, req: DownloadRequest): Promise<void> {
  const controller = new AbortController()
  controllers.set(item.id, controller)
  update(item, { state: 'downloading', received: 0, total: 0, error: undefined, startedAt: Date.now() })
  try {
    let file: string
    if (item.url.startsWith('file:')) {
      const src = fileURLToPath(item.url)
      const fileName = safeName(basename(src))
      file = join(paths.downloads(), `${item.id}-${fileName}`)
      const st = await fsp.stat(src)
      update(item, { fileName, total: st.size })
      await fsp.copyFile(src, file)
      update(item, { received: st.size })
    } else {
      const res = await fetch(item.url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`Server answered ${res.status} ${res.statusText}`)
      const fileName = fileNameFrom(res, item.url)
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
    update(item, { filePath: file }, true)
    log.info(`downloaded ${item.name} -> ${file}`)
    if (item.gameId) await installDownloaded(item, item.gameId, req)
    else update(item, { state: 'completed', finishedAt: Date.now() }, true)
  } catch (err) {
    const aborted = controller.signal.aborted
    update(item, { state: aborted ? 'cancelled' : 'failed', error: aborted ? undefined : (err as Error).message, speed: 0, finishedAt: Date.now() }, true)
    if (!aborted) {
      log.warn(`download failed for ${item.name}: ${(err as Error).message}`)
      toast('error', `Download failed: ${item.name}`, (err as Error).message)
    }
    if (item.filePath === undefined) {
      const partial = (await fsp.readdir(paths.downloads()).catch(() => [] as string[])).find((f) => f.startsWith(`${item.id}-`))
      if (partial) await fsp.rm(join(paths.downloads(), partial), { force: true })
    }
  } finally {
    controllers.delete(item.id)
  }
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
      source: item.modRef ? { ...item.modRef, url: item.url } : undefined
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
}

export async function retryDownload(id: string): Promise<DownloadItem> {
  ensureLoaded()
  const item = items.get(id)
  if (!item) throw new Error('Download not found')
  if (item.state === 'downloading' || item.state === 'installing') return item
  const req = requests.get(id) ?? (item.modRef ? { sourceId: item.modRef.sourceId, modId: item.modRef.modId, versionId: item.modRef.versionId ?? '', gameId: item.gameId, name: item.name, thumbnail: item.thumbnail } : undefined)
  if (!req) throw new Error('This download cannot be retried')
  if (item.filePath && item.state === 'failed' && item.gameId) {
    await installDownloaded(item, item.gameId, req)
    return item
  }
  void run(item, req)
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
    if (item.state === 'downloading' || item.state === 'installing' || item.state === 'queued') continue
    if (item.filePath && item.filePath.startsWith(paths.downloads())) await fsp.rm(item.filePath, { force: true }).catch(() => {})
    items.delete(id)
    requests.delete(id)
  }
  persist()
  return listDownloads()
}
