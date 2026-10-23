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
  addedAt: number
  favorite?: boolean
  hidden?: boolean
  missing?: boolean
  modding: GameModding
  /** Fields the user edited; scans won't overwrite them. */
  userEdited?: Array<'name' | 'exePath' | 'launch' | 'art'>
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
  version?: string
  url?: string
}

export interface ModVersion {
  id: string
  name: string
  version?: string
  fileName?: string
  sizeBytes?: number
  date?: string
  primary?: boolean
  /** Download needs an interactive step (e.g. Nexus free accounts); open the page instead. */
  manualOnly?: boolean
}

export interface ModDetails extends ModSearchResult {
  description: string
  images: string[]
  versions: ModVersion[]
  tags?: string[]
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
  homepage?: string
  /** Placeholder text for the per-game binding field (e.g. "Thunderstore community"). */
  bindingLabel?: string
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

export type DownloadState = 'queued' | 'downloading' | 'installing' | 'completed' | 'failed' | 'cancelled'

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
}

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
  modStorageDir: string
  defaultStrategy: DeployStrategy
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
