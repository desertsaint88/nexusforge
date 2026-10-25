// Types shared by the main process, the preload bridge and the renderer.

export type Platform = 'steam' | 'epic' | 'xbox' | 'gog' | 'custom' | 'manual'

export type DeployStrategy = 'symlink' | 'hardlink' | 'copy'
export type DeployMethod = DeployStrategy

export type LaunchSpec =
  | { kind: 'url'; url: string }
  | { kind: 'exe'; exe: string; args?: string[]; cwd?: string }
  | { kind: 'appx'; aumid: string }

export interface GameArt {
  /** Portrait capsule (2:3). Ordered fallbacks: local cache first, then CDN. */
  capsule: string[]
  /** Wide hero/background image. */
  hero: string[]
  /** Landscape header (460x215). */
  header: string[]
  logo: string[]
  /** Small square icon (exe icon or store logo). */
  icon?: string
}

export interface GameModding {
  /** Absolute folder that mods are deployed into. */
  targetDir: string
  strategy: DeployStrategy
  /** Per-source bindings, e.g. { thunderstore: 'valheim', nexus: 'skyrimspecialedition' } */
  sources: Record<string, string>
}

export interface Game {
  id: string
  name: string
  platform: Platform
  platformId?: string
  installDir: string
  exePath?: string
  launch: LaunchSpec
  launchArgs?: string
  art: GameArt
  customArt?: { capsule?: string; hero?: string }
  playtimeMinutes: number
  lastPlayed?: number
  sizeBytes?: number
  /** Version read from the game executable (or Steam build id). */
  version?: string
  /** Console game started through this emulator (exePath is the emulator). */
  emulator?: string
  addedAt: number
  favorite?: boolean
  hidden?: boolean
  missing?: boolean
  modding: GameModding
  /** Fields the user edited; scans won't overwrite them. */
  userEdited?: Array<'name' | 'exePath' | 'launch' | 'art'>
  /** Version of the artwork lookup that last checked this game's pictures (newer lookups re-check once). */
  artRev?: number
  /** Official title from the store match ("Hell Let Loose: Vietnam" for a folder called "Hell.Let.Loose.Vietnam"). */
  storeName?: string
}

export interface DetectedGame {
  id: string
  name: string
  platform: Platform
  platformId?: string
  installDir: string
  exePath?: string
  launch: LaunchSpec
  art: GameArt
  playtimeMinutes?: number
  lastPlayed?: number
  sizeBytes?: number
  emulator?: string
}

export interface ScanProgress {
  platform: Platform
  status: 'scanning' | 'done' | 'error' | 'skipped'
  found: number
  message?: string
}

export interface ScanResult {
  added: number
  updated: number
  missing: number
  total: number
  perPlatform: ScanProgress[]
  durationMs: number
}

export interface ManualGameInput {
  name: string
  /** Either an .exe file or a game root directory. */
  path: string
  args?: string
}

// ---------------------------------------------------------------------------
// Mods

export interface ModSourceRef {
  sourceId: string
  modId: string
  versionId?: string
  url?: string
  name?: string
}

export interface InstalledMod {
  id: string
  gameId: string
  name: string
  version?: string
  author?: string
  summary?: string
  thumbnail?: string
  source?: ModSourceRef
  /** Folder inside the staging area that holds this mod's files. */
  stagingDir: string
  /** Sub-path inside stagingDir that maps to the game's deploy target. */
  rootPath: string
  installedAt: number
  updatedAt: number
  sizeBytes: number
  fileCount: number
  originalFile?: string
  /** Mods this one needs (source refs), used for load order and missing-dependency warnings. */
  requires?: ModSourceRef[]
}

export interface Profile {
  id: string
  gameId: string
  name: string
  /** Mod ids in load order. Later entries win file conflicts. */
  order: string[]
  enabled: string[]
  /** relKey -> modId that should provide that file regardless of order. */
  fileOverrides: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface ModFileEntry {
  rel: string
  size: number
}

/** How a mod found on disk was put there and recognized. */
export type DetectedModKind =
  | 'bepinex'
  | 'melonloader'
  | 'ue4ss'
  | 'pak'
  | 'gmod-addon'
  | 'beamng'
  | 'workshop'
  | 'modio'
  | 'plugin'
  | 'script'
  | 'scenery'
  | 'aircraft'
  | 'contraption'
  | 'bo3'
  | 'jar'
  | 'loader'
  | 'folder'

/** A mod that is installed in a game, whether NexusForge put it there or not. */
export interface DetectedMod {
  /** Stable key (kind + relative path). */
  key: string
  name: string
  kind: DetectedModKind
  /** File or folder of the mod. */
  path: string
  version?: string
  author?: string
  /** False when the game has it switched off (BeamNG db.json, UE4SS mods.txt, .disabled files). */
  enabled?: boolean
  /** Where it came from, when its files say so (Workshop id, mod.io id, BeamNG resource, Thunderstore package). */
  source?: { sourceId: string; modId: string }
  /** What identified it: "manifest.json", "GMA header", "db.json", "file version", "folder layout". */
  detectedBy: string
  /** Deployed by NexusForge: the id of the installed mod it belongs to. */
  managedModId?: string
  sizeBytes?: number
}

/** What NexusForge knows about modding a game: support, frameworks and every mod installed. */
export interface GameModInfo {
  gameId: string
  scannedAt: number
  /** The game can be modded (known preset, mod loader present, engine with mod support, or mods found). */
  supported: boolean
  /** Short reasons, e.g. "BepInEx installed", "Unreal Engine (.pak mods)", "Steam Workshop". */
  support: string[]
  engine?: 'unity' | 'unreal' | 'source' | 'beamng' | 'bethesda' | 'other'
  mods: DetectedMod[]
}

export interface ConflictFile {
  key: string
  rel: string
  /** Providers in load-order (lowest priority first). */
  providers: string[]
  winner: string
  overridden: boolean
}

export interface ConflictGroup {
  /** Mod ids involved, sorted by load order. */
  mods: string[]
  files: ConflictFile[]
}

export interface ConflictReport {
  gameId: string
  profileId: string
  totalFiles: number
  groups: ConflictGroup[]
  /** modId -> { wins, loses } */
  perMod: Record<string, { wins: number; loses: number }>
}

export interface DeployManifestEntry {
  rel: string
  modId: string
  source: string
  method: DeployMethod
  /** Original game file moved aside before deploying over it. */
  backup?: string
  size: number
  mtimeMs: number
  /** File id of a hardlink (bigint as string). */
  ino?: string
  /** Source file mtime at deploy time; a changed source means a copy is stale. */
  srcMtimeMs?: number
}

export interface DeployManifest {
  version: 1
  gameId: string
  profileId: string
  targetDir: string
  strategy: DeployStrategy
  deployedAt: number
  planHash: string
  entries: DeployManifestEntry[]
  createdDirs: string[]
}

export interface DeployStatus {
  gameId: string
  deployed: boolean
  inSync: boolean
  fileCount: number
  methods: Record<DeployMethod, number>
  deployedAt?: number
  profileId?: string
}

export interface DeployProgress {
  gameId: string
  phase: 'planning' | 'removing' | 'linking' | 'finishing'
  done: number
  total: number
}

export interface DeployReport {
  gameId: string
  placed: number
  removed: number
  unchanged: number
  backedUp: number
  /** Files the game/user modified after deployment; moved to the overwrite folder instead of being deleted. */
  rescued: number
  methods: Record<DeployMethod, number>
  fallbacks: string[]
  errors: string[]
  durationMs: number
}

export interface LinkCapabilities {
  symlink: boolean
  hardlink: boolean
  symlinkReason?: string
  hardlinkReason?: string
}

// ---------------------------------------------------------------------------
// Mod sources

export interface ModSearchResult {
  id: string
  sourceId: string
  name: string
  summary: string
  author?: string
  thumbnail?: string
  downloads?: number
  endorsements?: number
  updatedAt?: string
  /** When the mod was first published. */
  createdAt?: string
  version?: string
  url?: string
}

/**
 * Orders for mod lists. Sources sort on their side where they can; the rest is sorted from the results.
 * downloads_recent: most downloaded among mods updated in the last 30 days.
 * trending: what the source calls trending/hot, else the best-rated mods of the last two weeks.
 */
export type ModSort = 'relevance' | 'endorsed' | 'downloads' | 'downloads_recent' | 'trending' | 'newest' | 'updated'

export interface ModSearchOptions {
  sort?: ModSort
}

export interface ModSearchResponse {
  results: ModSearchResult[]
  sort: ModSort
  /** The source can't order by this itself; NexusForge sorted the results it got. */
  approximate?: boolean
}

/** Another mod (or external tool) a mod needs. */
export interface ModDependency {
  /** Source to install it from; empty for external requirements (script extenders, DLC, websites). */
  sourceId: string
  modId?: string
  /** Specific version, when the source pins one. */
  versionId?: string
  name: string
  required: boolean
  /** NexusForge can download and install it by itself. */
  installable: boolean
  url?: string
  note?: string
}

export interface ResolvedDependency extends ModDependency {
  /** Already installed for this game. */
  installed: boolean
  /** Installed but disabled in the active profile. */
  disabled?: boolean
  /** Name of the mod that pulled this one in (for nested dependencies). */
  requiredBy: string
}

export interface ModVersion {
  id: string
  name: string
  version?: string
  fileName?: string
  sizeBytes?: number
  date?: string
  primary?: boolean
  /** Download needs an interactive step (e.g. a click on the website); NexusForge opens its own window for it. */
  manualOnly?: boolean
  /** Game versions this file is made for, as the source states them. */
  gameVersions?: string[]
  loaders?: string[]
  dependencies?: ModDependency[]
  /** File notes / changelog (often says which game version is needed). */
  description?: string
}

export interface ModDetails extends ModSearchResult {
  description: string
  images: string[]
  versions: ModVersion[]
  tags?: string[]
  /** Requirements of the mod as a whole (Nexus lists them per mod, not per file). */
  requirements?: ModDependency[]
  gameVersions?: string[]
}

export interface SourceGameBinding {
  /** Identifier the source uses for this game (community slug, game domain, ...). */
  value: string
  label: string
}

export interface SourceInfo {
  id: string
  name: string
  description: string
  kind: 'builtin' | 'feed' | 'plugin'
  enabled: boolean
  apiKey?: 'optional' | 'required'
  hasKey?: boolean
  /** Where the user gets a key. */
  apiKeyUrl?: string
  homepage?: string
  /** Placeholder text for the per-game binding field (e.g. "Thunderstore community"). */
  bindingLabel?: string
  /** Orders the source can produce itself (others are approximated from the results). */
  sorts?: ModSort[]
  error?: string
}

export interface FeedConfig {
  id: string
  name: string
  url: string
  enabled: boolean
}

export interface PluginInfo {
  id: string
  dir: string
  name: string
  version?: string
  trusted: boolean
  changed: boolean
  loaded: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Downloads

export type DownloadState = 'queued' | 'waiting' | 'downloading' | 'installing' | 'completed' | 'failed' | 'cancelled'

export interface DownloadItem {
  id: string
  name: string
  fileName: string
  url: string
  sourceId?: string
  modRef?: ModSourceRef
  gameId?: string
  state: DownloadState
  received: number
  total: number
  speed: number
  startedAt: number
  finishedAt?: number
  filePath?: string
  installedModId?: string
  error?: string
  thumbnail?: string
  /** Shown while state is 'waiting' (e.g. "Click Slow download in the Nexus window"). */
  hint?: string
  /** Web page the download comes from, for downloads that need a click on the site. */
  pageUrl?: string
}

/** The in-app site panel (Nexus download page, bot checks). */
export interface SitePanelState {
  open: boolean
  /** Download (or page) id shown right now. */
  id?: string
  title: string
  /** What the user has to do on the page. */
  hint: string
  url: string
  loading: boolean
  canGoBack: boolean
  /** Every page that is waiting, shown or not. */
  waiting: Array<{ id: string; title: string }>
  /** The site's bot check (Cloudflare) refused this window even after a retry. */
  blocked?: boolean
}

export interface DownloadRequest {
  sourceId: string
  modId: string
  versionId: string
  gameId?: string
  name?: string
  version?: string
  author?: string
  summary?: string
  thumbnail?: string
  /** Source refs of the mods this one needs, so it is ordered after them. */
  requires?: ModSourceRef[]
}

// ---------------------------------------------------------------------------
// Accounts

export type AccountId = 'nexus' | 'modio' | 'curseforge' | 'steam'

export interface AccountInfo {
  id: AccountId
  name: string
  /** What signing in unlocks. */
  unlocks: string
  signedIn: boolean
  /** User name on the site. */
  user?: string
  avatar?: string
  /** "Premium", "Free account", … */
  detail?: string
  /** A sign-in page is open in the site panel right now. */
  busy?: boolean
  /** Sign-in happens in the site panel (false: NexusForge asks for the login itself, e.g. Steam). */
  web: boolean
  registerUrl?: string
  /** The source needs this account for anything at all (not just downloads). */
  required: boolean
}

export interface SteamLoginRequest {
  user: string
  password: string
  /** Steam Guard code (e-mail or Steam app), when Steam asked for one. */
  code?: string
}

export type SteamLoginResponse = { ok: true; account: AccountInfo } | { ok: false; needCode?: 'email' | 'app'; message: string }

// ---------------------------------------------------------------------------
// Settings

export type AccentName = 'violet' | 'ember' | 'cyan' | 'graphite' | 'emerald'

export interface Settings {
  accent: AccentName
  reduceMotion: boolean
  minimizeOnLaunch: boolean
  autoFetchArtwork: boolean
  scanPlatforms: Record<Exclude<Platform, 'manual'>, boolean>
  customFolders: string[]
  /** Also look for game folders on every local drive (Games folders, extra Steam libraries, launcher folders). */
  scanAllDrives: boolean
  /** Look for new games and installed mods every time NexusForge starts. */
  scanOnStartup: boolean
  modStorageDir: string
  defaultStrategy: DeployStrategy
  /** What to do with mods a download needs: ask every time, install them automatically, or never. */
  dependencyMode: 'ask' | 'always' | 'never'
  /** steamcmd.exe used for Steam Workshop downloads; empty = NexusForge's own copy. */
  steamcmdPath: string
  /** Steam account SteamCMD is signed in with (set from Accounts; the login itself is cached by SteamCMD). */
  steamAccount: string
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  sources: Record<string, { enabled: boolean; apiKey?: string }>
  feeds: FeedConfig[]
  trustedPlugins: Record<string, string>
  firstRunComplete: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userData: string
  logFile: string
  isElevated: boolean
}

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  message?: string
}
