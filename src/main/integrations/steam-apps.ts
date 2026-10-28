// Installed Steam apps, read from Steam's own files (libraryfolders.vdf, appmanifest_<id>.acf).

import { promises as fsp } from 'node:fs'
import { join, normalize } from 'node:path'
import type { SteamApp, SteamEnv } from './types'
import { parseVdf, vget, vstr } from '../library/vdf'
import { regValue } from '../util/exec'

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function findSteamInstall(): Promise<string | undefined> {
  const candidates = [
    await regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    await regValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    await regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ]
  for (const c of candidates) {
    if (!c) continue
    const p = normalize(c.replace(/\//g, '\\'))
    if (await exists(join(p, 'steamapps'))) return p
  }
  return undefined
}

export async function steamLibraries(root: string): Promise<string[]> {
  const out = [join(root, 'steamapps')]
  const seen = new Set(out.map((x) => x.toLowerCase()))
  for (const file of [join(root, 'steamapps', 'libraryfolders.vdf'), join(root, 'config', 'libraryfolders.vdf')]) {
    try {
      const lf = vget(parseVdf(await fsp.readFile(file, 'utf8')), 'libraryfolders')
      if (!lf || typeof lf !== 'object') continue
      for (const [key, entry] of Object.entries(lf)) {
        const path = typeof entry === 'object' ? vstr(entry, 'path') : /^\d+$/.test(key) ? entry : undefined
        if (!path) continue
        const apps = join(normalize(path), 'steamapps')
        if (!seen.has(apps.toLowerCase()) && (await exists(apps))) {
          seen.add(apps.toLowerCase())
          out.push(apps)
        }
      }
    } catch {
      // missing or unreadable
    }
  }
  return out
}

export async function readAppManifest(library: string, appId: string): Promise<SteamApp | undefined> {
  const file = join(library, `appmanifest_${appId}.acf`)
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const state = vget(parseVdf(text), 'AppState')
  const installdir = vstr(state, 'installdir')
  if (!installdir) return undefined
  const num = (k: string) => {
    const v = vstr(state, k)
    return v === undefined ? undefined : Number(v)
  }
  return {
    appId,
    library,
    dir: join(library, 'common', installdir),
    name: vstr(state, 'name'),
    stateFlags: num('StateFlags') ?? 0,
    buildId: vstr(state, 'buildid'),
    betaKey: vstr(state, 'UserConfig', 'BetaKey') ?? vstr(state, 'MountedConfig', 'BetaKey') ?? vstr(state, 'UserConfig', 'betakey'),
    bytesToDownload: num('BytesToDownload'),
    bytesDownloaded: num('BytesDownloaded')
  }
}

/** Steam lookups; `root` can be given for tests (a fake Steam folder). */
export function createSteamEnv(root?: string): SteamEnv {
  let rootP: Promise<string | undefined> | undefined
  let libs: { at: number; list: Promise<string[]> } | undefined
  const getRoot = () => (rootP ??= root !== undefined ? Promise.resolve(root || undefined) : findSteamInstall())
  const libraries = async () => {
    const r = await getRoot()
    if (!r) return []
    if (!libs || Date.now() - libs.at > 10_000) libs = { at: Date.now(), list: steamLibraries(r) }
    return libs.list
  }
  return {
    root: getRoot,
    async app(appId) {
      for (const lib of await libraries()) {
        const app = await readAppManifest(lib, appId)
        if (app) return app
      }
      return undefined
    }
  }
}
