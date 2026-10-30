// Proxy DLLs: how mod loaders get into a game. Windows loads winhttp.dll, version.dll, winmm.dll, dwmapi.dll, …
// from the game's own folder before System32, so a loader ships one of those names and passes the real calls on.
//
// Repacked and cracked copies of games often use the very same names for their own files (Steam and Social Club
// emulators, OnlineFix's winmm.dll "DllLoader", SOVEREIGN's Steamclient proxy). Replacing one of those breaks the
// game, so a loader never takes a name that is already used by something else: NexusForge reads what each DLL is
// and puts the loader under another name it supports (BepInEx: winhttp.dll or version.dll; MelonLoader: a dozen).
// When every supported name is taken, the loader is not installed and the panel says which files are in the way.

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export type ProxyOwner = 'bepinex' | 'melonloader' | 'ue4ss' | 'asi-loader' | 'red4ext' | 'reshade' | 'game' | 'system' | 'other'

export interface ProxyFile {
  name: string
  owner: ProxyOwner
  /** "OnlineFix DllLoader", "Unity Doorstop (BepInEx)" */
  label: string
}

// Strings in the DLLs (version resource or code), checked as ASCII and UTF-16. Order matters: MelonLoader's
// proxy also carries "Microsoft Corporation" (it forwards to the system DLL), so loaders come before "system".
const SIGNS: Array<[RegExp, ProxyOwner, string]> = [
  [/Doorstop|NeighTools/, 'bepinex', 'Unity Doorstop (BepInEx)'],
  [/MelonLoader/, 'melonloader', 'MelonLoader'],
  [/UE4SS/, 'ue4ss', 'UE4SS'],
  [/RED4ext/, 'red4ext', 'RED4ext'],
  [/Ultimate ASI Loader|ThirteenAG/, 'asi-loader', 'Ultimate ASI Loader'],
  [/Alexander Blade/, 'asi-loader', 'ASI Loader (Alexander Blade)'],
  [/ReShade/, 'reshade', 'ReShade'],
  [/\bDXVK\b/, 'other', 'DXVK (Vulkan translation layer)'],
  [/ENBSeries|Boris Vorontsov/, 'other', 'ENBSeries'],
  [/Special K|SpecialK/, 'other', 'Special K'],
  [/Online-?Fix/i, 'game', 'OnlineFix'],
  [/SOVEREIGN/, 'game', 'SOVEREIGN Steamclient proxy'],
  [/socialclub_emu|Social Club/, 'game', 'Social Club emulator'],
  [/Goldberg|SmartSteamEmu|CreamAPI|steam_emu|ScreamAPI|CODEX|EMPRESS|ALI213|Nemirtingas/i, 'game', 'Steam emulator'],
  [/Microsoft Corporation/, 'system', 'a copy of the Windows DLL']
]

/** Searches a file's bytes for ASCII and UTF-16LE text (first 16 MB). */
export async function fileStrings(file: string, max = 16 * 1024 * 1024): Promise<string> {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, max))
    await fh.read(buf, 0, buf.length, 0)
    // Printable runs only: a 10 MB DLL turns into a few hundred kB of text.
    const ascii = buf.toString('latin1').match(/[\x20-\x7e]{4,}/g)?.join('\n') ?? ''
    const wide = (buf.toString('utf16le').match(/[\x20-\x7e]{4,}/g) ?? []).join('\n')
    const odd = buf.length > 1 ? (buf.subarray(1).toString('utf16le').match(/[\x20-\x7e]{4,}/g) ?? []).join('\n') : ''
    return `${ascii}\n${wide}\n${odd}`
  } finally {
    await fh.close()
  }
}

export async function identifyProxy(file: string, name: string): Promise<ProxyFile> {
  let text = ''
  try {
    text = await fileStrings(file)
  } catch {
    return { name, owner: 'other', label: 'an unreadable file' }
  }
  for (const [re, owner, label] of SIGNS) if (re.test(text)) return { name, owner, label }
  return { name, owner: 'other', label: 'an unknown DLL' }
}

/** What sits in each of the given proxy names next to the game's .exe (only names that exist). */
export async function proxyFiles(dir: string, names: string[]): Promise<ProxyFile[]> {
  const out: ProxyFile[] = []
  let entries: string[] = []
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return out
  }
  for (const n of names) {
    const real = entries.find((e) => e.toLowerCase() === n.toLowerCase())
    if (real) out.push(await identifyProxy(join(dir, real), n))
  }
  return out
}

export interface ProxyChoice {
  /** The name the loader goes in under (undefined: every name it supports is taken). */
  name?: string
  /** The loader is already there under this name. */
  existing?: string
  /** Names used by something else (kept as they are). */
  taken: ProxyFile[]
}

/**
 * Picks the name a loader's proxy DLL goes in under: the one it already uses, else the first supported name that
 * is free. `ours` are names NexusForge deployed for this loader (they may be replaced).
 */
export async function chooseProxy(dir: string, names: string[], owner: ProxyOwner, ours: string[] = []): Promise<ProxyChoice> {
  const present = await proxyFiles(dir, names)
  const mine = new Set(ours.map((n) => n.toLowerCase()))
  const existing = present.find((p) => p.owner === owner)?.name
  const taken = present.filter((p) => p.owner !== owner && !mine.has(p.name.toLowerCase()))
  if (existing) return { name: existing, existing, taken }
  const free = names.find((n) => !taken.some((t) => t.name.toLowerCase() === n.toLowerCase()))
  return { name: free, taken }
}

export function describeTaken(taken: ProxyFile[]): string {
  return taken.map((t) => `${t.name} (${t.label})`).join(', ')
}

/** Text for the panel when the loader had to use another name. */
export function proxyNote(loader: string, choice: ProxyChoice, defaultName: string): string | undefined {
  if (!choice.name || choice.name.toLowerCase() === defaultName.toLowerCase() || choice.existing) return undefined
  const blocker = choice.taken.find((t) => t.name.toLowerCase() === defaultName.toLowerCase())
  return `${blocker ? `${blocker.name} in the game folder is ${blocker.label}; it stays as it is. ` : ''}${loader} goes in as ${choice.name} instead.`
}
