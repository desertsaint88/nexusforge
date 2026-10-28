// What the game's last start says about each deployed mod. Only the mod loader's own log counts as evidence:
// it names files as loaded or failed, and the deployment manifest says which mod owns each file. Without such a
// line a mod's runtime state is "unknown" (deployed, not confirmed), never "loaded".

import { basename } from 'node:path'
import type { DeployManifest, InstalledMod, LaunchCheck, ModRuntime } from '@shared/types'

const MAX_EVIDENCE = 8

export function runtimeByMod(manifest: DeployManifest | undefined, mods: InstalledMod[], check: LaunchCheck | undefined): Record<string, ModRuntime> {
  const out: Record<string, ModRuntime> = {}
  if (!manifest) return out
  const owners = new Map<string, Set<string>>()
  for (const e of manifest.entries) {
    out[e.modId] ??= { state: 'unknown', evidence: [] }
    const key = basename(e.rel).toLowerCase()
    const set = owners.get(key) ?? new Set<string>()
    set.add(e.modId)
    owners.set(key, set)
  }
  if (!check?.ran) return out
  const results = [...(check.files ?? [])]
  // Loaders that only list loaded files by name (Script Hook V's "Registering script 'X.asi'").
  for (const name of check.loaded) if (owners.has(name.toLowerCase()) && !results.some((r) => r.file.toLowerCase() === name.toLowerCase())) results.push({ file: name, ok: true, evidence: [`listed as loaded: ${name}`] })
  const deployed = mods.filter((m) => out[m.id])
  for (const f of results) {
    const ids = f.byName ? byPluginName(f.file, deployed) : [...(owners.get(f.file.toLowerCase()) ?? [])]
    for (const modId of ids) {
      const mod = mods.find((m) => m.id === modId)
      if (mod && check.at && check.at < mod.updatedAt) {
        out[modId] = { state: 'unknown', at: check.at, logFile: check.logFile, evidence: ['The last start was before this mod was installed or updated; start the game again to check it.'] }
        continue
      }
      const r = out[modId] ?? { state: 'unknown', evidence: [] }
      if (!f.ok) {
        r.state = 'failed'
        if (f.needs) r.needs = f.needs
      } else if (r.state !== 'failed') r.state = 'loaded'
      for (const line of f.evidence) if (r.evidence.length < MAX_EVIDENCE && !r.evidence.includes(`${f.file}: ${line}`)) r.evidence.push(`${f.file}: ${line}`)
      r.at = check.at
      r.logFile = check.logFile
      out[modId] = r
    }
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Mods a plugin display name from a loader log ("Medical Brutalism 4.7.10") belongs to: the mod's version must be
 * the one in the log and its name must contain the plugin's name. Anything looser is not evidence.
 */
function byPluginName(display: string, mods: InstalledMod[]): string[] {
  const m = display.match(/^(.*?)\s+v?(\d+(?:\.\d+)+)$/)
  if (!m) return []
  const [, name, version] = m
  const n = norm(name)
  if (n.length < 4) return []
  return mods.filter((x) => x.version && x.version.replace(/^v/i, '') === version && norm(x.name).includes(n)).map((x) => x.id)
}

/** The newest loader requirement the last start reported ("Script Hook V .NET API 3.7.0"), per loader. */
export function runtimeNeeds(check: LaunchCheck | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of check?.files ?? []) {
    if (!f.needs) continue
    const cur = out[f.needs.loaderId]
    if (!cur || versionGreater(f.needs.version, cur)) out[f.needs.loaderId] = f.needs.version
  }
  return out
}

function versionGreater(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}
