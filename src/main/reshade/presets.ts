// ReShade presets: .ini files that list the techniques to switch on ("Techniques=SMAA@SMAA.fx,LumaSharpen@…")
// and one [Effect.fx] section of settings per effect. A preset only works when every effect it names is in one of
// ReShade's effect search paths, so NexusForge checks that and names the official package that has a missing one.

import { promises as fsp } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { IniDoc } from './ini'
import { safeReaddir, walkFiles } from '../util/fs'

export const PRESET_TECHNIQUES = /^Techniques=/m
export const PRESET_FX_SECTION = /^\[[^\]\r\n]+\.fx\]/m

/** The text is a ReShade preset (a technique list, or settings for at least one effect). */
export function isPresetText(text: string): boolean {
  return PRESET_TECHNIQUES.test(text) && (PRESET_FX_SECTION.test(text) || /^Techniques=\S*@\S+\.fx/im.test(text))
}

export interface PresetInfo {
  /** Techniques switched on ("SMAA@SMAA.fx" -> technique SMAA from SMAA.fx). */
  techniques: Array<{ name: string; file?: string }>
  /** Effect files the preset needs: those of active techniques, plus files it has settings for. */
  effects: string[]
}

export function parsePreset(text: string): PresetInfo {
  const doc = IniDoc.parse(text)
  const raw = doc.get('', 'Techniques') ?? ''
  const techniques = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const [name, file] = t.split('@')
      return { name: name.trim(), file: file?.trim() || undefined }
    })
  const effects = new Set<string>()
  for (const t of techniques) if (t.file) effects.add(t.file)
  return { techniques, effects: [...effects] }
}

/** Effect files (.fx) under ReShade's folder, by lower-case file name. */
export async function effectFilesIn(dir: string, searchPaths: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const sp of searchPaths) {
    const recursive = /\*\*$/.test(sp.trim())
    const rel = sp.trim().replace(/\\?\*\*?$/, '').replace(/^\.[\\/]/, '').replace(/[\\/]+$/, '')
    const abs = /^[a-z]:[\\/]/i.test(rel) ? rel : join(dir, ...rel.split(/[\\/]/).filter(Boolean))
    if (recursive) {
      for (const f of await walkFiles(abs, { maxDepth: 8, limit: 20_000 })) if (/\.fx$/i.test(f.rel)) out.add(basename(f.rel).toLowerCase())
    } else {
      for (const e of await safeReaddir(abs)) if (e.isFile() && /\.fx$/i.test(e.name)) out.add(e.name.toLowerCase())
    }
  }
  return out
}

export interface FoundPreset {
  /** Path relative to ReShade's folder, as ReShade.ini's PresetPath writes it (".\Cinematic.ini"). */
  path: string
  abs: string
  name: string
  info: PresetInfo
}

const NOT_PRESETS = /^(reshade|reshade\d*|desktop|socialclub_emu|steam_emu|steam_api|ScriptHookV(DotNet)?|version|config|settings|launcher)\.ini$/i

/** Presets next to ReShade and in the folders presets are usually kept in (two levels deep at most). */
export async function findPresets(dir: string): Promise<FoundPreset[]> {
  const out: FoundPreset[] = []
  const visit = async (d: string, depth: number) => {
    for (const e of await safeReaddir(d)) {
      const abs = join(d, e.name)
      if (e.isDirectory()) {
        if (depth < 2 && /preset|reshade/i.test(e.name) && !/^reshade-shaders$/i.test(e.name)) await visit(abs, depth + 1)
        continue
      }
      if (!e.isFile() || !/\.ini$/i.test(e.name) || NOT_PRESETS.test(e.name)) continue
      let text = ''
      try {
        const st = await fsp.stat(abs)
        if (st.size > 2 * 1024 * 1024) continue
        text = await fsp.readFile(abs, 'utf8')
      } catch {
        continue
      }
      if (!isPresetText(text) && !/^reshadepreset\.ini$/i.test(e.name)) continue
      out.push({ path: `.\\${relative(dir, abs)}`, abs, name: e.name.replace(/\.ini$/i, ''), info: parsePreset(text) })
    }
  }
  await visit(dir, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
