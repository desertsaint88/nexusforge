// Expands an installed mod's routes into the files it puts into each deploy target (pure Node).

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { InstalledMod, ModRoute } from '@shared/types'
import type { PlanFile } from './plan'
import { walkFiles } from '../util/fs'

export function routesOf(mod: Pick<InstalledMod, 'routes' | 'rootPath'>): ModRoute[] {
  return mod.routes ?? [{ from: mod.rootPath, target: 'game', to: '' }]
}

export async function planFilesFor(mod: Pick<InstalledMod, 'routes' | 'rootPath' | 'stagingDir' | 'skipped'>): Promise<PlanFile[]> {
  const skip = (mod.skipped ?? []).map((s) => s.path.replace(/\\/g, '/').toLowerCase().replace(/^\.$/, ''))
  const skipped = (rel: string) => {
    const r = rel.toLowerCase()
    return skip.some((s) => s === '' || r === s || r.startsWith(`${s}/`))
  }
  const out: PlanFile[] = []
  for (const r of routesOf(mod)) {
    const from = r.from.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const abs = join(mod.stagingDir, ...from.split('/').filter(Boolean))
    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      continue
    }
    if (st.isFile()) {
      if (!skipped(from)) out.push({ target: r.target, rel: r.to || basename(from), source: abs, size: st.size })
      continue
    }
    for (const f of await walkFiles(abs)) {
      const inStaging = from ? `${from}/${f.rel}` : f.rel
      if (skipped(inStaging)) continue
      out.push({ target: r.target, rel: r.to ? `${r.to.replace(/\/+$/, '')}/${f.rel}` : f.rel, source: f.abs, size: f.size })
    }
  }
  return out
}
