import type {
  AccountId,
  AccountInfo,
  AppInfo,
  ConflictReport,
  DeployProgress,
  DeployReport,
  DeployStatus,
  DownloadItem,
  DownloadRequest,
  FeedConfig,
  Game,
  GameModInfo,
  InstalledMod,
  LinkCapabilities,
  ManualGameInput,
  ModDetails,
  ModFileEntry,
  ModSearchOptions,
  ModSearchResponse,
  ModSearchResult,
  PluginInfo,
  Profile,
  ResolvedDependency,
  ScanProgress,
  ScanResult,
  Settings,
  SitePanelState,
  SourceGameBinding,
  SourceInfo,
  SteamLoginRequest,
  SteamLoginResponse,
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
  'library:driveRoots': () => string[]

  'mods:list': (gameId: string) => InstalledMod[]
  'mods:installFiles': (gameId: string, paths: string[]) => InstalledMod[]
  'mods:remove': (gameId: string, modId: string) => void
  'mods:update': (gameId: string, modId: string, patch: Partial<Pick<InstalledMod, 'name' | 'version' | 'rootPath'>>) => InstalledMod
  'mods:files': (gameId: string, modId: string) => ModFileEntry[]
  'mods:rootCandidates': (gameId: string, modId: string) => string[]
  'mods:openFolder': (gameId: string, modId?: string) => void
  /** Mods found in the game's folders (from the last scan; scans now when there is none yet). */
  'mods:detected': (gameId: string) => GameModInfo
  /** Every game's last mod scan, for library badges. */
  'mods:detectedAll': () => Record<string, GameModInfo>
  /** Scans one game (or all) for installed mods again. */
  'mods:rescanInstalled': (gameId?: string) => Record<string, GameModInfo>

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
  /** Search with a sort order; says when the order had to be approximated. */
  'sources:query': (sourceId: string, query: string, gameId?: string, opts?: ModSearchOptions) => ModSearchResponse
  'sources:details': (sourceId: string, modId: string, gameId?: string) => ModDetails
  'sources:bindings': (sourceId: string, gameId: string) => SourceGameBinding[]
  'sources:dependencies': (sourceId: string, modId: string, versionId: string | undefined, gameId?: string) => ResolvedDependency[]
  'sources:latestVersion': (sourceId: string, modId: string, gameId?: string) => string
  'sources:openPage': (sourceId: string, modId: string, gameId?: string) => void
  'sources:setFeeds': (feeds: FeedConfig[]) => SourceInfo[]
  'sources:plugins': () => PluginInfo[]
  'sources:trustPlugin': (pluginId: string, trusted: boolean) => PluginInfo[]
  'sources:reload': () => SourceInfo[]
  'sources:openPluginsFolder': () => void

  'downloads:list': () => DownloadItem[]
  'downloads:start': (req: DownloadRequest) => DownloadItem
  'downloads:cancel': (id: string) => void
  'downloads:focus': (id: string) => void
  'downloads:retry': (id: string) => DownloadItem
  'downloads:install': (id: string, gameId: string) => DownloadItem
  'downloads:clear': () => DownloadItem[]

  'accounts:list': () => AccountInfo[]
  'accounts:signIn': (id: AccountId, register?: boolean) => AccountInfo
  'accounts:signOut': (id: AccountId) => AccountInfo[]
  'accounts:saveKey': (id: AccountId, key: string) => AccountInfo
  /** Opens the site's API key page in the user's own browser and picks the key up from the clipboard. */
  'accounts:browserKey': (id: AccountId) => AccountInfo
  'accounts:cancelBrowserKey': (id: AccountId) => void
  'accounts:steamLogin': (req: SteamLoginRequest) => SteamLoginResponse

  'sitepanel:state': () => SitePanelState
  'sitepanel:bounds': (rect: { x: number; y: number; width: number; height: number }) => void
  'sitepanel:show': (id: string) => void
  'sitepanel:hide': () => void
  'sitepanel:navigate': (action: 'back' | 'reload') => void
  'sitepanel:cancel': () => void
  /** Opens the page shown in the panel in the user's own browser. */
  'sitepanel:external': () => void
}

/** Events pushed from main to renderer. */
export interface IpcEventMap {
  'window:maximized': boolean
  'library:changed': Game[]
  'library:running': string[]
  'scan:progress': ScanProgress
  'deploy:progress': DeployProgress
  'mods:changed': { gameId: string }
  /** A game's installed-mod scan finished. */
  'mods:detected': GameModInfo
  'downloads:update': DownloadItem
  'sitepanel:state': SitePanelState
  'accounts:changed': AccountInfo[]
  /** Progress of a Steam sign-in ("Confirm the sign-in in the Steam app…"). */
  'accounts:steamStatus': string
  'toast': Omit<Toast, 'id'>
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

export const INVOKE_CHANNELS = [
  'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized',
  'app:info', 'app:openPath', 'app:showItem', 'app:openExternal', 'app:openLogs', 'app:pickFile', 'app:pickFiles', 'app:pickFolder',
  'settings:get', 'settings:set',
  'library:list', 'library:scan', 'library:addManual', 'library:update', 'library:remove', 'library:launch', 'library:running',
  'library:fetchArtwork', 'library:detectExecutables', 'library:driveRoots',
  'mods:list', 'mods:installFiles', 'mods:remove', 'mods:update', 'mods:files', 'mods:rootCandidates', 'mods:openFolder',
  'mods:detected', 'mods:detectedAll', 'mods:rescanInstalled',
  'profiles:list', 'profiles:create', 'profiles:rename', 'profiles:delete', 'profiles:setActive', 'profiles:save',
  'deploy:run', 'deploy:purge', 'deploy:status', 'deploy:probe', 'conflicts:get',
  'sources:list', 'sources:search', 'sources:query', 'sources:details', 'sources:bindings', 'sources:dependencies', 'sources:latestVersion', 'sources:openPage',
  'sources:setFeeds', 'sources:plugins', 'sources:trustPlugin', 'sources:reload', 'sources:openPluginsFolder',
  'downloads:list', 'downloads:start', 'downloads:cancel', 'downloads:focus', 'downloads:retry', 'downloads:install', 'downloads:clear',
  'accounts:list', 'accounts:signIn', 'accounts:signOut', 'accounts:saveKey', 'accounts:browserKey', 'accounts:cancelBrowserKey', 'accounts:steamLogin',
  'sitepanel:state', 'sitepanel:bounds', 'sitepanel:show', 'sitepanel:hide', 'sitepanel:navigate', 'sitepanel:cancel', 'sitepanel:external'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'window:maximized', 'library:changed', 'library:running', 'scan:progress', 'deploy:progress', 'mods:changed', 'mods:detected', 'downloads:update', 'sitepanel:state',
  'accounts:changed', 'accounts:steamStatus', 'toast'
] as const satisfies readonly EventChannel[]

type Async<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never

/** The API exposed on `window.nexus` by the preload script. */
export interface NexusApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<IpcInvokeMap[C]>): ReturnType<Async<IpcInvokeMap[C]>>
  on<E extends EventChannel>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void
  /** Resolves the absolute path of a File dropped onto the window. */
  pathForFile(file: File): string
}
