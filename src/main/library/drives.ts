// Finds the folders games live in on every local drive, so nothing depends on the user listing them:
// "Games"-style folders at a drive's root, Steam libraries Steam doesn't know about (copied or moved drives),
// and the default install folders of the other launchers.

import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { isDir, safeReaddir } from '../util/fs'
import { run } from '../util/exec'

/** Folder names at a drive root that hold games. */
const ROOT_NAMES = /^(games?|spiele|gaming|my games|pc ?games|game ?library|installed games|steamlibrary|steam ?library|steam ?games|epic ?games|gog ?games|ea ?games|origin ?games|ubisoft ?games|rockstar ?games|riot ?games|amazon ?games)$/i

/** Launcher install folders (relative to a Program Files folder) whose children are games. */
const LAUNCHER_DIRS = [
  'Epic Games',
  'GOG Galaxy\\Games',
  'GOG Games',
  'EA Games',
  'Origin Games',
  'Electronic Arts',
  'Ubisoft\\Ubisoft Game Launcher\\games',
  'Rockstar Games',
  'Riot Games',
  'Amazon Games\\Library',
  'Steam\\steamapps\\common'
]

/** Children of the folders above that are launchers, runtimes or tools rather than games. */
export const NON_GAME_DIR =
  /^(launcher|directxredist|directx|epic online services|social club|riot client|ea desktop|ea app|origin|uplay|ubisoft connect|steamworks shared|steamvr|steam controller configs|_?common ?redist|redist|redistributables?|vcredist|dotnet|prereqs?|support|tools|sdk|dedicated server|gamesave|\.gamingroot)$/i

/** Local fixed and removable drives ("C:\\", "E:\\"); network drives are skipped because scanning them is slow. */
export async function localDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const ps = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | ForEach-Object { $_.DeviceID }'],
    { timeoutMs: 15_000 }
  )
  const listed = ps.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Z]:$/i.test(l))
  if (ps.code === 0 && listed.length) return listed.map((d) => `${d.toUpperCase()}\\`)
  // Fallback: probe every letter (includes mapped network drives, but only ones that answer quickly).
  const out: string[] = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    const ok = await Promise.race([fsp.access(root).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))])
    if (ok) out.push(root)
  }
  return out
}

async function steamCommon(dir: string): Promise<string | undefined> {
  const common = join(dir, 'steamapps', 'common')
  return (await isDir(common)) ? common : undefined
}

/**
 * Game folders on one drive. `dirs` are scanned like custom folders (each child is a game, containers are
 * expanded); nothing here is ever written to.
 */
export async function gameRootsOnDrive(drive: string): Promise<string[]> {
  const roots: string[] = []
  const add = (p: string | undefined) => {
    if (p && !roots.some((r) => r.toLowerCase() === p.toLowerCase())) roots.push(p)
  }
  const top = (await safeReaddir(drive)).filter((e) => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('.'))
  for (const e of top) {
    const dir = join(drive, e.name)
    if (/^program files( \(x86\))?$|^programme$/i.test(e.name)) {
      for (const rel of LAUNCHER_DIRS) {
        const p = join(dir, rel)
        if (await isDir(p)) add(p)
      }
      continue
    }
    if (/^(windows|users|programdata|perflogs|recovery|system volume information|xboxgames|msocache|intel|amd|nvidia|drivers|inetpub|onedrivetemp)$/i.test(e.name)) continue
    // A Steam library at the root ("E:\\SteamLibrary") or one level down ("E:\\Games\\Steam").
    const common = await steamCommon(dir)
    if (common) {
      add(common)
      continue
    }
    if (!ROOT_NAMES.test(e.name)) continue
    add(dir)
    for (const c of await safeReaddir(dir)) {
      if (!c.isDirectory()) continue
      add(await steamCommon(join(dir, c.name)))
    }
  }
  return roots
}

/** Game folders on every local drive. */
export async function findGameRoots(drives?: string[]): Promise<string[]> {
  const out: string[] = []
  for (const d of drives ?? (await localDrives())) {
    for (const r of await gameRootsOnDrive(d).catch(() => [] as string[])) {
      if (!out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r)
    }
  }
  return out
}
