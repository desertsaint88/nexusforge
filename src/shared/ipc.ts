import type {
  AppInfo,
  ConflictReport,
  DeployProgress,
  DeployReport,
  DeployStatus,
  DownloadItem,
  DownloadRequest,
  FeedConfig,
  Game,
  InstalledMod,
  LinkCapabilities,
  ManualGameInput,
  ModDetails,
  ModFileEntry,
  ModSearchResult,
  PluginInfo,
  Profile,
  ScanProgress,
  ScanResult,
  Settings,
  SourceGameBinding,
  SourceInfo,
  Toast
} from './types'

/** Every invokable channel: name -> handler signature (as seen by the renderer). */
export interface IpcInvokeMap {
  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  'window:isMaximized': () => boolean

  'app:info': () => AppInfo
  'app:openPath': (path: string) => string
  'app:showItem': (path: string) => void
  'app:openExternal': (url: string) => void
  'app:openLogs': () => void
  'app:pickFile': (opts: { title?: string; filters?: { name: string; extensions: string[] }[] }) => string | null
  'app:pickFiles': (opts: { title?: string; filters?: { name: string; extensions: string[] }[] }) => string[]
  'app:pickFolder': (opts: { title?: string; defaultPath?: string }) => string | null

  'settings:get': () => Settings
  'settings:set': (patch: Partial<Settings>) => Settings

  'library:list': () => Game[]
  'library:scan': () => ScanResult
  'library:addManual': (input: ManualGameInput) => Game
  'library:update': (id: string, patch: Partial<Pick<Game, 'name' | 'exePath' | 'launchArgs' | 'favorite' | 'hidden' | 'customArt' | 'modding'>>) => Game
  'library:remove': (id: string) => void
  'library:launch': (id: string) => void
  'library:running': () => string[]
  'library:fetchArtwork': (id: string) => Game
  'library:detectExecutables': (dir: string) => string[]

  'mods:list': (gameId: string) => InstalledMod[]
  'mods:installFiles': (gameId: string, paths: string[]) => InstalledMod[]
  'mods:remove': (gameId: string, modId: string) => void
  'mods:update': (gameId: string, modId: string, patch: Partial<Pick<InstalledMod, 'name' | 'version' | 'rootPath'>>) => InstalledMod
  'mods:files': (gameId: string, modId: string) => ModFileEntry[]
  'mods:rootCandidates': (gameId: string, modId: string) => string[]
  'mods:openFolder': (gameId: string, modId?: string) => void

  'profiles:list': (gameId: string) => { profiles: Profile[]; activeId: string }
  'profiles:create': (gameId: string, name: string, cloneFrom?: string) => Profile
  'profiles:rename': (gameId: string, profileId: string, name: string) => Profile
  'profiles:delete': (gameId: string, profileId: string) => void
  'profiles:setActive': (gameId: string, profileId: string) => void
  'profiles:save': (profile: Profile) => Profile

  'deploy:run': (gameId: string) => DeployReport
  'deploy:purge': (gameId: string) => DeployReport
  'deploy:status': (gameId: string) => DeployStatus
  'deploy:probe': (gameId: string) => LinkCapabilities
  'conflicts:get': (gameId: string) => ConflictReport

  'sources:list': () => SourceInfo[]
  'sources:search': (sourceId: string, query: string, gameId?: string) => ModSearchResult[]
  'sources:details': (sourceId: string, modId: string, gameId?: string) => ModDetails
  'sources:bindings': (sourceId: string, gameId: string) => SourceGameBinding[]
  'sources:openPage': (sourceId: string, modId: string, gameId?: string) => void
  'sources:setFeeds': (feeds: FeedConfig[]) => SourceInfo[]
  'sources:plugins': () => PluginInfo[]
  'sources:trustPlugin': (pluginId: string, trusted: boolean) => PluginInfo[]
  'sources:reload': () => SourceInfo[]
  'sources:openPluginsFolder': () => void

  'downloads:list': () => DownloadItem[]
  'downloads:start': (req: DownloadRequest) => DownloadItem
  'downloads:cancel': (id: string) => void
  'downloads:retry': (id: string) => DownloadItem
  'downloads:install': (id: string, gameId: string) => DownloadItem
  'downloads:clear': () => DownloadItem[]
}

/** Events pushed from main to renderer. */
export interface IpcEventMap {
  'window:maximized': boolean
  'library:changed': Game[]
  'library:running': string[]
  'scan:progress': ScanProgress
  'deploy:progress': DeployProgress
  'mods:changed': { gameId: string }
  'downloads:update': DownloadItem
  'toast': Omit<Toast, 'id'>
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

export const INVOKE_CHANNELS = [
  'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized',
  'app:info', 'app:openPath', 'app:showItem', 'app:openExternal', 'app:openLogs', 'app:pickFile', 'app:pickFiles', 'app:pickFolder',
  'settings:get', 'settings:set',
  'library:list', 'library:scan', 'library:addManual', 'library:update', 'library:remove', 'library:launch', 'library:running',
  'library:fetchArtwork', 'library:detectExecutables',
  'mods:list', 'mods:installFiles', 'mods:remove', 'mods:update', 'mods:files', 'mods:rootCandidates', 'mods:openFolder',
  'profiles:list', 'profiles:create', 'profiles:rename', 'profiles:delete', 'profiles:setActive', 'profiles:save',
  'deploy:run', 'deploy:purge', 'deploy:status', 'deploy:probe', 'conflicts:get',
  'sources:list', 'sources:search', 'sources:details', 'sources:bindings', 'sources:openPage', 'sources:setFeeds', 'sources:plugins',
  'sources:trustPlugin', 'sources:reload', 'sources:openPluginsFolder',
  'downloads:list', 'downloads:start', 'downloads:cancel', 'downloads:retry', 'downloads:install', 'downloads:clear'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'window:maximized', 'library:changed', 'library:running', 'scan:progress', 'deploy:progress', 'mods:changed', 'downloads:update', 'toast'
] as const satisfies readonly EventChannel[]

type Async<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never

/** The API exposed on `window.nexus` by the preload script. */
export interface NexusApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<IpcInvokeMap[C]>): ReturnType<Async<IpcInvokeMap[C]>>
  on<E extends EventChannel>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void
  /** Resolves the absolute path of a File dropped onto the window. */
  pathForFile(file: File): string
}
