// The two lists ReShade's own setup downloads from github.com/crosire/reshade-shaders (branch "list"):
//   Compatibility.ini   per game executable: the graphics API, depth buffer settings, a sub folder to install into,
//                       and games whose anti-cheat bans ReShade ("Banned=1": the setup refuses to install there)
//   EffectPackages.ini  the shader collections the setup offers (download URL, where they go, effects to leave out)
// NexusForge reads the same lists so it sets ReShade up exactly as the setup would. Both are kept on disk, so an
// install still works offline with the last copy.

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IntegrationEnv } from '../integrations/types'
import { parseListIni } from './ini'

export const LIST_BASE = 'https://raw.githubusercontent.com/crosire/reshade-shaders/list'

export type CompatApi = 'D3D8' | 'D3D9' | 'D3D10' | 'D3D11' | 'D3D12' | 'DXGI' | 'DDraw' | 'OpenGL' | 'Vulkan'

export interface CompatEntry {
  exe: string
  renderApi?: CompatApi
  banned?: boolean
  installTarget?: string
  is64Bit?: boolean
  forceInstallApi?: boolean
  /** Raw values (DepthReversed, DepthCopyBeforeClears, …) as the list states them. */
  values: Record<string, string>
}

export interface EffectPackage {
  /** Section name in EffectPackages.ini ("00", "01", …). */
  id: string
  name: string
  description: string
  /** Always installed by the setup (the standard effects). */
  required: boolean
  /** Ticked by default in the setup. */
  enabled: boolean
  /** Where the shaders go, relative to ReShade's folder (".\reshade-shaders\Shaders\OtisFX"). */
  installPath: string
  textureInstallPath: string
  downloadUrl: string
  repositoryUrl?: string
  /** The effects the package offers (used to find the package a preset needs). */
  effectFiles: string[]
  /** Effects the setup deletes after extraction. */
  denyEffectFiles: string[]
}

export function parseCompatibility(text: string): Map<string, CompatEntry> {
  const out = new Map<string, CompatEntry>()
  for (const s of parseListIni(text)) {
    const v = s.values
    out.set(s.name.toLowerCase(), {
      exe: s.name,
      renderApi: v.RenderApi as CompatApi | undefined,
      banned: v.Banned === '1',
      installTarget: v.InstallTarget || undefined,
      is64Bit: v.Is64Bit === undefined ? undefined : v.Is64Bit === '1',
      forceInstallApi: v.ForceInstallApi === '1',
      values: v
    })
  }
  return out
}

const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

export function parseEffectPackages(text: string): EffectPackage[] {
  return parseListIni(text)
    .filter((s) => s.values.PackageName && s.values.DownloadUrl)
    .map((s) => ({
      id: s.name,
      name: s.values.PackageName,
      description: s.values.PackageDescription ?? '',
      required: s.values.Required === '1',
      enabled: s.values.Enabled === '1' || s.values.Required === '1',
      installPath: s.values.InstallPath || '.\\reshade-shaders\\Shaders',
      textureInstallPath: s.values.TextureInstallPath || '.\\reshade-shaders\\Textures',
      downloadUrl: s.values.DownloadUrl,
      repositoryUrl: s.values.RepositoryUrl,
      effectFiles: list(s.values.EffectFiles),
      denyEffectFiles: list(s.values.DenyEffectFiles)
    }))
}

const memory = new Map<string, { at: number; text: string }>()

/** A list file: memory (6 h), else the network, else the copy saved on disk last time. */
async function listText(env: Pick<IntegrationEnv, 'fetchText' | 'workDir'>, name: string): Promise<string | undefined> {
  const hit = memory.get(name)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.text
  const file = join(env.workDir, 'reshade', 'lists', name)
  try {
    const text = await env.fetchText(`${LIST_BASE}/${name}`)
    if (!/^\s*[[#]/m.test(text)) throw new Error('not an ini file')
    memory.set(name, { at: Date.now(), text })
    await fsp.mkdir(dirname(file), { recursive: true }).catch(() => {})
    await fsp.writeFile(file, text).catch(() => {})
    return text
  } catch {
    try {
      const text = await fsp.readFile(file, 'utf8')
      memory.set(name, { at: Date.now() - 5.5 * 3600_000, text })
      return text
    } catch {
      return undefined
    }
  }
}

export async function compatibilityList(env: Pick<IntegrationEnv, 'fetchText' | 'workDir'>): Promise<Map<string, CompatEntry>> {
  const text = await listText(env, 'Compatibility.ini')
  return text ? parseCompatibility(text) : new Map()
}

export async function compatFor(env: Pick<IntegrationEnv, 'fetchText' | 'workDir'>, exeName: string): Promise<CompatEntry | undefined> {
  return (await compatibilityList(env)).get(exeName.toLowerCase())
}

export async function effectPackages(env: Pick<IntegrationEnv, 'fetchText' | 'workDir'>): Promise<EffectPackage[]> {
  const text = await listText(env, 'EffectPackages.ini')
  return text ? parseEffectPackages(text) : []
}

/** For tests. */
export function clearListCache(): void {
  memory.clear()
}

/** The package that offers an effect file, from the setup's list. */
export function packageForEffect(packages: EffectPackage[], effect: string): EffectPackage | undefined {
  const e = effect.toLowerCase()
  return packages.find((p) => p.effectFiles.some((f) => f.toLowerCase() === e)) ?? undefined
}
