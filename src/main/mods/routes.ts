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
  const all = (mod.skipped ?? []).map((s) => ({ path: s.path.replace(/\\/g, '/').toLowerCase().replace(/^\.$/, ''), moved: Boolean(s.moved) }))
  const out: PlanFile[] = []
  for (const r of routesOf(mod)) {
    const from = r.from.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    // A moved file or folder is left out of the other routes, not out of the route that moves it.
    const f = from.toLowerCase()
    const skip = all.filter((s) => !(s.moved && (f === s.path || f.startsWith(`${s.path}/`)))).map((s) => s.path)
    const skipped = (rel: string) => {
      const x = rel.toLowerCase()
      return skip.some((s) => s === '' || x === s || x.startsWith(`${s}/`))
    }
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
