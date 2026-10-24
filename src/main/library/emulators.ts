// Console games played through an emulator: disc images in the game folders (or in the emulator's own game list)
// become library entries that start the emulator with the image. Only emulators that are installed are used.

import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import type { DetectedGame } from '@shared/types'
import { isDir, safeReaddir } from '../util/fs'
import { customGameId } from './custom'

export interface Emulator {
  id: string
  name: string
  /** Short system name shown after the game name. */
  system: string
  /** libretro-thumbnails system folder, for box art. */
  thumbnails: string
  exeNames: string[]
  /** Folders (under Program Files / LocalAppData\\Programs) the emulator installs into. */
  installDirs: string[]
  extensions: string[]
  /** Folder names that say which system the images in them belong to. */
  folderHint: RegExp
  args(image: string): string[]
}

export const EMULATORS: Emulator[] = [
  {
    id: 'pcsx2',
    name: 'PCSX2',
    system: 'PS2',
    thumbnails: 'Sony - PlayStation 2',
    exeNames: ['pcsx2-qt.exe', 'pcsx2-qtx64.exe', 'pcsx2-qtx64-avx2.exe', 'pcsx2.exe'],
    installDirs: ['PCSX2'],
    extensions: ['.iso', '.chd', '.cso', '.zso', '.gz', '.mdf', '.cue'],
    folderHint: /^(ps2|playstation ?2|sony - playstation 2|pcsx2)$/i,
    args: (image) => ['-batch', '--', image]
  },
  {
    id: 'duckstation',
    name: 'DuckStation',
    system: 'PS1',
    thumbnails: 'Sony - PlayStation',
    exeNames: ['duckstation-qt-x64-ReleaseLTCG.exe', 'duckstation-qt.exe', 'duckstation.exe'],
    installDirs: ['DuckStation'],
    extensions: ['.cue', '.chd', '.pbp', '.m3u', '.ecm'],
    folderHint: /^(ps1|psx|playstation ?1?|sony - playstation)$/i,
    args: (image) => ['-batch', '--', image]
  },
  {
    id: 'ppsspp',
    name: 'PPSSPP',
    system: 'PSP',
    thumbnails: 'Sony - PlayStation Portable',
    exeNames: ['PPSSPPWindows64.exe', 'PPSSPPWindows.exe'],
    installDirs: ['PPSSPP'],
    extensions: ['.iso', '.cso', '.pbp', '.chd'],
    folderHint: /^(psp|playstation portable|sony - playstation portable)$/i,
    args: (image) => [image]
  },
  {
    id: 'dolphin',
    name: 'Dolphin',
    system: 'GameCube/Wii',
    thumbnails: 'Nintendo - GameCube',
    exeNames: ['Dolphin.exe'],
    installDirs: ['Dolphin', 'Dolphin-x64', 'Dolphin Emulator'],
    extensions: ['.iso', '.gcm', '.rvz', '.wbfs', '.ciso', '.gcz', '.wad'],
    folderHint: /^(gc|gamecube|wii|nintendo - gamecube|nintendo - wii|dolphin)$/i,
    args: (image) => ['-b', '-e', image]
  }
]

/** Smallest size that counts as a disc image (filters out .gz logs, tiny .cue sheets are allowed). */
const MIN_IMAGE_BYTES = 16 * 1024 * 1024

async function findInDir(dir: string, names: string[]): Promise<string | undefined> {
  const entries = await safeReaddir(dir)
  for (const n of names) {
    const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === n.toLowerCase())
    if (hit) return join(dir, hit.name)
  }
  return undefined
}

/** Installed emulators: standard install folders, plus portable copies inside the given game roots. */
export async function findEmulators(gameRoots: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const programDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[]
  for (const emu of EMULATORS) {
    for (const base of programDirs) {
      for (const d of emu.installDirs) {
        const exe = await findInDir(join(base, d), emu.exeNames)
        if (exe) {
          found.set(emu.id, exe)
          break
        }
      }
      if (found.has(emu.id)) break
    }
    if (found.has(emu.id)) continue
    // Portable copies: "<root>/PCSX2/pcsx2-qt.exe" or "<root>/Emulators/PCSX2/…".
    for (const root of gameRoots) {
      for (const e of await safeReaddir(root)) {
        if (!e.isDirectory()) continue
        const dir = join(root, e.name)
        const direct = await findInDir(dir, emu.exeNames)
        if (direct) {
          found.set(emu.id, direct)
          break
        }
        if (/^emulators?$/i.test(e.name)) {
          for (const c of await safeReaddir(dir)) {
            const exe = c.isDirectory() ? await findInDir(join(dir, c.name), emu.exeNames) : undefined
            if (exe) {
              found.set(emu.id, exe)
              break
            }
          }
        }
      }
      if (found.has(emu.id)) break
    }
  }
  return found
}

/** Game folders the emulators themselves are told about (PCSX2's game list). */
export async function emulatorGameDirs(): Promise<RomDir[]> {
  const out: RomDir[] = []
  const ini = join(homedir(), 'Documents', 'PCSX2', 'inis', 'PCSX2.ini')
  const text = await fsp.readFile(ini, 'utf8').catch(() => '')
  const section = text.match(/\[GameList\]([\s\S]*?)(?:\r?\n\[|$)/)?.[1] ?? ''
  for (const m of section.matchAll(/^\s*(?:Recursive)?Paths\s*=\s*(.+)$/gim)) {
    const p = m[1].trim()
    if (p && (await isDir(p))) out.push({ dir: p, emulator: 'pcsx2' })
  }
  return out
}

/** "Jak II - Renegade (Europe, Australia) (En,Ja,Fr,De).iso" -> "Jak II - Renegade" */
export function romTitle(file: string): string {
  const stem = basename(file, extname(file))
  const clean = stem
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return clean || stem
}

function emulatorFor(file: string, folderNames: string[], installed: Map<string, string>, forced?: string): Emulator | undefined {
  const ext = extname(file).toLowerCase()
  const candidates = EMULATORS.filter((e) => installed.has(e.id) && e.extensions.includes(ext))
  if (!candidates.length) return undefined
  if (forced) return candidates.find((e) => e.id === forced)
  const hinted = candidates.find((e) => folderNames.some((n) => e.folderHint.test(n)))
  if (hinted) return hinted
  // Without a hint the image is only used when exactly one installed emulator reads that format.
  return candidates.length === 1 ? candidates[0] : undefined
}

async function imagesIn(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length > 500) return
  for (const e of await safeReaddir(dir)) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.')) await imagesIn(p, depth - 1, out)
      continue
    }
    if (!e.isFile()) continue
    const ext = extname(e.name).toLowerCase()
    if (!EMULATORS.some((x) => x.extensions.includes(ext))) continue
    if (ext !== '.cue' && ext !== '.m3u') {
      const size = (await fsp.stat(p).catch(() => undefined))?.size ?? 0
      if (size < MIN_IMAGE_BYTES) continue
    }
    out.push(p)
  }
}

export function libretroBoxart(emu: Emulator, image: string): string {
  const name = basename(image, extname(image)).replace(/[&*/:`<>?\\|"]/g, '_')
  return `https://thumbnails.libretro.com/${encodeURIComponent(emu.thumbnails)}/Named_Boxarts/${encodeURIComponent(name)}.png`
}

/** A folder to look for disc images in; `emulator` = every image there belongs to that emulator (its own game list). */
export interface RomDir {
  dir: string
  emulator?: string
}

/**
 * Disc images in folders that hold no PC game (e.g. "C:\\Games\\PS2") and in the emulators' own game folders,
 * searched two levels deep.
 */
export async function scanEmulatorGames(dirs: RomDir[], installed: Map<string, string>): Promise<DetectedGame[]> {
  if (!installed.size) return []
  const games: DetectedGame[] = []
  const seen = new Set<string>()
  for (const { dir, emulator } of dirs) {
    if (!(await isDir(dir))) continue
    const images: string[] = []
    await imagesIn(dir, 2, images)
    // A .cue next to its .bin, or an .m3u listing several discs, stands for the whole game.
    const cues = new Set(images.filter((i) => /\.(cue|m3u)$/i.test(i)).map((i) => join(dirname(i), basename(i, extname(i))).toLowerCase()))
    for (const image of images) {
      if (seen.has(image.toLowerCase())) continue
      if (/\.bin$/i.test(image) && cues.has(join(dirname(image), basename(image, extname(image))).toLowerCase())) continue
      const folders = dirname(image).split(/[\\/]/).slice(-3)
      // An unmarked image next to a PC executable is more likely a PC game's disc than a console game.
      if (!emulator && !EMULATORS.some((e) => folders.some((n) => e.folderHint.test(n)))) {
        if ((await safeReaddir(dirname(image))).some((e) => e.isFile() && /\.exe$/i.test(e.name))) continue
      }
      const emu = emulatorFor(image, folders, installed, emulator)
      if (!emu) continue
      seen.add(image.toLowerCase())
      const exe = installed.get(emu.id)!
      const art = libretroBoxart(emu, image)
      games.push({
        id: customGameId(image),
        name: `${romTitle(image)} (${emu.system})`,
        platform: 'custom',
        installDir: dirname(image),
        exePath: exe,
        launch: { kind: 'exe', exe, args: emu.args(image), cwd: dirname(exe) },
        art: { capsule: [art], hero: [], header: [], logo: [] },
        emulator: emu.name
      })
    }
  }
  return games
}
