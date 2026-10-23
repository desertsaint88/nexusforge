import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcInvokeMap, InvokeChannel } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { getSettings, setSettings } from './store'
import { logFilePath, scoped, setLogLevel } from './logger'
import { run } from './util/exec'
import { paths } from './paths'
import * as library from './library/library'
import * as mods from './mods/manager'
import * as profiles from './mods/profiles'
import * as sources from './sources/registry'
import * as downloads from './downloads/manager'

const log = scoped('ipc')

type Handler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<IpcInvokeMap[C]>
) => ReturnType<IpcInvokeMap[C]> | Promise<Awaited<ReturnType<IpcInvokeMap[C]>>>

let rendererOrigin = ''

function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  return Boolean(rendererOrigin) && url.startsWith(rendererOrigin)
}

function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) {
      log.warn(`rejected ${channel} from ${event.senderFrame?.url}`)
      throw new Error('Untrusted sender')
    }
    try {
      return await fn(event, ...(args as Parameters<IpcInvokeMap[C]>))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${channel} failed: ${message}`)
      throw new Error(message)
    }
  })
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`)
  return v
}

let elevated: boolean | undefined
async function isElevated(): Promise<boolean> {
  if (elevated === undefined) elevated = process.platform === 'win32' && (await run('net.exe', ['session'], { timeoutMs: 5000 })).code === 0
  return elevated
}

export function registerIpc(rendererUrl: string): void {
  // file:///.../out/renderer/ in production, http://localhost:5173 in dev.
  rendererOrigin = rendererUrl.startsWith('file:') ? rendererUrl.slice(0, rendererUrl.lastIndexOf('/') + 1) : new URL(rendererUrl).origin

  const win = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)

  handle('window:minimize', (e) => win(e)?.minimize())
  handle('window:toggleMaximize', (e) => {
    const w = win(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  handle('window:close', (e) => win(e)?.close())
  handle('window:isMaximized', (e) => Boolean(win(e)?.isMaximized()))

  handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userData: paths.userData(),
    logFile: logFilePath(),
    isElevated: await isElevated()
  }))
  handle('app:openPath', (_e, p) => shell.openPath(str(p, 'path')))
  handle('app:showItem', (_e, p) => shell.showItemInFolder(str(p, 'path')))
  handle('app:openExternal', async (_e, url) => {
    if (!/^https?:\/\//i.test(str(url, 'url'))) throw new Error('Only web links can be opened')
    await shell.openExternal(url)
  })
  handle('app:openLogs', async () => {
    shell.showItemInFolder(logFilePath())
  })
  handle('app:pickFile', async (e, opts) => {
    const w = win(e)
    const res = await dialog.showOpenDialog(w!, { title: opts?.title, filters: opts?.filters, properties: ['openFile'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:pickFiles', async (e, opts) => {
    const res = await dialog.showOpenDialog(win(e)!, { title: opts?.title, filters: opts?.filters, properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  })
  handle('app:pickFolder', async (e, opts) => {
    const res = await dialog.showOpenDialog(win(e)!, { title: opts?.title, defaultPath: opts?.defaultPath, properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  handle('settings:get', () => getSettings())
  handle('settings:set', async (_e, patch) => {
    const allowed: Array<keyof Settings> = [
      'accent', 'reduceMotion', 'minimizeOnLaunch', 'autoFetchArtwork', 'scanPlatforms', 'customFolders', 'modStorageDir',
      'defaultStrategy', 'logLevel', 'sources', 'firstRunComplete'
    ]
    const clean: Partial<Settings> = {}
    for (const k of allowed) if (patch && k in patch) (clean as Record<string, unknown>)[k] = patch[k]
    const next = setSettings(clean)
    if (clean.logLevel) setLogLevel(clean.logLevel)
    if (clean.sources) await sources.reloadSources()
    return next
  })

  handle('library:list', () => library.listGames())
  handle('library:scan', () => library.scanLibrary())
  handle('library:addManual', (_e, input) => library.addManualGame(input))
  handle('library:update', (_e, id, patch) => library.updateGame(str(id, 'game'), patch ?? {}))
  handle('library:remove', async (_e, id) => {
    await mods.forgetGameMods(str(id, 'game'))
    library.removeGameRecord(id)
  })
  handle('library:launch', (_e, id) => library.launchGame(str(id, 'game')))
  handle('library:running', () => library.runningGames())
  handle('library:fetchArtwork', (_e, id) => library.refetchArtwork(str(id, 'game')))
  handle('library:detectExecutables', (_e, dir) => library.detectExecutables(str(dir, 'folder')))

  handle('mods:list', (_e, gameId) => mods.listMods(str(gameId, 'game')))
  handle('mods:installFiles', async (_e, gameId, files) => {
    const out = []
    for (const f of files ?? []) out.push(await mods.installMod(str(gameId, 'game'), str(f, 'file')))
    return out
  })
  handle('mods:remove', (_e, gameId, modId) => mods.removeMod(str(gameId, 'game'), str(modId, 'mod')))
  handle('mods:update', (_e, gameId, modId, patch) => mods.updateMod(str(gameId, 'game'), str(modId, 'mod'), patch ?? {}))
  handle('mods:files', (_e, gameId, modId) => mods.listModFiles(str(gameId, 'game'), str(modId, 'mod')))
  handle('mods:rootCandidates', (_e, gameId, modId) => mods.rootCandidates(str(gameId, 'game'), str(modId, 'mod')))
  handle('mods:openFolder', (_e, gameId, modId) => mods.openModFolder(str(gameId, 'game'), modId))

  handle('profiles:list', (_e, gameId) => profiles.listProfiles(str(gameId, 'game')))
  handle('profiles:create', (_e, gameId, name, cloneFrom) => profiles.createProfile(str(gameId, 'game'), String(name ?? ''), cloneFrom))
  handle('profiles:rename', (_e, gameId, profileId, name) => profiles.renameProfile(str(gameId, 'game'), str(profileId, 'profile'), String(name ?? '')))
  handle('profiles:delete', (_e, gameId, profileId) => profiles.deleteProfile(str(gameId, 'game'), str(profileId, 'profile')))
  handle('profiles:setActive', (_e, gameId, profileId) => profiles.setActiveProfile(str(gameId, 'game'), str(profileId, 'profile')))
  handle('profiles:save', (_e, profile) => {
    if (!profile || typeof profile !== 'object' || !Array.isArray(profile.order) || !Array.isArray(profile.enabled)) throw new Error('Invalid profile')
    return profiles.saveProfile(profile)
  })

  handle('deploy:run', (_e, gameId) => mods.deployGame(str(gameId, 'game')))
  handle('deploy:purge', (_e, gameId) => mods.purgeGame(str(gameId, 'game')))
  handle('deploy:status', (_e, gameId) => mods.deployStatus(str(gameId, 'game')))
  handle('deploy:probe', (_e, gameId) => mods.probeGame(str(gameId, 'game')))
  handle('conflicts:get', (_e, gameId) => mods.getConflicts(str(gameId, 'game')))

  handle('sources:list', () => sources.listSources())
  handle('sources:search', (_e, id, q, gameId) => sources.searchSource(str(id, 'source'), String(q ?? ''), gameId || undefined))
  handle('sources:details', (_e, id, modId, gameId) => sources.sourceDetails(str(id, 'source'), str(modId, 'mod'), gameId || undefined))
  handle('sources:bindings', (_e, id, gameId) => sources.sourceBindings(str(id, 'source'), str(gameId, 'game')))
  handle('sources:openPage', (_e, id, modId, gameId) => sources.openSourcePage(str(id, 'source'), str(modId, 'mod'), gameId || undefined))
  handle('sources:setFeeds', (_e, feeds) => sources.setFeeds(Array.isArray(feeds) ? feeds : []))
  handle('sources:plugins', () => sources.listPlugins())
  handle('sources:trustPlugin', (_e, id, t) => sources.trustPlugin(str(id, 'plugin'), Boolean(t)))
  handle('sources:reload', () => sources.reloadSources())
  handle('sources:openPluginsFolder', async () => {
    await shell.openPath(paths.plugins())
  })

  handle('downloads:list', () => downloads.listDownloads())
  handle('downloads:start', (_e, req) => {
    if (!req || typeof req !== 'object') throw new Error('Invalid download')
    return downloads.startDownload({ ...req, sourceId: str(req.sourceId, 'source'), modId: str(req.modId, 'mod'), versionId: str(req.versionId, 'version') })
  })
  handle('downloads:cancel', (_e, id) => downloads.cancelDownload(str(id, 'download')))
  handle('downloads:retry', (_e, id) => downloads.retryDownload(str(id, 'download')))
  handle('downloads:install', (_e, id, gameId) => downloads.installDownload(str(id, 'download'), str(gameId, 'game')))
  handle('downloads:clear', () => downloads.clearDownloads())
}
