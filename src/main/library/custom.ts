import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { DetectedGame } from '@shared/types'
import { isDir, safeReaddir } from '../util/fs'
import { findExecutables, isExcludedExe } from './exe-detect'

const SCENE_TAGS = /[-_.\s](codex|skidrow|empress|rune|tenoke|flt|plaza|cpy|reloaded|hoodlum|razor1911|prophet|darksiders|goldberg|elamigos|fitgirl|dodi|gog|repack|ankergames|steamrip|online-fix|multi\d+|x64)\b.*$/i

/** "The.Witcher.3.Wild.Hunt-GOG [v4.04]" -> "The Witcher 3 Wild Hunt" */
export function cleanGameName(folder: string): string {
  let name = folder
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*(?:repack|fitgirl|dodi|v\d|build|update|edition by)[^)]*)\)/gi, ' ')
    .replace(SCENE_TAGS, '')
  // "Grand-Theft-Auto-V" / "The.Witcher.3" -> spaces, but keep single separators like "Half-Life" or "BeamNG.drive".
  if (!/\s/.test(name) && (name.match(/[._-]/g)?.length ?? 0) >= 2) name = name.replace(/[._-]/g, ' ')
  name = name.replace(/\s+v?\d+(\.\d+){1,3}[a-z]?\s*$/i, '').replace(/\s{2,}/g, ' ').trim()
  return name || folder
}

export function customGameId(dir: string): string {
  return `custom:${createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12)}`
}

async function hasDirectExe(dir: string): Promise<boolean> {
  return (await safeReaddir(dir)).some((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !isExcludedExe(e.name))
}

async function gameFromDir(dir: string): Promise<DetectedGame | undefined> {
  const name = cleanGameName(basename(dir))
  const exes = await findExecutables(dir, name)
  if (!exes.length) return undefined
  const exe = exes[0].path
  return {
    id: customGameId(dir),
    name,
    platform: 'custom',
    installDir: dir,
    exePath: exe,
    launch: { kind: 'exe', exe },
    art: { capsule: [], hero: [], header: [], logo: [] }
  }
}

/**
 * Each sub folder of a custom root is treated as a game. A folder that holds no executable itself but
 * whose children do (e.g. "Old drive backup/<games>") is treated as a container and expanded once.
 */
export async function scanCustomFolders(roots: string[], skipDirs: Set<string>): Promise<DetectedGame[]> {
  const games: DetectedGame[] = []
  const seen = new Set<string>()
  const add = (g: DetectedGame | undefined) => {
    if (!g || seen.has(g.installDir.toLowerCase()) || skipDirs.has(g.installDir.toLowerCase())) return
    seen.add(g.installDir.toLowerCase())
    games.push(g)
  }
  for (const root of roots) {
    if (!(await isDir(root))) continue
    if (await hasDirectExe(root)) {
      add(await gameFromDir(root))
      continue
    }
    for (const e of await safeReaddir(root)) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue
      const dir = join(root, e.name)
      if (skipDirs.has(dir.toLowerCase())) continue
      const shallow = (await hasDirectExe(dir)) || (await safeReaddir(dir)).some((c) => c.isDirectory() && /^(bin|binaries|game|x64|win64)$/i.test(c.name))
      if (shallow) {
        add(await gameFromDir(dir))
        continue
      }
      const children = (await safeReaddir(dir)).filter((c) => c.isDirectory())
      const childGames: DetectedGame[] = []
      for (const c of children.slice(0, 60)) {
        const childDir = join(dir, c.name)
        if (await hasDirectExe(childDir)) {
          const g = await gameFromDir(childDir)
          if (g) childGames.push(g)
        }
      }
      if (childGames.length >= 2) childGames.forEach(add)
      else add(await gameFromDir(dir))
    }
  }
  return games
}
