// Helpers shared by the game integrations: read-me detection, wrapper folders, GOG/Steam markers.

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { DistributionKind, Game, ModRoute, SkippedFile } from '@shared/types'
import { readJson, safeReaddir, type WalkEntry } from '../util/fs'

const DOC_EXT = /\.(url|nfo|pdf|rtf|docx?|lnk|website)$/i
const TEXT_EXT = /\.(txt|md|markdown|html?)$/i
const DOC_STEM = /^(read[ _-]?me.*|.*readme|licen[cs]e.*|change[ _-]?log.*|changes|credits?|instructions?.*|how[ _-]?to.*|howtomod|install(ation|ing)?.*|notes?|faq|modstuff|copying|info)$/i

/** Files that explain a mod rather than being part of it (only ever skipped at the top of a package). */
export function isDocFile(name: string): boolean {
  if (DOC_EXT.test(name)) return true
  if (name.includes('.') && !TEXT_EXT.test(name)) return false
  return DOC_STEM.test(name.replace(/\.[^.]+$/, '').trim())
}

/** Files of a package below `prefix` ('' = all), with paths relative to it. */
export function under(files: WalkEntry[], prefix: string): Array<WalkEntry & { sub: string }> {
  const p = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
  return files.filter((f) => !p || f.rel.toLowerCase().startsWith(p.toLowerCase())).map((f) => ({ ...f, sub: f.rel.slice(p.length) }))
}

/** Immediate children of a folder inside a package. */
export function children(files: WalkEntry[], prefix: string): { dirs: string[]; files: string[] } {
  const dirs = new Set<string>()
  const out: string[] = []
  for (const f of under(files, prefix)) {
    const i = f.sub.indexOf('/')
    if (i < 0) out.push(f.sub)
    else dirs.add(f.sub.slice(0, i))
  }
  return { dirs: [...dirs], files: out }
}

/**
 * Descends through wrapper folders ("ModName v1.2/…") that hold nothing but one folder (and read-me files).
 * Folders in `stopAt` (lower-case) are content, never wrappers.
 */
export function unwrap(files: WalkEntry[], stopAt: Set<string>, maxDepth = 4): string {
  let prefix = ''
  for (let i = 0; i < maxDepth; i++) {
    const c = children(files, prefix)
    const real = c.files.filter((f) => !isDocFile(f))
    if (real.length || c.dirs.length !== 1 || stopAt.has(c.dirs[0].toLowerCase())) break
    prefix = prefix ? `${prefix}/${c.dirs[0]}` : c.dirs[0]
  }
  return prefix
}

/** Read-me files directly in `prefix` become skipped entries. */
export function skipDocs(files: WalkEntry[], prefix: string, reason = 'read-me file, not part of the mod'): SkippedFile[] {
  return children(files, prefix)
    .files.filter(isDocFile)
    .map((f) => ({ path: prefix ? `${prefix}/${f}` : f, reason }))
}

/** A folder name that is safe on every file system. */
export function folderName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'Mod'
  )
}

export function route(from: string, target: string, to = ''): ModRoute {
  return { from, target, to }
}

export interface GogInfo {
  gameId: string
  name?: string
}

/** GOG installers leave goggame-<id>.info in the game folder. */
export async function gogInfo(dir: string): Promise<GogInfo | undefined> {
  for (const e of await safeReaddir(dir)) {
    const m = e.isFile() && e.name.match(/^goggame-(\d+)\.info$/i)
    if (!m) continue
    const info = await readJson<{ gameId?: string; name?: string }>(join(dir, e.name))
    return { gameId: info?.gameId ?? m[1], name: info?.name }
  }
  return undefined
}

/** Where a copy of a game came from, as far as its folder and library entry tell. */
export async function distributionOf(game: Game): Promise<{ kind: DistributionKind; label: string; detail?: string }> {
  if (game.platform === 'steam') return { kind: 'steam', label: 'Steam', detail: `Steam app ${game.platformId}` }
  if (game.platform === 'gog') return { kind: 'gog', label: 'GOG' }
  if (game.platform === 'epic') return { kind: 'epic', label: 'Epic Games' }
  if (game.platform === 'xbox') return { kind: 'xbox', label: 'Xbox / Microsoft Store' }
  const gog = await gogInfo(game.installDir)
  if (gog) return { kind: 'gog', label: 'GOG', detail: `GOG game ${gog.gameId} (installed outside GOG Galaxy's list)` }
  return { kind: 'standalone', label: 'Standalone folder', detail: 'Not registered with a store on this PC' }
}

/** Anti-cheat that ships with the game (EasyAntiCheat, BattlEye), found in the given folders. */
export async function antiCheatIn(dirs: string[]): Promise<string | undefined> {
  for (const dir of dirs) {
    for (const e of await safeReaddir(dir)) {
      if (e.isDirectory() && /^easyanticheat(_eos)?$/i.test(e.name)) return 'EasyAntiCheat'
      if (e.isFile() && /^start_protected_game\.exe$/i.test(e.name)) return 'EasyAntiCheat'
      if ((e.isDirectory() && /^battleye$/i.test(e.name)) || (e.isFile() && /_be\.exe$/i.test(e.name))) return 'BattlEye'
    }
  }
  return undefined
}

export function antiCheatWarning(ac: string | undefined, loader: string): string | undefined {
  if (!ac) return undefined
  return `${ac} is part of this game. ${loader} only works where the game runs without it (offline or single player), and using mods in online play can get an account banned. NexusForge installs it if you want, but does nothing to get past ${ac}.`
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Compares dotted versions ("2026.8.3.0" vs "2026.08.3"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
