// ReShade.log after a start: whether ReShade was loaded, whether it attached to the game's rendering (it creates a
// "runtime" on the game's swap chain; without one the overlay never shows, usually because the wrong API/DLL name
// was picked), which effects compiled or failed, and which add-ons registered. ReShade rewrites the log at every
// start, so it always describes the last one.
//
// Line format: "08:24:23:773 [25320] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) …"

import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'

export interface ReshadeLog {
  at: number
  version?: string
  bits?: 32 | 64
  /** File ReShade was loaded from ("dxgi.dll", "ReShade64.asi"). */
  module?: string
  exe?: string
  /** ReShade attached to the game's rendering (the overlay can open). */
  runtime: boolean
  /** API the game rendered with, from the calls ReShade redirected. */
  api?: string
  gpu?: string
  compiled: string[]
  failed: Array<{ file: string; errors: string[] }>
  addons: Array<{ name: string; version?: string }>
  errors: string[]
  warnings: string[]
  /** The game was closed normally (ReShade logged its exit). */
  exited: boolean
  /** Still the text ReShade's setup leaves ("…it likely means ReShade was not loaded by the game"): ReShade never ran. */
  placeholder: boolean
}

const LEVEL = /\|\s*(INFO|WARN|ERROR|DEBUG)\s*\|\s?(.*)$/

const API_SIGNS: Array<[RegExp, string]> = [
  [/D3D12CreateDevice|ID3D12CommandQueue/, 'Direct3D 12'],
  [/D3D11CreateDevice(AndSwapChain)?\(|ID3D11Device/, 'Direct3D 11'],
  [/D3D10CreateDevice/, 'Direct3D 10'],
  [/Direct3DCreate9|IDirect3D9/, 'Direct3D 9'],
  [/vkCreateDevice|vkCreateInstance/, 'Vulkan'],
  [/wglCreateContext|wglMakeCurrent/, 'OpenGL']
]

export function parseReshadeLog(text: string, at = 0): ReshadeLog {
  const out: ReshadeLog = { at, runtime: false, compiled: [], failed: [], addons: [], errors: [], warnings: [], exited: false, placeholder: /ReShade was not loaded by the game/i.test(text) && !LEVEL.test(text) }
  let lastFailed: { file: string; errors: string[] } | undefined
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LEVEL)
    if (!m) {
      // Compiler output after "Failed to compile" comes on its own lines.
      if (lastFailed && line.trim() && lastFailed.errors.length < 8) lastFailed.errors.push(line.trim())
      continue
    }
    const [, level, msg] = m
    const init = msg.match(/Initializing crosire's ReShade version '([\d.]+)' \((32|64)-bit\) loaded from '([^']+)'(?: into '([^']+)')?/)
    if (init) {
      out.version = init[1]
      out.bits = init[2] === '32' ? 32 : 64
      out.module = basename(init[3].replace(/\\/g, '/'))
      out.exe = init[4] ? basename(init[4].replace(/\\/g, '/')) : undefined
    }
    if (/(Recreated|Created) runtime environment/i.test(msg)) out.runtime = true
    const gpu = msg.match(/^Running on (.+?)\.?$/)
    if (gpu && !/^Windows\b/i.test(gpu[1])) out.gpu = gpu[1]
    if (!out.api) for (const [re, api] of API_SIGNS) if (re.test(msg)) out.api = api
    const ok = msg.match(/Successfully compiled '([^']+)'/)
    if (ok) {
      const f = basename(ok[1].replace(/\\/g, '/'))
      if (!out.compiled.includes(f)) out.compiled.push(f)
      out.failed = out.failed.filter((x) => x.file !== f)
      lastFailed = undefined
      continue
    }
    const bad = msg.match(/Failed to compile '([^']+)'/)
    if (bad) {
      const f = basename(bad[1].replace(/\\/g, '/'))
      lastFailed = out.failed.find((x) => x.file === f) ?? { file: f, errors: [] }
      if (!out.failed.includes(lastFailed)) out.failed.push(lastFailed)
      out.compiled = out.compiled.filter((x) => x !== f)
      continue
    }
    lastFailed = undefined
    const addon = msg.match(/Registered add-on "([^"]+)"(?: v([\d.]+))?/)
    if (addon && !out.addons.some((a) => a.name === addon[1])) out.addons.push({ name: addon[1], version: addon[2] })
    if (/^Exiting/.test(msg) || /Finished exiting/.test(msg)) out.exited = true
    if (level === 'ERROR' && out.errors.length < 30) out.errors.push(msg.trim())
    else if (level === 'WARN' && out.warnings.length < 30) out.warnings.push(msg.trim())
  }
  return out
}

/** ReShade.log in a folder, when it was written at or after `since` (ms). */
export async function readReshadeLog(file: string, since = 0): Promise<ReshadeLog | undefined> {
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return undefined
    return parseReshadeLog(await fsp.readFile(file, 'utf8'), st.mtimeMs)
  } catch {
    return undefined
  }
}
