import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcInvokeMap, InvokeChannel } from '@shared/ipc'
import type { AccountId, ModSort, Settings } from '@shared/types'
import { getSettings, setSettings } from './store'
import { logFilePath, scoped, setLogLevel } from './logger'
import { run } from './util/exec'
import { paths } from './paths'
import * as library from './library/library'
import * as mods from './mods/manager'
import * as profiles from './mods/profiles'
import * as sources from './sources/registry'
import * as downloads from './downloads/manager'
import * as panel from './web/panel'
import * as accounts from './accounts/accounts'
import * as detect from './mods/detect'
import * as updates from './mods/updates'
import * as setup from './integrations/orchestrator'
import * as diagnostics from './diagnostics/diagnostics'
import * as bugreport from './bugreport/bugreport'
import * as updater from './updater/updater'
import { forgetIntegration } from './integrations/registry'
import { applyUiScale } from './window'

const log = scoped('ipc')

const SORTS: ModSort[] = ['relevance', 'endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated']
const modSort = (v: unknown): ModSort | undefined => (SORTS.includes(v as ModSort) ? (v as ModSort) : undefined)

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
      'accent', 'reduceMotion', 'minimizeOnLaunch', 'autoFetchArtwork', 'scanPlatforms', 'customFolders', 'scanAllDrives', 'scanOnStartup', 'modStorageDir',
      'defaultStrategy', 'autoDeploy', 'dependencyMode', 'steamcmdPath', 'logLevel', 'sources', 'firstRunComplete', 'uiScale', 'checkUpdatesOnStartup'
    ]
    const clean: Partial<Settings> = {}
    for (const k of allowed) if (patch && k in patch) (clean as Record<string, unknown>)[k] = patch[k]
    const next = setSettings(clean)
    if (clean.logLevel) setLogLevel(clean.logLevel)
    if (clean.uiScale !== undefined) applyUiScale()
    if (clean.sources) await sources.reloadSources()
    return next
  })

  handle('library:list', () => library.listGames())
  handle('library:scan', async () => {
    const result = await library.scanLibrary()
    void detect.rescanGames().catch(() => {})
    return result
  })
  handle('library:addManual', (_e, input) => library.addManualGame(input))
  handle('library:update', (_e, id, patch) => {
    const game = library.updateGame(str(id, 'game'), patch ?? {})
    // A new executable, name or deploy folder can change which integration applies and where things go.
    forgetIntegration(id)
    mods.forgetInspection(id)
    return game
  })
  handle('library:remove', async (_e, id) => {
    await mods.forgetGameMods(str(id, 'game'))
    library.removeGameRecord(id)
  })
  handle('library:launch', async (_e, id, variant) => {
    const gameId = str(id, 'game')
    const v = variant === 'vanilla' || variant === 'modded' ? variant : undefined
    const override = v ? await setup.launchSpecFor(gameId, v) : undefined
    const started = Date.now()
    // Once the game is closed (and shortly after start), read the mod loader's log to show what it loaded.
    const check = () => void setup.checkLastLaunch(gameId, started).catch(() => {})
    await library.launchGame(gameId, override ? { ...override, label: v } : undefined, check)
    setTimeout(check, 45_000)
  })
  handle('library:running', () => library.runningGames())
  handle('library:fetchArtwork', (_e, id) => library.refetchArtwork(str(id, 'game')))
  handle('library:detectExecutables', (_e, dir) => library.detectExecutables(str(dir, 'folder')))
  handle('library:driveRoots', () => library.driveGameRoots())

  handle('mods:list', (_e, gameId) => mods.listMods(str(gameId, 'game')))
  handle('mods:installFiles', async (_e, gameId, files) => {
    const out = []
    for (const f of files ?? []) out.push(await mods.installMod(str(gameId, 'game'), str(f, 'file')))
    return out
  })
  handle('mods:remove', async (_e, gameId, modId) => {
    await mods.removeMod(str(gameId, 'game'), str(modId, 'mod'))
    updates.invalidateUpdates(gameId, modId)
  })
  handle('mods:checkUpdates', (_e, gameId, force) => updates.checkUpdates(str(gameId, 'game'), Boolean(force)))
  handle('mods:update', (_e, gameId, modId, patch) => mods.updateMod(str(gameId, 'game'), str(modId, 'mod'), patch ?? {}))
  handle('mods:files', (_e, gameId, modId) => mods.listModFiles(str(gameId, 'game'), str(modId, 'mod')))
  handle('mods:rootCandidates', (_e, gameId, modId) => mods.rootCandidates(str(gameId, 'game'), str(modId, 'mod')))
  handle('mods:openFolder', (_e, gameId, modId) => mods.openModFolder(str(gameId, 'game'), modId))
  handle('mods:detected', (_e, gameId) => detect.detectedFor(str(gameId, 'game')))
  handle('mods:detectedAll', () => detect.allDetected())
  handle('mods:rescanInstalled', (_e, gameId) => (gameId ? detect.rescanGames([str(gameId, 'game')]) : detect.rescanGames()))

  handle('profiles:list', (_e, gameId) => profiles.listProfiles(str(gameId, 'game')))
  handle('profiles:create', (_e, gameId, name, cloneFrom) => profiles.createProfile(str(gameId, 'game'), String(name ?? ''), cloneFrom))
  handle('profiles:rename', (_e, gameId, profileId, name) => profiles.renameProfile(str(gameId, 'game'), str(profileId, 'profile'), String(name ?? '')))
  handle('profiles:delete', (_e, gameId, profileId) => profiles.deleteProfile(str(gameId, 'game'), str(profileId, 'profile')))
  handle('profiles:setActive', (_e, gameId, profileId) => profiles.setActiveProfile(str(gameId, 'game'), str(profileId, 'profile')))
  handle('profiles:save', (_e, profile) => {
    if (!profile || typeof profile !== 'object' || !Array.isArray(profile.order) || !Array.isArray(profile.enabled)) throw new Error('Invalid profile')
    return profiles.saveProfile(profile)
  })

  // What's in the game folder changed: refresh its installed-mod scan afterwards.
  const rescanAfter = async <T>(gameId: string, work: Promise<T>): Promise<T> => {
    const result = await work
    void detect.rescanGames([gameId]).catch(() => {})
    return result
  }
  handle('deploy:run', (_e, gameId) => rescanAfter(str(gameId, 'game'), mods.deployGame(gameId)))
  handle('deploy:setup', (_e, gameId) => rescanAfter(str(gameId, 'game'), setup.setupAndDeploy(gameId, { quiet: true })))
  handle('deploy:cancel', (_e, gameId) => mods.cancelDeploy(str(gameId, 'game')))
  handle('deploy:purge', (_e, gameId) => rescanAfter(str(gameId, 'game'), mods.purgeGame(gameId)))
  handle('deploy:status', (_e, gameId) => mods.deployStatus(str(gameId, 'game')))
  handle('deploy:probe', (_e, gameId) => mods.probeGame(str(gameId, 'game')))
  handle('conflicts:get', (_e, gameId) => mods.getConflicts(str(gameId, 'game')))

  handle('integration:inspect', (_e, gameId, fresh) => mods.integrationInfo(str(gameId, 'game'), Boolean(fresh)))
  handle('integration:installLoader', (_e, gameId, loaderId) => rescanAfter(str(gameId, 'game'), setup.installLoader(gameId, str(loaderId, 'loader'))))
  handle('integration:removeLoader', async (_e, gameId, loaderId) => {
    await rescanAfter(str(gameId, 'game'), setup.removeLoader(gameId, str(loaderId, 'loader')))
    return mods.integrationInfo(gameId, true)
  })
  handle('integration:operation', (_e, gameId) => setup.setupState(str(gameId, 'game')))
  handle('integration:lastLaunch', (_e, gameId) => setup.lastLaunch(str(gameId, 'game')))
  handle('integration:shortcut', (_e, gameId, variant, where) =>
    setup.createShortcut(str(gameId, 'game'), variant === 'vanilla' ? 'vanilla' : 'modded', where === 'desktop' ? 'desktop' : 'startmenu')
  )
  handle('integration:shortcuts', (_e, gameId) => setup.listShortcuts(str(gameId, 'game')))

  handle('diagnostics:run', (_e, gameId) => diagnostics.runDiagnostics(str(gameId, 'game')))
  handle('diagnostics:fix', (_e, gameId, fixId, params) => {
    // Only string parameters (mod id, loader id, folder) reach the repair; it checks each against the game.
    const p: Record<string, string> = {}
    if (params && typeof params === 'object') for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v.length < 1024) p[k] = v
    return rescanAfter(str(gameId, 'game'), diagnostics.applyFix(gameId, str(fixId, 'repair'), p))
  })
  handle('diagnostics:export', (e, gameId) => diagnostics.exportDiagnostics(str(gameId, 'game'), win(e)))

  handle('bugreport:state', () => bugreport.bugReportState())
  handle('bugreport:capture', (e) => bugreport.captureWindow(win(e)))
  handle('bugreport:preview', (_e, input) => bugreport.previewReport(input))
  handle('bugreport:submit', (_e, input, target) => {
    if (target !== 'panel' && target !== 'browser' && target !== 'save') throw new Error('Invalid target')
    return bugreport.submitReport(input, target)
  })
  handle('bugreport:rendererError', (_e, error) => bugreport.rendererError(error))
  handle('bugreport:openFolder', (_e, dir) => bugreport.openReportsFolder(typeof dir === 'string' && dir ? dir : undefined))
  handle('bugreport:dismissCrash', () => bugreport.dismissCrash())
  handle('bugreport:githubSignIn', () => bugreport.githubSignIn())

  handle('updater:state', () => updater.updateStatus())
  handle('updater:check', () => updater.checkForUpdates())
  handle('updater:install', () => updater.installUpdate())

  handle('sources:list', () => sources.listSources())
  handle('sources:search', (_e, id, q, gameId) => sources.searchSource(str(id, 'source'), String(q ?? ''), gameId || undefined))
  handle('sources:query', (_e, id, q, gameId, opts) =>
    sources.querySource(str(id, 'source'), String(q ?? ''), gameId || undefined, {
      sort: modSort(opts?.sort),
      page: Number.isInteger(opts?.page) && opts!.page! >= 0 && opts!.page! < 200 ? opts!.page : undefined
    })
  )
  handle('sources:details', (_e, id, modId, gameId) => sources.sourceDetails(str(id, 'source'), str(modId, 'mod'), gameId || undefined))
  handle('sources:bindings', (_e, id, gameId) => sources.sourceBindings(str(id, 'source'), str(gameId, 'game')))
  handle('sources:dependencies', (_e, id, modId, versionId, gameId) => sources.resolveDependencies(str(id, 'source'), str(modId, 'mod'), versionId || undefined, gameId || undefined))
  handle('sources:latestVersion', (_e, id, modId, gameId) => sources.latestVersionId(str(id, 'source'), str(modId, 'mod'), gameId || undefined))
  handle('sources:openPage',(_e, id, modId, gameId) => sources.openSourcePage(str(id, 'source'), str(modId, 'mod'), gameId || undefined))
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
  handle('downloads:focus', (_e, id) => downloads.focusDownload(str(id, 'download')))
  handle('downloads:retry', (_e, id) => downloads.retryDownload(str(id, 'download')))
  handle('downloads:install', (_e, id, gameId) => downloads.installDownload(str(id, 'download'), str(gameId, 'game')))
  handle('downloads:remove', (_e, id) => downloads.removeDownload(str(id, 'download')))
  handle('downloads:clear', () => downloads.clearDownloads())

  const accountId = (v: unknown): AccountId => {
    if (v !== 'nexus' && v !== 'modio' && v !== 'curseforge' && v !== 'steam') throw new Error('Unknown account')
    return v
  }
  handle('accounts:list', () => accounts.listAccounts())
  handle('accounts:signIn', async (_e, id, register) => {
    const info = await accounts.signIn(accountId(id), Boolean(register))
    await sources.reloadSources()
    return info
  })
  handle('accounts:signOut', async (_e, id) => {
    const list = await accounts.signOut(accountId(id))
    await sources.reloadSources()
    return list
  })
  handle('accounts:saveKey', async (_e, id, key) => {
    const info = await accounts.saveAccountKey(accountId(id), String(key ?? ''))
    await sources.reloadSources()
    return info
  })
  handle('accounts:browserKey', async (_e, id) => {
    const info = await accounts.browserKeySignIn(accountId(id))
    await sources.reloadSources()
    return info
  })
  handle('accounts:cancelBrowserKey', (_e, id) => accounts.cancelBrowserKeySignIn(accountId(id)))
  handle('accounts:steamLogin', (e, req) =>
    accounts.signInSteam(
      { user: String(req?.user ?? ''), password: String(req?.password ?? ''), code: req?.code ? String(req.code) : undefined },
      (s) => e.sender.send('accounts:steamStatus', s)
    )
  )

  handle('sitepanel:state', () => panel.panelState())
  handle('sitepanel:bounds', (e, r) => {
    if (!r || ![r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error('Invalid bounds')
    // The renderer measures in CSS pixels; with a changed interface size those differ from window pixels.
    const z = e.sender.getZoomFactor() || 1
    panel.setPanelBounds({ x: r.x * z, y: r.y * z, width: r.width * z, height: r.height * z })
  })
  handle('sitepanel:show', (_e, id) => downloads.focusDownload(str(id, 'download')))
  handle('sitepanel:hide', () => panel.hidePanel())
  handle('sitepanel:navigate', (_e, action) => panel.panelNavigate(action === 'back' ? 'back' : 'reload'))
  handle('sitepanel:cancel', () => panel.cancelShownPanel())
  handle('sitepanel:external', () => panel.openShownExternally())
}
