import Store from 'electron-store'
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import type { DownloadItem, Game, InstalledMod, Settings } from '@shared/types'

interface StoredSettings extends Omit<Settings, 'sources'> {
  /** apiKey is kept encrypted with the OS keychain (DPAPI on Windows). */
  sources: Record<string, { enabled: boolean; apiKeyEnc?: string }>
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface Schema {
  schemaVersion: number
  settings: StoredSettings
  games: Record<string, Game>
  mods: Record<string, Record<string, InstalledMod>>
  activeProfiles: Record<string, string>
  downloads: DownloadItem[]
  window: WindowState
  /** Signed-in account names per site (the keys themselves live encrypted in settings.sources). */
  accounts: Record<string, { user?: string; avatar?: string; detail?: string }>
}

function defaultSettings(): StoredSettings {
  return {
    accent: 'violet',
    reduceMotion: false,
    minimizeOnLaunch: false,
    autoFetchArtwork: true,
    scanPlatforms: { steam: true, epic: true, xbox: true, gog: true, custom: true },
    customFolders: [],
    scanAllDrives: true,
    modStorageDir: join(app.getPath('userData'), 'mods'),
    defaultStrategy: 'symlink',
    dependencyMode: 'ask',
    steamcmdPath: '',
    steamAccount: '',
    logLevel: 'info',
    sources: {},
    feeds: [],
    trustedPlugins: {},
    firstRunComplete: false
  }
}

let store: Store<Schema> | undefined

export function db(): Store<Schema> {
  if (!store) {
    store = new Store<Schema>({
      name: 'nexusforge',
      clearInvalidConfig: false,
      defaults: {
        schemaVersion: 1,
        settings: defaultSettings(),
        games: {},
        mods: {},
        activeProfiles: {},
        downloads: [],
        window: { width: 1440, height: 900, maximized: false },
        accounts: {}
      }
    })
    // Merge in settings keys added in newer versions.
    const merged = { ...defaultSettings(), ...store.get('settings') }
    merged.scanPlatforms = { ...defaultSettings().scanPlatforms, ...merged.scanPlatforms }
    store.set('settings', merged)
  }
  return store
}

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(value).toString('base64')
  return 'raw:' + Buffer.from(value, 'utf8').toString('base64')
}

function decrypt(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8')
  } catch {
    return undefined
  }
  return undefined
}

/** Settings as the renderer sees them: API keys are never sent across IPC. */
export function getSettings(): Settings {
  const s = db().get('settings')
  const sources: Settings['sources'] = {}
  for (const [id, v] of Object.entries(s.sources)) sources[id] = { enabled: v.enabled }
  return { ...s, sources }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const current = db().get('settings')
  const next: StoredSettings = { ...current, ...(patch as Partial<StoredSettings>), sources: current.sources }
  if (patch.sources) {
    const sources = { ...current.sources }
    for (const [id, v] of Object.entries(patch.sources)) {
      const prev = sources[id] ?? { enabled: true }
      const entry: StoredSettings['sources'][string] = { ...prev, enabled: v.enabled ?? prev.enabled }
      if (v.apiKey !== undefined) entry.apiKeyEnc = v.apiKey ? encrypt(v.apiKey.trim()) : undefined
      sources[id] = entry
    }
    next.sources = sources
  }
  db().set('settings', next)
  return getSettings()
}

export function getApiKey(sourceId: string): string | undefined {
  return decrypt(db().get('settings').sources[sourceId]?.apiKeyEnc)
}

export function hasApiKey(sourceId: string): boolean {
  return Boolean(db().get('settings').sources[sourceId]?.apiKeyEnc)
}

export function isSourceEnabled(sourceId: string): boolean {
  return db().get('settings').sources[sourceId]?.enabled ?? true
}
