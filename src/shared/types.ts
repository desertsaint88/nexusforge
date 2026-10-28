// Types shared by the main process, the preload bridge and the renderer.

export type Platform = 'steam' | 'epic' | 'xbox' | 'gog' | 'custom' | 'manual'

/**
 * How files get into the game. 'auto' hardlinks when mod storage and the target are on the same drive and copies
 * otherwise; it needs no special Windows rights. 'symlink' is only used when chosen and Windows allows it.
 */
export type DeployStrategy = 'auto' | 'symlink' | 'hardlink' | 'copy'
export type DeployMethod = 'symlink' | 'hardlink' | 'copy'

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
  /**
   * Where the mod's files go (set by the game's integration). Mods installed before 1.4 have none:
   * everything under rootPath goes into the game's deploy folder.
   */
  routes?: ModRoute[]
  /** What the package contains, as the game's integration understood it. */
  kind?: ModKind
  /** The mod is this mod loader (BepInEx): deployed first, managed from the setup panel. */
  loaderId?: string
  /** Mod loader the mod needs to work ('bepinex', 'tmodloader'). */
  needsLoader?: string
  /** More loaders it needs besides needsLoader ('red4ext', 'archivexl'). */
  needsLoaders?: string[]
  /** Files left out of the game (read-me files, a second copy of the loader) and why. */
  skipped?: SkippedFile[]
  /** Compatibility findings; an 'error' keeps the mod from being deployed. */
  checks?: ModCheck[]
  /** Facts read from the package itself (tModLoader mod name, version it was built for). */
  meta?: Record<string, string>
  /** Integration (and rules revision) that laid the mod out, e.g. "terraria@1". */
  layoutBy?: string
}

/** A folder (or single file) of a mod's storage that goes into one deploy target. */
export interface ModRoute {
  /** Path inside stagingDir, forward slashes ('' = the whole storage folder). */
  from: string
  /** Deploy target id ('game' = the game's deploy folder). */
  target: string
  /** Path inside the target: a folder for folder routes, the file name for file routes ('' = target root). */
  to: string
}

export type ModKind = 'loader' | 'plugin' | 'tmod' | 'world' | 'player' | 'resourcepack' | 'savegame' | 'archive' | 'files' | 'installer' | 'preset' | 'framework-mod'

export interface SkippedFile {
  path: string
  reason: string
}

export interface ModCheck {
  level: 'error' | 'warning' | 'info'
  message: string
  code?: string
  /** The user can resolve it (run the installer, install ReShade); NexusForge can't do it by itself. */
  userAction?: string
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
  /** "<target>|<lower-case path>" */
  key: string
  /** Deploy target the file goes into. */
  target: string
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

/** A folder mods are deployed into: the game folder, a mods folder in Documents, a save folder, … */
export interface DeployTarget {
  id: string
  label: string
  dir: string
  /** The game writes to these files (worlds, saves): always copied, and changed files are never removed. */
  userData?: boolean
  /** Missing folder may be created (folders in Documents that the game creates on first start). */
  create?: boolean
}

export interface DeployManifestEntry {
  /** Deploy target id; manifests from before 1.4 only had the game folder ('game'). */
  target: string
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
  version: 2
  gameId: string
  profileId: string
  /** target id -> absolute folder */
  targets: Record<string, string>
  strategy: DeployStrategy
  deployedAt: number
  planHash: string
  entries: DeployManifestEntry[]
  /** Folders NexusForge created, as "<target>|<path>". */
  createdDirs: string[]
  /** Result of the checks after this deployment. */
  verified?: { at: number; ok: boolean; problems: string[]; /** The integration checked that the game will load the files (not just that they are in place). */ loadVerified?: boolean }
}

/** Where a mod stands: in storage, in the game, checked, or what went wrong. */
export type ModDeployState = 'prepared' | 'deployed' | 'verified' | 'failed' | 'rolled_back' | 'needs_loader' | 'blocked' | 'disabled'

export interface DeployStatus {
  gameId: string
  deployed: boolean
  inSync: boolean
  fileCount: number
  methods: Record<DeployMethod, number>
  deployedAt?: number
  profileId?: string
  /** Every folder this game deploys into. */
  targets: DeployTarget[]
  /** Outcome of the last deployment (kept across restarts). */
  last?: DeployOutcomeSummary
  /** Per installed mod. */
  perMod: Record<string, ModDeployState>
  /** Per deployed mod: what the game's last start says (only when the loader's log names it). */
  runtime?: Record<string, ModRuntime>
  /** A deployment was cut off (crash, power loss); the next deploy restores the state before it first. */
  interrupted?: boolean
}

/**
 * verified: files in place and the integration checked that the game will load them (loader present, enabled);
 * deployed: files in place and every one checked, but NexusForge can't tell whether the game loads them.
 * Neither says the mod ran: that only comes from the loader's log after a start (ModRuntime).
 */
export type DeployOutcome = 'verified' | 'deployed' | 'failed' | 'rolled_back' | 'nothing'

/** The deployment worked (nothing to roll back or fix). */
export function outcomeOk(o: DeployOutcome | undefined): boolean {
  return o === 'verified' || o === 'deployed' || o === 'nothing'
}

export interface DeployOutcomeSummary {
  at: number
  outcome: DeployOutcome
  title: string
  problem?: DeployProblem
  /** Mods involved in the failure (if known). */
  failedMods?: string[]
}

export type DeployStage = 'validate' | 'loader' | 'plan' | 'preflight' | 'recover' | 'remove' | 'place' | 'configure' | 'verify' | 'record' | 'rollback' | 'done'

export interface DeployProgress {
  gameId: string
  phase: DeployStage
  done: number
  total: number
  message?: string
}

export interface DeployProblem {
  /** locked | not_writable | disk_full | source_missing | target_missing | verify_failed | check_failed | cancelled | unsafe_path | game_running | loader_missing | blocked | error */
  code: string
  title: string
  detail: string
  /** What the user can do about it. */
  advice: string[]
  /** File(s) involved. */
  paths?: string[]
}

export interface VerifyCheck {
  label: string
  ok: boolean
  level: 'error' | 'warning' | 'info'
  detail?: string
}

export interface DeployVerification {
  ok: boolean
  /** Files checked after deployment. */
  checked: number
  failed: Array<{ target: string; rel: string; reason: string }>
  /** Checks of the game integration (loader present, enabled list, launch target). */
  checks: VerifyCheck[]
  /** NexusForge knows how this game loads mods and checked it; false for plain file deployments. */
  loadVerified: boolean
}

export interface DeployReport {
  gameId: string
  outcome: DeployOutcome
  /** One-line summary for the user. */
  title: string
  placed: number
  removed: number
  unchanged: number
  backedUp: number
  /** Files the game/user modified after deployment; moved to the overwrite folder instead of being deleted. */
  rescued: number
  /** Changed files in save folders that were left where they are (your progress). */
  kept: number
  methods: Record<DeployMethod, number>
  /** How the method was chosen (no action needed), e.g. "copied: mod storage is on another drive". */
  notes: string[]
  errors: string[]
  problem?: DeployProblem
  verification?: DeployVerification
  /** An interrupted earlier deployment was rolled back first. */
  recovered?: boolean
  /** Stages in the order they ran. */
  stages: Array<{ stage: DeployStage; ok: boolean; ms: number; message?: string }>
  durationMs: number
}

export interface LinkCapabilities {
  symlink: boolean
  hardlink: boolean
  symlinkReason?: string
  hardlinkReason?: string
  /** What 'auto' will do for this game, in words. */
  autoMethod?: string
}

// ---------------------------------------------------------------------------
// Game integrations (how a game loads mods, its mod loaders and launch options)

export type DistributionKind = 'steam' | 'gog' | 'epic' | 'xbox' | 'standalone' | 'unknown'

export interface LoaderStatus {
  id: string
  name: string
  state: 'installed' | 'missing' | 'outdated' | 'broken' | 'unsupported'
  version?: string
  latest?: string
  dir?: string
  /** How it is (or would be) installed. */
  via?: 'steam' | 'github' | 'nexusforge' | 'manual'
  detail?: string
  canInstall: boolean
  canUpdate: boolean
  canRemove: boolean
  /** Why NexusForge can't install it here, and what to do instead. */
  blocked?: string
  /** Something to know before installing it (anti-cheat, game version). */
  warning?: string
  /** What the loader is for. */
  summary?: string
  /** Other loaders it needs (installed first). */
  requires?: string[]
  /** The DLL name it loads through, when that is not its usual one (a file that came with the game has it). */
  proxy?: string
  /** An installed mod needs it. */
  required: boolean
}

export interface LaunchOption {
  id: 'default' | 'vanilla' | 'modded'
  label: string
  description?: string
  available: boolean
  reason?: string
  primary?: boolean
}

export interface IntegrationInfo {
  gameId: string
  integrationId: string
  /** "Terraria · tModLoader", "Casualties: Unknown · BepInEx", "Generic" */
  name: string
  /** full: loader setup, routing and checks are implemented; partial: routing/checks; basic: files are copied as they are. */
  support: 'full' | 'partial' | 'basic'
  distribution: { kind: DistributionKind; label: string; detail?: string }
  version?: string
  /** The install folder has the files this game needs. */
  valid: boolean
  problems: string[]
  targets: DeployTarget[]
  loaders: LoaderStatus[]
  launchOptions: LaunchOption[]
  /** Starts NexusForge can make a shortcut for ("Terraria Modded"). */
  shortcutVariants?: Array<'vanilla' | 'modded'>
  /** What NexusForge does for this game. */
  capabilities: string[]
  /** What the game's integration implements, capability by capability (unsupported ones are reported, not faked). */
  supports?: IntegrationCapabilities
  warnings: string[]
  /** What it can't do here, plainly. */
  limitations: string[]
  inspectedAt: number
}

export interface SetupStep {
  id: string
  label: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
  /** 0..1 when known */
  progress?: number
}

export interface SetupProgress {
  gameId: string
  opId: string
  title: string
  steps: SetupStep[]
  done: boolean
  ok?: boolean
  error?: string
}

export interface LaunchCheck {
  /** The loader wrote its log after the last launch. */
  ran: boolean
  loader?: string
  loaded: string[]
  errors: string[]
  logFile?: string
  at?: number
  /** Per file the loader reported on (the log names the file): loaded, or failed and why. */
  files?: RuntimeFileResult[]
}

export interface RuntimeFileResult {
  /** File name as the log names it ("ZombiesV.dll"), or the plugin's display name when byName is set. */
  file: string
  /** The log names a plugin ("Medical Brutalism 4.7.10"), not a file: matched to a mod by name and version. */
  byName?: boolean
  ok: boolean
  /** The log lines that say so. */
  evidence: string[]
  /** The file needs a newer loader than the one installed ("Script Hook V .NET API 3.7.0"). */
  needs?: { loaderId: string; version: string }
}

/** What the game's last start says about one mod. */
export interface ModRuntime {
  /** loaded: the loader's log names the mod's files as loaded; failed: it names them with an error; unknown: no evidence. */
  state: 'loaded' | 'failed' | 'unknown'
  at?: number
  evidence: string[]
  logFile?: string
  needs?: { loaderId: string; version: string }
}

// ---------------------------------------------------------------------------
// Capabilities and diagnostics

/** Capabilities a game integration genuinely implements. */
export interface IntegrationCapabilities {
  /** Recognizes the game (and edition) from its files. */
  detect: boolean
  /** Reads the game's version. */
  version: boolean
  /** Knows the game's mod formats and where each goes. */
  classify: boolean
  /** Installs mod loaders from their official channel. */
  loaders: boolean
  /** Writes loader configuration (enabled lists). */
  configure: boolean
  /** Checks that the files the game loads are where it loads them. */
  verifyFiles: boolean
  /** Checks that the game will load what was deployed (loader present, enabled, launch target). */
  verifyLoad: boolean
  /** Reads the loader's log after a start (runtime evidence). */
  runtimeLog: boolean
  /** Starts the game with / without mods. */
  launch: boolean
  /** Knows where the game keeps saves (save-game mods go there). */
  saves: boolean
  /** Contributes game-specific diagnostic checks. */
  diagnose: boolean
  /** Removes everything it deployed, restoring replaced files. */
  uninstall: boolean
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'
/** confirmed: the evidence shows it; likely: strong indication; possible: worth checking. */
export type DiagnosticConfidence = 'confirmed' | 'likely' | 'possible'
export type DiagnosticCategory = 'installation' | 'deployment' | 'package' | 'loader' | 'compatibility' | 'runtime' | 'configuration' | 'state'

export interface DiagnosticFix {
  /** Fix action id ('deploy', 'install-loader', 'relayout', 'set-deploy-dir', 'run-installer', 'remove-mod'). */
  id: string
  label: string
  /** What it changes, in words, shown before the user confirms. */
  description: string
  /** Changes files or settings (asks for confirmation first). Read-only actions (open a folder) are not. */
  consequential: boolean
  params?: Record<string, string>
}

export interface DiagnosticFinding {
  /** Stable code ("NF-DEP-002"), see docs/INTEGRATIONS.md. */
  code: string
  category: DiagnosticCategory
  severity: DiagnosticSeverity
  confidence: DiagnosticConfidence
  title: string
  detail: string
  /** What was looked at: file paths, log lines, recorded state. */
  evidence: string[]
  modIds?: string[]
  /** NexusForge can repair it (with the user's confirmation). */
  fixes: DiagnosticFix[]
  /** Needs the user (something NexusForge can't or won't do by itself). */
  userAction?: string
}

export interface DiagnosticModRow {
  id: string
  name: string
  version?: string
  kind?: ModKind
  enabled: boolean
  state: ModDeployState
  runtime: ModRuntime
  needs: string[]
  problems: string[]
}

export interface DiagnosticReport {
  gameId: string
  gameName: string
  at: number
  integration: { id: string; name: string; support: IntegrationInfo['support']; supports: IntegrationCapabilities }
  installation: { installDir: string; exePath?: string; deployDir: string; distribution: string; version?: string; valid: boolean; problems: string[] }
  targets: DeployTarget[]
  loaders: Array<Pick<LoaderStatus, 'id' | 'name' | 'state' | 'version' | 'latest' | 'blocked' | 'required'>>
  deployment: { deployed: boolean; inSync: boolean; fileCount: number; deployedAt?: number; interrupted?: boolean; last?: DeployOutcomeSummary }
  lastLaunch?: LaunchCheck
  mods: DiagnosticModRow[]
  findings: DiagnosticFinding[]
  summary: { errors: number; warnings: number; infos: number; fixable: number }
  /** How long the checks took. */
  durationMs: number
}

export interface ShortcutInfo {
  gameId: string
  path: string
  label: string
  where: 'startmenu' | 'desktop'
  variant: 'vanilla' | 'modded'
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
 * Orders for mod lists. Each source only offers the orders its own website has, so a list matches the site's.
 * downloads_recent: what the site calls popular right now (Nexus "Popular mods": most downloaded of the last
 * 28 days; Steam "Most Popular" of the last month).
 * trending: what the site calls trending/hot (Nexus "Trending mods": most endorsed of the last 7 days).
 */
export type ModSort = 'relevance' | 'endorsed' | 'downloads' | 'downloads_recent' | 'trending' | 'newest' | 'updated'

export interface ModSearchOptions {
  sort?: ModSort
  /** 0-based page of the site's list ("Load more"); only sources marked `paged` support it. */
  page?: number
}

export interface ModSearchResponse {
  results: ModSearchResult[]
  sort: ModSort
  /** The source can't order by this itself; NexusForge sorted the results it got. */
  approximate?: boolean
  /** The site has more results on further pages. */
  more?: boolean
}

/** A newer file for a mod installed through NexusForge. */
export interface ModUpdate {
  /** Installed mod id. */
  modId: string
  name: string
  sourceId: string
  /** The mod's id on its source. */
  sourceModId: string
  currentVersion?: string
  latestVersionId: string
  latestVersion?: string
  /** Name of the newer file on the site. */
  latestName: string
  date?: string
  sizeBytes?: number
  thumbnail?: string
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
  /** The site marks this file as replaced by a newer one (Nexus "Old versions"). */
  superseded?: boolean
  /** Files of one channel replace each other (Nexus file categories: main, optional, …); none = one channel. */
  channel?: string
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
  /** The site's own name for each of those orders. */
  sortLabels?: Partial<Record<ModSort, string>>
  /** Orders available when searching for a name, if fewer than `sorts`. */
  querySorts?: ModSort[]
  /** Lists continue on further pages ("Load more"). */
  paged?: boolean
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
  /** Interface size (zoom), 0.75–1.5; Ctrl + / Ctrl - / Ctrl 0 and Ctrl + mouse wheel change it. */
  uiScale: number
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
  /** After a download installs, set up what the game needs (mod loader) and deploy right away. */
  autoDeploy: boolean
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
