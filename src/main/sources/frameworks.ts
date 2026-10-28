// Mod loaders many mods need but that most mod sites only link to: BepInEx and MelonLoader, downloaded from
// their official GitHub releases in the build that fits the game (Unity Mono or IL2CPP, 64- or 32-bit).

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Game, ModDependency, ModDetails, ModSearchResult, ModVersion } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { exists, safeReaddir } from '../util/fs'

export const FRAMEWORKS_ID = 'frameworks'

interface GhAsset {
  name: string
  size: number
  browser_download_url: string
}
interface GhRelease {
  tag_name: string
  name: string
  prerelease: boolean
  draft: boolean
  published_at: string
  html_url: string
  body?: string
  assets: GhAsset[]
}

export type UnityBackend = 'mono' | 'il2cpp'
export interface GameRuntime {
  unity?: UnityBackend
  arch: 'x64' | 'x86'
}

/** Unity backend and bitness of an installed game, read from its files. */
export async function gameRuntime(game: Pick<Game, 'installDir' | 'exePath'>): Promise<GameRuntime> {
  const dir = game.exePath ? dirname(game.exePath) : game.installDir
  let unity: UnityBackend | undefined
  if (await exists(join(dir, 'GameAssembly.dll'))) unity = 'il2cpp'
  else {
    const data = (await safeReaddir(dir)).find((e) => e.isDirectory() && /_Data$/i.test(e.name))
    if (data && (await exists(join(dir, data.name, 'Managed')))) unity = 'mono'
  }
  return { unity, arch: game.exePath ? await peArch(game.exePath) : 'x64' }
}

async function peArch(exe: string): Promise<'x64' | 'x86'> {
  try {
    const fh = await fsp.open(exe, 'r')
    try {
      const dos = Buffer.alloc(64)
      await fh.read(dos, 0, 64, 0)
      const pe = Buffer.alloc(6)
      await fh.read(pe, 0, 6, dos.readUInt32LE(0x3c))
      return pe.readUInt16LE(4) === 0x14c ? 'x86' : 'x64'
    } finally {
      await fh.close()
    }
  } catch {
    return 'x64'
  }
}

interface Framework {
  id: string
  name: string
  repo: string
  summary: string
  url: string
  /** Files inside the game folder that show it's already there (installed by hand). */
  marker: string[]
  /** Which release assets fit this game, best first; undefined = asset not for this game. */
  rank(asset: string, rt: GameRuntime): number | undefined
}

const FRAMEWORKS: Framework[] = [
  {
    id: 'bepinex',
    name: 'BepInEx',
    repo: 'BepInEx/BepInEx',
    summary: 'Plugin loader for Unity games. Most Unity mods (Valheim, Lethal Company, Casualties: Unknown, …) need it.',
    url: 'https://github.com/BepInEx/BepInEx',
    marker: ['BepInEx/core'],
    rank(asset, rt) {
      const archOk = new RegExp(`[-_]${rt.arch}[-_]`, 'i').test(asset)
      if (!archOk || !/win|_x(64|86)_5\./i.test(asset) || !/\.zip$/i.test(asset)) return undefined
      const il2cpp = /il2cpp/i.test(asset)
      const v6mono = /unity\.mono/i.test(asset)
      const v5 = /^BepInEx_(win_)?x(64|86)_5\./i.test(asset)
      if (rt.unity === 'il2cpp') return il2cpp ? 0 : undefined
      if (v5) return 0
      if (v6mono) return 1
      return il2cpp && !rt.unity ? 2 : undefined
    }
  },
  {
    id: 'melonloader',
    name: 'MelonLoader',
    repo: 'LavaGang/MelonLoader',
    summary: 'Mod loader for Unity games (Mono and IL2CPP). Used by many VR and indie game mods.',
    url: 'https://github.com/LavaGang/MelonLoader',
    marker: ['MelonLoader'],
    rank(asset, rt) {
      if (!/^MelonLoader\.x(64|86)\.zip$/i.test(asset)) return undefined
      return asset.toLowerCase().includes(rt.arch) ? 0 : undefined
    }
  },
  // The ones below go where their game integration says (Unreal: Binaries/Win64; Cyberpunk: the game root).
  {
    id: 'ue4ss',
    name: 'UE4SS',
    repo: 'UE4SS-RE/RE-UE4SS',
    summary: 'Script system and mod loader for Unreal Engine 4/5 games (Lua and C++ mods, Blueprint "LogicMods").',
    url: 'https://github.com/UE4SS-RE/RE-UE4SS',
    marker: ['dwmapi.dll'],
    rank: (asset) => (/^UE4SS_v[\d.]+(-\d+-g[0-9a-f]+)?\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'cet',
    name: 'Cyber Engine Tweaks',
    repo: 'maximegmd/CyberEngineTweaks',
    summary: 'Cyberpunk 2077 scripting framework (Lua mods, in-game console and overlay).',
    url: 'https://github.com/maximegmd/CyberEngineTweaks',
    marker: ['plugins/cyber_engine_tweaks.asi'],
    rank: (asset) => (/^cet_[\d._]+\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'red4ext',
    name: 'RED4ext',
    repo: 'WopsS/RED4ext',
    summary: 'Cyberpunk 2077 script extender; ArchiveXL, TweakXL and Codeware run on it.',
    url: 'https://github.com/WopsS/RED4ext',
    marker: ['../../red4ext/RED4ext.dll'],
    rank: (asset) => (/^red4ext[-_][\d.]+\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'redscript',
    name: 'redscript',
    repo: 'jac3km4/redscript',
    summary: 'Compiler for Cyberpunk 2077 script mods (.reds files in r6/scripts).',
    url: 'https://github.com/jac3km4/redscript',
    marker: ['../../engine/tools/scc.exe'],
    rank: (asset) => (/^redscript-v[\d.]+-windows\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'archivexl',
    name: 'ArchiveXL',
    repo: 'psiberx/cp2077-archive-xl',
    summary: 'Cyberpunk 2077 framework for new items, appearances and resources (.xl files).',
    url: 'https://github.com/psiberx/cp2077-archive-xl',
    marker: ['../../red4ext/plugins/ArchiveXL/ArchiveXL.dll'],
    rank: (asset) => (/^ArchiveXL-[\d.]+\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'tweakxl',
    name: 'TweakXL',
    repo: 'psiberx/cp2077-tweak-xl',
    summary: 'Cyberpunk 2077 TweakDB editing (r6/tweaks).',
    url: 'https://github.com/psiberx/cp2077-tweak-xl',
    marker: ['../../red4ext/plugins/TweakXL/TweakXL.dll'],
    rank: (asset) => (/^TweakXL-[\d.]+\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'codeware',
    name: 'Codeware',
    repo: 'psiberx/cp2077-codeware',
    summary: 'Cyberpunk 2077 library many redscript mods build on.',
    url: 'https://github.com/psiberx/cp2077-codeware',
    marker: ['../../red4ext/plugins/Codeware/Codeware.dll'],
    rank: (asset) => (/^Codeware-[\d.]+\.zip$/i.test(asset) ? 0 : undefined)
  },
  {
    id: 'shvdn',
    name: 'Script Hook V .NET',
    repo: 'scripthookvdotnet/scripthookvdotnet',
    summary: 'Runs GTA V scripts written in C# / VB (.dll and .cs files in the scripts folder). Needs Script Hook V.',
    url: 'https://github.com/scripthookvdotnet/scripthookvdotnet',
    marker: ['ScriptHookVDotNet.asi'],
    rank: (asset) => (/^ScriptHookVDotNet\.zip$/i.test(asset) ? 0 : undefined)
  }
]

/** Repository of a known loader (for integrations that install it). */
export function frameworkRepo(id: string): string | undefined {
  return FRAMEWORKS.find((f) => f.id === id)?.repo
}

const byId = (id: string) => FRAMEWORKS.find((f) => f.id === id)

/** Release assets of a loader that fit the game, best first (matching build, then stable, then newest). */
export function fittingAssets<R extends { tag_name: string; prerelease: boolean; published_at: string; assets: Array<{ name: string }> }>(
  frameworkId: string,
  list: R[],
  rt: GameRuntime
): Array<{ release: R; asset: R['assets'][number] }> {
  const f = byId(frameworkId)
  if (!f) return []
  const fits: Array<{ release: R; asset: R['assets'][number]; rank: number }> = []
  for (const r of list) {
    for (const a of r.assets) {
      const rank = f.rank(a.name, rt)
      if (rank !== undefined) fits.push({ release: r, asset: a, rank })
    }
  }
  fits.sort((a, b) => a.rank - b.rank || Number(a.release.prerelease) - Number(b.release.prerelease) || b.release.published_at.localeCompare(a.release.published_at))
  return fits
}

/** Maps a requirement a mod site only links to ("BepInEx", "MelonLoader") onto the built-in installer. */
export function frameworkDependency(dep: ModDependency): ModDependency | undefined {
  if (dep.installable && dep.sourceId) return undefined
  const text = `${dep.name} ${dep.url ?? ''}`
  const names: Array<[RegExp, string]> = [
    [/bepinex/i, 'bepinex'],
    [/melon ?loader/i, 'melonloader'],
    [/ue4ss/i, 'ue4ss'],
    [/cyber ?engine ?tweaks|\bCET\b/i, 'cet'],
    [/red4ext/i, 'red4ext'],
    [/redscript/i, 'redscript'],
    [/archive ?xl/i, 'archivexl'],
    [/tweak ?xl/i, 'tweakxl'],
    [/codeware/i, 'codeware'],
    [/script ?hook ?v ?(\.|dot) ?net|shvdn/i, 'shvdn']
  ]
  const hit = names.find(([re]) => re.test(text))
  const f = hit ? byId(hit[1]) : undefined
  if (!f) return undefined
  return { ...dep, sourceId: FRAMEWORKS_ID, modId: f.id, installable: true, note: dep.note ? `${dep.note} · NexusForge installs it` : 'NexusForge installs the right build for this game' }
}

/** The loader is already in the game folder (for example installed by hand). */
export async function frameworkPresent(game: Game, modId: string): Promise<boolean> {
  const f = byId(modId)
  if (!f) return false
  const dir = game.exePath ? dirname(game.exePath) : game.installDir
  for (const m of f.marker) if (await exists(join(dir, ...m.split('/')))) return true
  return false
}

export function createFrameworksAdapter(ctx: AdapterContext): ModSourceAdapter {
  const cache = new Map<string, { at: number; releases: GhRelease[] }>()
  async function releases(repo: string): Promise<GhRelease[]> {
    const hit = cache.get(repo)
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.releases
    const list = (await ctx.json<GhRelease[]>(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })).filter((r) => !r.draft)
    cache.set(repo, { at: Date.now(), releases: list })
    return list
  }
  const runtime = async (gameId?: string): Promise<GameRuntime> => {
    const game = gameId ? ctx.getGame(gameId) : undefined
    return game ? gameRuntime(game) : { arch: 'x64' }
  }

  const adapter: ModSourceAdapter = {
    id: FRAMEWORKS_ID,
    name: 'Mod loaders',
    description: 'Mod loaders from their official GitHub releases: BepInEx and MelonLoader (in the build that fits the Unity game), UE4SS, Cyber Engine Tweaks, RED4ext, redscript, ArchiveXL, TweakXL, Codeware and Script Hook V .NET. No account needed.',
    homepage: 'https://github.com/BepInEx/BepInEx',

    async search(query): Promise<ModSearchResult[]> {
      const q = query.trim().toLowerCase()
      return FRAMEWORKS.filter((f) => !q || f.name.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q)).map((f) => ({
        id: f.id,
        sourceId: FRAMEWORKS_ID,
        name: f.name,
        summary: f.summary,
        author: f.repo.split('/')[0],
        url: f.url
      }))
    },

    async getModDetails(modId, gameId): Promise<ModDetails> {
      const f = byId(modId)
      if (!f) throw new Error(`Unknown mod loader: ${modId}`)
      const rt = await runtime(gameId)
      const fits: Array<{ v: ModVersion; rank: number; stable: boolean }> = []
      for (const r of await releases(f.repo)) {
        for (const a of r.assets) {
          const rank = f.rank(a.name, rt)
          if (rank === undefined) continue
          fits.push({
            rank,
            stable: !r.prerelease,
            v: {
              id: `${r.tag_name}|${a.name}`,
              name: a.name.replace(/\.zip$/i, ''),
              version: r.tag_name.replace(/^v/i, ''),
              fileName: a.name,
              sizeBytes: a.size,
              date: r.published_at,
              description: r.prerelease ? 'pre-release' : undefined
            }
          })
        }
      }
      // Best fit first: matching family, then stable releases, then newest.
      fits.sort((a, b) => a.rank - b.rank || Number(b.stable) - Number(a.stable) || (b.v.date ?? '').localeCompare(a.v.date ?? ''))
      const versions = fits.map((x, i) => ({ ...x.v, primary: i === 0 }))
      const unityLoader = f.id === 'bepinex' || f.id === 'melonloader'
      const note = !unityLoader
        ? 'NexusForge puts it where this game loads it, under a DLL name no file of the game already uses.'
        : rt.unity === 'il2cpp'
          ? 'This game is a Unity IL2CPP build, so it gets the IL2CPP edition.'
          : rt.unity === 'mono'
            ? 'This game is a Unity Mono build, so it gets the Mono edition.'
            : gameId
              ? 'This doesn\'t look like a Unity game; check the mod page before installing.'
              : ''
      return {
        id: f.id,
        sourceId: FRAMEWORKS_ID,
        name: f.name,
        summary: f.summary,
        author: f.repo.split('/')[0],
        url: f.url,
        description: `${f.summary}\n\n${note}\n\nInstalled into the game folder; NexusForge removes it again when you purge or uninstall.`.trim(),
        images: [],
        versions,
        gameVersions: rt.unity ? [`Unity ${rt.unity === 'il2cpp' ? 'IL2CPP' : 'Mono'} ${rt.arch}`] : undefined
      }
    },

    async getDownloadUrl(modId, versionId) {
      const f = byId(modId)
      if (!f) throw new Error(`Unknown mod loader: ${modId}`)
      const [tag, assetName] = versionId.split('|')
      const rel = (await releases(f.repo)).find((r) => r.tag_name === tag)
      const asset = rel?.assets.find((a) => a.name === assetName)
      if (!asset) throw new Error(`${f.name} ${tag} has no file ${assetName}.`)
      return asset.browser_download_url
    },

    getModPageUrl(modId) {
      return byId(modId)?.url
    }
  }
  return adapter
}
