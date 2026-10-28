// Game integrations: what NexusForge knows about how one game loads mods.
//
// An integration says where a game keeps mods (deploy targets), how a downloaded package maps onto them
// (classify), which mod loader the game needs and how to install it through the official channel (loaders),
// what to write after deployment (configure: loader lists such as tModLoader's enabled.json), how to check the
// result (verify), and how to start the game with and without mods (launch). Shared infrastructure (download,
// extraction, the deploy engine, rollback) lives outside; integrations only describe the game.
//
// Integrations are pure Node: everything that needs Electron or the network comes in through IntegrationEnv,
// so they can be tested against fake game folders.

import type {
  DeployManifest,
  DeployTarget,
  DiagnosticFinding,
  Game,
  InstalledMod,
  IntegrationCapabilities,
  IntegrationInfo,
  LaunchCheck,
  LaunchSpec,
  LoaderStatus,
  ModCheck,
  ModKind,
  ModRoute,
  ModSourceRef,
  SkippedFile,
  VerifyCheck
} from '@shared/types'
import type { TargetSpec, EngineLogger } from '../mods/deploy'
import type { WalkEntry } from '../util/fs'

export interface SteamApp {
  appId: string
  /** steamapps folder of the library it is in. */
  library: string
  dir: string
  name?: string
  /** 4 = fully installed */
  stateFlags: number
  buildId?: string
  betaKey?: string
  bytesToDownload?: number
  bytesDownloaded?: number
}

export interface SteamEnv {
  /** Steam's install folder, if Steam is installed. */
  root(): Promise<string | undefined>
  app(appId: string): Promise<SteamApp | undefined>
}

export interface DownloadOptions {
  /** Expected SHA-256 (hex), when the publisher states one. */
  sha256?: string
  size?: number
  /** Request headers (a publisher that wants its download page as Referer). */
  headers?: Record<string, string>
  /** Hosts the download (and its redirects) may come from; default: GitHub's. */
  allowedHosts?: string[]
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
}

export interface IntegrationEnv {
  /** The user's Documents folder (where Terraria and others keep saves and mods). */
  documents: string
  /** Public Documents (C:\Users\Public\Documents), where some Social Club emulators keep GTA V saves. */
  publicDocuments?: string
  /** Folder for NexusForge's own work files (downloads, temporary extraction). */
  workDir: string
  steam: SteamEnv
  log: EngineLogger
  fetchJson<T>(url: string): Promise<T>
  fetchText(url: string): Promise<string>
  /** HTTPS download into `dest`, resumed after drops, checked against sha256/size when given. */
  download(url: string, dest: string, opts?: DownloadOptions): Promise<{ sha256: string; size: number }>
  /** Opens a steam:// link (Steam's own install dialog). */
  openUrl(url: string): Promise<void>
  /** File version of an .exe or .dll. */
  fileVersion(file: string): Promise<string | undefined>
  /** Unpacks a zip into an empty folder (safety checks included). */
  extract(archive: string, dest: string): Promise<void>
}

/** What NexusForge remembers about a game's integration between runs. */
export interface IntegrationState {
  loaders: Record<string, LoaderRecord>
  /** tModLoader mod names NexusForge put into enabled.json. */
  tmlManaged?: string[]
  /** enabled.json was backed up before NexusForge first changed it. */
  tmlEnabledBackup?: string
  /** Last loader log seen after a launch. */
  lastLaunch?: LaunchCheck
  /** Files NexusForge's configure step created (UE4SS enabled.txt); removed again when no longer needed. */
  createdFiles?: string[]
}

export interface LoaderRecord {
  version?: string
  dir?: string
  via: 'steam' | 'github' | 'nexusforge' | 'manual'
  installedAt: number
  tag?: string
  prerelease?: boolean
  sha256?: string
}

export interface StagedPackage {
  /** Folder the package was extracted into. */
  dir: string
  /** Every file, relative to dir. */
  files: WalkEntry[]
  /** Best known name (from the source, else the archive). */
  name: string
  archiveName?: string
  source?: ModSourceRef
  /** Set when NexusForge downloaded it as this game's mod loader. */
  loaderHint?: string
}

export interface Classification {
  kind: ModKind
  routes: ModRoute[]
  skipped: SkippedFile[]
  checks: ModCheck[]
  needsLoader?: string
  /** More loaders the mod needs besides needsLoader (Cyberpunk mods often need two or three). */
  needsLoaders?: string[]
  loaderId?: string
  meta?: Record<string, string>
  name?: string
  version?: string
  /** The main content folder (shown as "content folder" in the mod settings). */
  rootPath: string
}

export interface LoaderInstallHost {
  /** Installs a downloaded archive as a mod of this game (used for loaders that live in the game folder). */
  installModFile(gameId: string, file: string, meta: { name: string; version?: string; source?: ModSourceRef }): Promise<InstalledMod>
  state(gameId: string): IntegrationState
  saveState(gameId: string, state: IntegrationState): void
}

export type StepReporter = (detail: string, progress?: number) => void

export interface LoaderAdapter {
  id: string
  name: string
  status(game: Game, info: IntegrationInfo, env: IntegrationEnv, state: IntegrationState, mods: InstalledMod[]): Promise<LoaderStatus>
  /** Installs (or updates) through the official channel. Resolves when the loader is ready. */
  install(game: Game, info: IntegrationInfo, env: IntegrationEnv, host: LoaderInstallHost, report: StepReporter, signal?: AbortSignal): Promise<void>
  /** Removes a loader NexusForge installed (folders it created; Steam apps through Steam). */
  remove?(game: Game, info: IntegrationInfo, env: IntegrationEnv, host: LoaderInstallHost): Promise<void>
}

export interface ShortcutSpec {
  name: string
  target: string
  args?: string
  cwd?: string
  icon?: string
  description: string
}

export interface GameIntegration {
  id: string
  /** Raised when classification rules change; mods laid out by an older revision are laid out again. */
  revision: number
  matches(game: Game, env: IntegrationEnv): Promise<boolean>
  inspect(game: Game, env: IntegrationEnv, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo>
  classify(pkg: StagedPackage, game: Game, info: IntegrationInfo, env: IntegrationEnv): Promise<Classification>
  loaders: LoaderAdapter[]
  /** After the files are in place (and after a rollback): loader lists and config. Idempotent. */
  configure?(game: Game, info: IntegrationInfo, manifest: DeployManifest, mods: InstalledMod[], env: IntegrationEnv, host: LoaderInstallHost): Promise<void>
  verify?(game: Game, info: IntegrationInfo, manifest: DeployManifest, mods: InstalledMod[], env: IntegrationEnv): Promise<VerifyCheck[]>
  /** NexusForge can tell whether the game will load what was deployed. */
  loadVerifiable: boolean
  launch?(game: Game, info: IntegrationInfo, variant: 'vanilla' | 'modded', env: IntegrationEnv): Promise<{ spec: LaunchSpec; followDir?: string } | undefined>
  /** Reads the loader's log after a launch. */
  checkLaunch?(game: Game, info: IntegrationInfo, since: number, env: IntegrationEnv): Promise<LaunchCheck>
  shortcut?(game: Game, info: IntegrationInfo, variant: 'vanilla' | 'modded', env: IntegrationEnv): Promise<ShortcutSpec | undefined>
  /**
   * Save-game packages (see mods/classify.ts): where each save file goes inside the 'saves' target that inspect()
   * reported. Must never overwrite a save the user already has.
   */
  saveRoutes?(pkg: StagedPackage, saveFiles: string[], target: DeployTarget, game: Game): Promise<{ routes: ModRoute[]; checks: ModCheck[] }>
  /** Game-specific diagnostic checks. Read-only: nothing may be changed here. */
  diagnose?(ctx: DiagnoseContext): Promise<DiagnosticFinding[]>
}

export interface DiagnoseContext {
  game: Game
  info: IntegrationInfo
  mods: InstalledMod[]
  enabled: Set<string>
  manifest?: DeployManifest
  lastLaunch?: LaunchCheck
  env: IntegrationEnv
  state: IntegrationState
}

/** What an integration implements, read off the integration itself (so it can't claim more than it does). */
export function capabilitiesOf(i: GameIntegration): IntegrationCapabilities {
  const specific = i.id !== 'generic'
  return {
    detect: specific,
    version: specific,
    classify: specific,
    loaders: i.loaders.length > 0,
    configure: Boolean(i.configure),
    verifyFiles: true,
    verifyLoad: i.loadVerifiable,
    runtimeLog: Boolean(i.checkLaunch),
    launch: Boolean(i.launch),
    saves: Boolean(i.saveRoutes),
    diagnose: Boolean(i.diagnose),
    uninstall: true
  }
}

/** Deploy targets of an inspected game, for the engine. */
export function engineTargets(info: IntegrationInfo): Record<string, TargetSpec> {
  const out: Record<string, TargetSpec> = {}
  for (const t of info.targets) out[t.id] = { dir: t.dir, label: t.label, userData: t.userData, create: t.create }
  return out
}
