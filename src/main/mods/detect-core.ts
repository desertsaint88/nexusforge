// Finds the mods that are installed in a game, whether NexusForge put them there or not: it reads the files mod
// loaders and games leave behind (Thunderstore manifests, GMA headers, BeamNG's db.json, BO3's workshop.json,
// DLL version info, Steam's Workshop list) and recognizes the folder layouts of the common mod systems.
// It also decides whether a game can be modded at all, for the library's badges.
// Pure file reading (no Electron), so it can be tested on fake game folders; detect.ts adds caching.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { DetectedMod, Game, GameModInfo } from '@shared/types'
import { exists, readJson, safeReaddir } from '../util/fs'
import { findPreset, presetTarget } from '../library/presets'
import { readVersionStrings } from '../library/exe-version'
import { parseVdf, vget, type VdfObject } from '../library/vdf'

interface Entry {
  name: string
  abs: string
  dir: boolean
}

/** Directory listing that follows symlinks (NexusForge deploys files as links). */
async function list(dir: string): Promise<Entry[]> {
  const out: Entry[] = []
  for (const e of await safeReaddir(dir)) {
    const abs = join(dir, e.name)
    let isDirectory = e.isDirectory()
    if (e.isSymbolicLink()) {
      try {
        isDirectory = (await fsp.stat(abs)).isDirectory()
      } catch {
        continue // dangling link
      }
    } else if (!isDirectory && !e.isFile()) continue
    out.push({ name: e.name, abs, dir: isDirectory })
  }
  return out
}

async function findDir(dir: string, name: string): Promise<string | undefined> {
  const hit = (await list(dir)).find((e) => e.dir && e.name.toLowerCase() === name.toLowerCase())
  return hit?.abs
}

/** "amogus_gun" -> "Amogus Gun", "CrashHard20.zip" -> "CrashHard20". */
export function prettyName(raw: string): string {
  const s = raw
    .replace(/(\.(zip|pak|gma|dll|jar|esp|esm|esl|asi|lua|disabled|old|bak))+$/gi, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return s === s.toLowerCase() ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s
}

const isDisabledName = (n: string) => /\.(disabled|old|bak|off)$/i.test(n)

interface Ctx {
  game: Game
  roots: string[]
  mods: DetectedMod[]
  support: Set<string>
  add(m: Omit<DetectedMod, 'key'>): void
}

// ---------------------------------------------------------------------------
// Mod loaders (BepInEx, MelonLoader, UE4SS, script hooks, ReShade)

async function dllInfo(file: string): Promise<{ name?: string; version?: string; author?: string }> {
  const v = await readVersionStrings(file)
  const name = [v?.productName, v?.fileDescription].find((x) => x && !/^(assembly|class library|\s*)$/i.test(x))
  return { name, version: v?.version?.replace(/(\.0)+$/, ''), author: v?.companyName && !/^(microsoft|\s*)$/i.test(v.companyName) ? v.companyName : undefined }
}

async function detectBepInEx(ctx: Ctx, root: string): Promise<void> {
  const bep = await findDir(root, 'BepInEx')
  if (!bep) return
  const core = join(bep, 'core', 'BepInEx.dll')
  const coreInfo = (await exists(core)) ? await dllInfo(core) : {}
  ctx.add({ name: 'BepInEx', kind: 'loader', path: bep, version: coreInfo.version, detectedBy: 'folder layout' })
  ctx.support.add('BepInEx installed')
  const plugins = await findDir(bep, 'plugins')
  if (!plugins) return
  for (const e of await list(plugins)) {
    if (e.dir) {
      const manifest = await readJson<{ name?: string; version_number?: string; author?: string; website_url?: string }>(join(e.abs, 'manifest.json'))
      // Thunderstore installs packages into "Author-Name" folders.
      const ts = e.name.match(/^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/)
      if (manifest?.name) {
        ctx.add({
          name: manifest.name.replace(/_/g, ' '),
          kind: 'bepinex',
          path: e.abs,
          version: manifest.version_number,
          author: manifest.author ?? ts?.[1],
          source: ts ? { sourceId: 'thunderstore', modId: `${ts[1]}/${ts[2]}` } : undefined,
          detectedBy: 'manifest.json'
        })
        continue
      }
      const dll = (await list(e.abs)).find((f) => !f.dir && /\.dll$/i.test(f.name))
      const info = dll ? await dllInfo(dll.abs) : {}
      ctx.add({ name: info.name ?? prettyName(ts ? ts[2] : e.name), kind: 'bepinex', path: e.abs, version: info.version, author: ts?.[1] ?? info.author, source: ts ? { sourceId: 'thunderstore', modId: `${ts[1]}/${ts[2]}` } : undefined, detectedBy: dll ? 'file version' : 'folder layout' })
    } else if (/\.dll(\.(disabled|old))?$/i.test(e.name)) {
      const info = await dllInfo(e.abs)
      ctx.add({ name: info.name ?? prettyName(e.name), kind: 'bepinex', path: e.abs, version: info.version, author: info.author, enabled: !isDisabledName(e.name), detectedBy: info.name ? 'file version' : 'file name' })
    }
  }
}

async function detectMelonLoader(ctx: Ctx, root: string): Promise<void> {
  const ml = await findDir(root, 'MelonLoader')
  if (!ml) return
  const dll = [join(ml, 'net6', 'MelonLoader.dll'), join(ml, 'net35', 'MelonLoader.dll'), join(ml, 'MelonLoader.dll')]
  let version: string | undefined
  for (const f of dll) if (!version && (await exists(f))) version = (await dllInfo(f)).version
  ctx.add({ name: 'MelonLoader', kind: 'loader', path: ml, version, detectedBy: 'folder layout' })
  ctx.support.add('MelonLoader installed')
  for (const folder of ['Mods', 'Plugins']) {
    const dir = await findDir(root, folder)
    if (!dir) continue
    for (const e of await list(dir)) {
      if (e.dir || !/\.dll(\.(disabled|old))?$/i.test(e.name)) continue
      const info = await dllInfo(e.abs)
      ctx.add({ name: info.name ?? prettyName(e.name), kind: 'melonloader', path: e.abs, version: info.version, author: info.author, enabled: !isDisabledName(e.name), detectedBy: info.name ? 'file version' : 'file name' })
    }
  }
}

/** UE4SS ships these example mods; they are part of the loader, not something the user installed. */
const UE4SS_BUILTIN = new Set(['actorhookmod', 'bpml_genericfunctions', 'bpmodloadermod', 'cheatmanagerenablermod', 'consolecommandsmod', 'consoleenablermod', 'jsbluaprofilermod', 'keybinds', 'linetracemod', 'shared', 'splitscreenmod'])

async function detectUe4ss(ctx: Ctx, binDir: string): Promise<void> {
  const dir = (await findDir(binDir, 'ue4ss')) ?? binDir
  const modsDir = await findDir(dir, 'Mods')
  if (!modsDir || !((await exists(join(dir, 'UE4SS.dll'))) || (await exists(join(binDir, 'UE4SS.dll'))) || (await exists(join(dir, 'UE4SS-settings.ini'))))) return
  ctx.add({ name: 'UE4SS', kind: 'loader', path: dir, detectedBy: 'folder layout' })
  ctx.support.add('UE4SS installed')
  const enabled = new Map<string, boolean>()
  try {
    for (const line of (await fsp.readFile(join(modsDir, 'mods.txt'), 'utf8')).split(/\r?\n/)) {
      const m = line.match(/^\s*([^;:#]+?)\s*:\s*([01])\s*$/)
      if (m) enabled.set(m[1].toLowerCase(), m[2] === '1')
    }
  } catch {
    // no mods.txt: enabled.txt files decide
  }
  for (const e of await list(modsDir)) {
    if (!e.dir || UE4SS_BUILTIN.has(e.name.toLowerCase())) continue
    const on = enabled.get(e.name.toLowerCase()) ?? (await exists(join(e.abs, 'enabled.txt')))
    ctx.add({ name: prettyName(e.name), kind: 'ue4ss', path: e.abs, enabled: on, detectedBy: 'UE4SS mods folder' })
  }
}

async function detectScriptHooks(ctx: Ctx, root: string): Promise<void> {
  const files = await list(root)
  const has = (n: string) => files.some((f) => !f.dir && f.name.toLowerCase() === n.toLowerCase())
  if (has('ScriptHookV.dll')) ctx.add({ name: 'Script Hook V', kind: 'loader', path: join(root, 'ScriptHookV.dll'), detectedBy: 'file name' })
  if (has('ScriptHookVDotNet.asi') || has('ScriptHookVDotNet3.dll')) ctx.add({ name: 'Script Hook V .NET', kind: 'loader', path: join(root, 'ScriptHookVDotNet.asi'), detectedBy: 'file name' })
  if (has('ReShade.ini') || files.some((f) => f.dir && f.name.toLowerCase() === 'reshade-shaders')) ctx.add({ name: 'ReShade', kind: 'loader', path: join(root, 'ReShade.ini'), detectedBy: 'ReShade.ini' })
  for (const f of files) {
    if (f.dir || !/\.asi(\.(disabled|old))?$/i.test(f.name) || /^scripthookvdotnet/i.test(f.name)) continue
    const info = await dllInfo(f.abs)
    ctx.add({ name: info.name ?? prettyName(f.name), kind: 'script', path: f.abs, version: info.version, enabled: !isDisabledName(f.name), detectedBy: 'ASI plugin' })
  }
  if (files.some((f) => /\.asi$/i.test(f.name))) ctx.support.add('ASI plugins')
  const scripts = await findDir(root, 'scripts')
  if (scripts) {
    for (const f of await list(scripts)) {
      if (f.dir || !/\.(dll|cs|vb|lua|js)$/i.test(f.name)) continue
      const info = /\.dll$/i.test(f.name) ? await dllInfo(f.abs) : {}
      ctx.add({ name: info.name ?? prettyName(f.name.replace(/\.(cs|vb|lua|js)$/i, '')), kind: 'script', path: f.abs, version: info.version, detectedBy: 'scripts folder' })
    }
  }
}

// ---------------------------------------------------------------------------
// Unreal Engine .pak mods

async function contentPaks(root: string): Promise<Array<{ paks: string; project: string; bin?: string }>> {
  const out: Array<{ paks: string; project: string; bin?: string }> = []
  const visit = async (dir: string, depth: number) => {
    for (const e of await list(dir)) {
      if (!e.dir || /^(engine|redist|_commonredist|directx|support|__installer)$/i.test(e.name)) continue
      const paks = join(e.abs, 'Content', 'Paks')
      if (await exists(paks)) {
        const win64 = join(e.abs, 'Binaries', 'Win64')
        out.push({ paks, project: e.name, bin: (await exists(win64)) ? win64 : undefined })
      } else if (depth < 1) await visit(e.abs, depth + 1)
    }
  }
  await visit(root, 0)
  return out
}

const BASE_PAK = /^(pakchunk\d+.*|global|.*-windows(noeditor)?(_\d+)?|.*-windowsclient)\.(pak|ucas|utoc|sig)$/i

async function detectPaks(ctx: Ctx, root: string): Promise<void> {
  for (const { paks, bin } of await contentPaks(root)) {
    ctx.support.add('Unreal Engine (.pak mods)')
    if (bin) await detectUe4ss(ctx, bin)
    const add = (file: string, where: string) =>
      ctx.add({ name: prettyName(basename(file).replace(/_P(?=\.pak)/i, '')), kind: 'pak', path: file, enabled: !isDisabledName(file), detectedBy: where })
    for (const e of await list(paks)) {
      if (e.dir && /^(~mods|mods|logicmods|~logicmods)$/i.test(e.name)) {
        const walk = async (dir: string, depth: number) => {
          for (const f of await list(dir)) {
            if (f.dir && depth < 2) await walk(f.abs, depth + 1)
            else if (!f.dir && /\.pak(\.disabled)?$/i.test(f.name)) add(f.abs, `${e.name} folder`)
          }
        }
        await walk(e.abs, 0)
      } else if (!e.dir && /_P\.pak$/i.test(e.name) && !BASE_PAK.test(e.name)) add(e.abs, 'patch .pak name')
    }
  }
}

// ---------------------------------------------------------------------------
// Game-specific layouts

/** GMA header: "GMAD", version, steamid, timestamp, [required content], name, description, author. */
export async function gmaTitle(file: string): Promise<string | undefined> {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (bytesRead < 24 || buf.toString('ascii', 0, 4) !== 'GMAD') return undefined
    let o = 5 + 16
    const cstr = () => {
      const end = buf.indexOf(0, o)
      if (end < 0 || end > bytesRead) throw new Error('truncated')
      const s = buf.toString('utf8', o, end)
      o = end + 1
      return s
    }
    if (buf[4] > 1) while (cstr()) {}
    return cstr() || undefined
  } catch {
    return undefined
  } finally {
    await fh.close()
  }
}

async function detectGmod(ctx: Ctx, root: string): Promise<void> {
  const addons = join(root, 'garrysmod', 'addons')
  if (!(await exists(addons))) return
  ctx.support.add("Garry's Mod addons")
  for (const e of await list(addons)) {
    if (e.dir) {
      const json = await readJson<{ title?: string; author?: string }>(join(e.abs, 'addon.json'))
      let title = json?.title
      if (!title) {
        try {
          title = (await fsp.readFile(join(e.abs, 'addon.txt'), 'utf8')).match(/"name"\s*"([^"]+)"/i)?.[1]
        } catch {
          // folder without metadata (unpacked Workshop addon)
        }
      }
      ctx.add({ name: title ?? prettyName(e.name), kind: 'gmod-addon', path: e.abs, author: json?.author, detectedBy: title ? 'addon.json' : 'folder layout' })
    } else if (/\.gma$/i.test(e.name)) {
      const id = e.name.match(/(?:^|_)(\d{6,})\.gma$/i)?.[1]
      const title = await gmaTitle(e.abs)
      ctx.add({ name: title ?? prettyName(e.name), kind: 'gmod-addon', path: e.abs, source: id ? { sourceId: 'steamworkshop', modId: id } : undefined, detectedBy: title ? 'GMA header' : 'file name' })
    }
  }
}

interface BeamDbMod {
  active?: boolean
  filename?: string
  fullpath?: string
  modData?: { title?: string; username?: string; version_string?: string; resource_id?: number; tagid?: string }
}

async function detectBeamng(ctx: Ctx): Promise<void> {
  const preset = findPreset(ctx.game)
  if (!preset?.keepArchive) return
  const modsDir = presetTarget(preset.target, ctx.game.installDir)
  ctx.support.add('BeamNG mods folder')
  const dbFile = await readJson<{ mods?: Record<string, BeamDbMod> }>(join(modsDir, 'db.json'))
  const known = new Set<string>()
  for (const [key, m] of Object.entries(dbFile?.mods ?? {})) {
    const rel = (m.fullpath ?? `/mods/${m.filename ?? key}`).replace(/^\/mods\//i, '')
    const abs = join(modsDir, ...rel.split('/'))
    if (!(await exists(abs))) continue
    known.add(abs.toLowerCase())
    const d = m.modData
    ctx.add({
      name: d?.title ?? prettyName(m.filename ?? key),
      kind: 'beamng',
      path: abs,
      version: d?.version_string,
      author: d?.username,
      enabled: m.active !== false,
      source: d?.resource_id ? { sourceId: 'beamng', modId: String(d.resource_id) } : undefined,
      detectedBy: d?.title ? 'db.json (repository data)' : 'db.json'
    })
  }
  // Zips BeamNG hasn't registered yet (it does on the next start).
  const scan = async (dir: string) => {
    for (const e of await list(dir)) {
      if (e.dir && e.name.toLowerCase() === 'repo') await scan(e.abs)
      else if (!e.dir && /\.zip$/i.test(e.name) && !known.has(e.abs.toLowerCase())) ctx.add({ name: prettyName(e.name), kind: 'beamng', path: e.abs, detectedBy: 'mods folder' })
    }
  }
  await scan(modsDir)
  const unpacked = join(modsDir, 'unpacked')
  for (const e of await list(unpacked)) if (e.dir) ctx.add({ name: prettyName(e.name), kind: 'beamng', path: e.abs, detectedBy: 'unpacked mod folder' })
}

async function detectPeoplePlayground(ctx: Ctx, root: string): Promise<void> {
  if (!(await exists(join(root, 'People Playground_Data'))) && !/people playground/i.test(ctx.game.name)) return
  const contraptions = await findDir(root, 'Contraptions')
  const mods = await findDir(root, 'Mods')
  if (!contraptions && !mods) return
  ctx.support.add('Contraptions and mods')
  for (const e of contraptions ? await list(contraptions) : []) {
    const id = e.name.match(/^(\d{6,})$/)?.[1]
    let name = prettyName(e.name.replace(/\.json$/i, ''))
    if (e.dir) {
      const meta = (await list(e.abs)).find((f) => /\.json$/i.test(f.name))
      const json = meta ? await readJson<{ Name?: string; name?: string }>(meta.abs) : undefined
      name = json?.Name ?? json?.name ?? (meta ? prettyName(meta.name.replace(/\.json$/i, '')) : name)
    }
    ctx.add({ name, kind: 'contraption', path: e.abs, source: id ? { sourceId: 'steamworkshop', modId: id } : undefined, detectedBy: 'Contraptions folder' })
  }
  for (const e of mods ? await list(mods) : []) {
    if (!e.dir) continue
    const json = await readJson<{ Name?: string; Author?: string; ModVersion?: string }>(join(e.abs, 'mod.json'))
    const id = e.name.match(/^(\d{6,})$/)?.[1]
    ctx.add({ name: json?.Name ?? prettyName(e.name), kind: 'folder', path: e.abs, author: json?.Author, version: json?.ModVersion, source: id ? { sourceId: 'steamworkshop', modId: id } : undefined, detectedBy: json ? 'mod.json' : 'folder layout' })
  }
}

async function detectBo3(ctx: Ctx, root: string): Promise<void> {
  if (!(await exists(join(root, 'BlackOps3.exe'))) && !(await exists(join(root, 'boiii.exe')))) return
  ctx.support.add('Mods and custom maps')
  for (const folder of ['mods', 'usermaps']) {
    for (const e of await list(join(root, folder))) {
      if (!e.dir) continue
      const json = (await readJson<{ Title?: string; PublisherID?: string; Type?: string }>(join(e.abs, 'zone', 'workshop.json'))) ?? (await readJson<{ Title?: string; PublisherID?: string }>(join(e.abs, 'workshop.json')))
      ctx.add({
        name: json?.Title ?? prettyName(e.name),
        kind: 'bo3',
        path: e.abs,
        source: json?.PublisherID ? { sourceId: 'steamworkshop', modId: String(json.PublisherID) } : undefined,
        detectedBy: json ? 'workshop.json' : folder === 'usermaps' ? 'custom map folder' : 'mods folder'
      })
    }
  }
}

const XP_DEFAULT_SCENERY = /^(x-plane (airports|landmarks)|global airports|\*global_airports\*|x-plane \d+ (demo|global))/i

async function detectXPlane(ctx: Ctx, root: string): Promise<void> {
  if (!(await exists(join(root, 'Custom Scenery'))) || !(await exists(join(root, 'Aircraft')))) return
  ctx.support.add('Scenery, aircraft and plugins')
  for (const e of await list(join(root, 'Custom Scenery'))) {
    if (e.dir && !XP_DEFAULT_SCENERY.test(e.name)) ctx.add({ name: e.name, kind: 'scenery', path: e.abs, detectedBy: 'Custom Scenery folder' })
  }
  for (const e of await list(join(root, 'Aircraft'))) {
    if (e.dir && !/^laminar research$/i.test(e.name)) ctx.add({ name: e.name, kind: 'aircraft', path: e.abs, detectedBy: 'Aircraft folder' })
  }
  for (const e of await list(join(root, 'Resources', 'plugins'))) {
    if (e.dir && !/^pluginadmin$/i.test(e.name)) ctx.add({ name: e.name, kind: 'plugin', path: e.abs, detectedBy: 'plugins folder' })
  }
}

const OFFICIAL_MASTERS =
  /^(skyrim|update|dawnguard|hearthfires|dragonborn|fallout4|dlc\w*|cc\w+|starfield|constellation|oldmars|blueprintships-starfield|sfbgs\w+|oblivion|falloutnv|fallout3|deadmoney|honesthearts|oldworldblues|lonesomeroad|gunrunnersarsenal|caravanpack|classicpack|mercenarypack|tribalpack|anchorage|thepitt|brokensteel|pointlookout|zeta|knights|shiveringisles)\.es[mpl]$/i

async function detectBethesda(ctx: Ctx, root: string): Promise<void> {
  const data = await findDir(root, 'Data')
  if (!data) return
  const files = (await list(data)).filter((f) => !f.dir && /\.es[mpl]$/i.test(f.name))
  if (!files.some((f) => /\.esm$/i.test(f.name))) return
  ctx.support.add('Plugins (.esp/.esm)')
  let order: Map<string, boolean> | undefined
  for (const folder of ['Skyrim Special Edition', 'Skyrim', 'Fallout4', 'Starfield', 'FalloutNV', 'Fallout3', 'Oblivion']) {
    try {
      const text = await fsp.readFile(join(process.env.LOCALAPPDATA ?? '', folder, 'plugins.txt'), 'utf8')
      const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
      const starFormat = lines.some((l) => l.startsWith('*'))
      const map = new Map(lines.map((l) => [l.replace(/^\*/, '').trim().toLowerCase(), !starFormat || l.startsWith('*')]))
      if (files.some((f) => map.has(f.name.toLowerCase()))) {
        order = map
        break
      }
    } catch {
      // not this game
    }
  }
  for (const f of files) {
    if (OFFICIAL_MASTERS.test(f.name)) continue
    ctx.add({ name: f.name.replace(/\.es[mpl]$/i, ''), kind: 'plugin', path: f.abs, enabled: order ? (order.get(f.name.toLowerCase()) ?? false) : undefined, detectedBy: order ? 'plugins.txt' : 'Data folder' })
  }
}

async function detectMinecraft(ctx: Ctx, root: string): Promise<void> {
  if (!/minecraft/i.test(ctx.game.name)) return
  const mods = await findDir(root, 'mods')
  for (const e of mods ? await list(mods) : []) {
    if (!e.dir && /\.jar(\.disabled)?$/i.test(e.name)) ctx.add({ name: prettyName(e.name.replace(/\.jar(\.disabled)?$/i, '')), kind: 'jar', path: e.abs, enabled: !isDisabledName(e.name), detectedBy: 'mods folder' })
  }
}

/** mod.io's Unreal plugin keeps installed mods under C:\Users\Public\mod.io\<game id>. */
async function detectModio(ctx: Ctx): Promise<void> {
  const gameIdOnModio = ctx.game.modding.sources.modio
  if (!gameIdOnModio || !/^\d+$/.test(gameIdOnModio)) return
  const base = join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'mod.io', gameIdOnModio)
  const state = await readJson<unknown>(join(base, 'metadata', 'state.json'))
  const found = new Map<string, string>()
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 6) return
    const o = v as Record<string, unknown>
    const id = o.ID ?? o.id ?? o.ModId ?? o.mod_id
    const prof = (o.Profile ?? o.profile) as Record<string, unknown> | undefined
    const name = (prof?.name ?? prof?.Name ?? o.name ?? o.Name) as string | undefined
    if ((typeof id === 'number' || typeof id === 'string') && /^\d+$/.test(String(id)) && typeof name === 'string') found.set(String(id), name)
    for (const x of Object.values(o)) visit(x, depth + 1)
  }
  visit(state, 0)
  for (const e of await list(join(base, 'mods'))) {
    const id = e.name.match(/^(\d+)/)?.[1]
    if (id && !found.has(id)) found.set(id, `mod.io mod ${id}`)
  }
  for (const [id, name] of found) {
    ctx.add({ name, kind: 'modio', path: join(base, 'mods'), source: { sourceId: 'modio', modId: `${gameIdOnModio}/${id}` }, detectedBy: 'mod.io state' })
  }
  if (found.size) ctx.support.add('mod.io')
}

// ---------------------------------------------------------------------------
// Steam Workshop subscriptions of Steam games

const workshopTitles = new Map<string, string>()

async function workshopNames(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !workshopTitles.has(id))
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100)
    const body = new URLSearchParams({ itemcount: String(chunk.length) })
    chunk.forEach((id, n) => body.set(`publishedfileids[${n}]`, id))
    try {
      const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'NexusForge/1.0' }
      })
      const data = (await res.json()) as { response?: { publishedfiledetails?: Array<{ publishedfileid: string; title?: string }> } }
      for (const d of data.response?.publishedfiledetails ?? []) if (d.title) workshopTitles.set(d.publishedfileid, d.title)
    } catch {
      return // offline: items keep their ids as names
    }
  }
}

async function detectSteamWorkshop(ctx: Ctx): Promise<void> {
  if (ctx.game.platform !== 'steam' || !ctx.game.platformId) return
  // <library>\steamapps\common\<game>
  const steamapps = resolve(ctx.game.installDir, '..', '..')
  const acf = join(steamapps, 'workshop', `appworkshop_${ctx.game.platformId}.acf`)
  let installed: VdfObject | undefined
  try {
    installed = vget(parseVdf(await fsp.readFile(acf, 'utf8')), 'AppWorkshop', 'WorkshopItemsInstalled') as VdfObject | undefined
  } catch {
    return
  }
  ctx.support.add('Steam Workshop')
  const ids = Object.keys(installed ?? {})
  await workshopNames(ids)
  for (const id of ids) {
    ctx.add({ name: workshopTitles.get(id) ?? `Workshop item ${id}`, kind: 'workshop', path: join(steamapps, 'workshop', 'content', ctx.game.platformId, id), source: { sourceId: 'steamworkshop', modId: id }, detectedBy: 'Steam Workshop list' })
  }
}

// ---------------------------------------------------------------------------
// Everything else

/** A plain "Mods" folder next to the game, when nothing more specific explained it. */
async function detectModsFolder(ctx: Ctx, root: string): Promise<void> {
  for (const name of ['Mods', 'mods', 'addons', 'Addons']) {
    const dir = join(root, name)
    if (!(await exists(dir)) || ctx.mods.some((m) => m.path.toLowerCase().startsWith(dir.toLowerCase() + sep))) continue
    for (const e of await list(dir)) {
      if (/^(readme|desktop\.ini|thumbs\.db|\.)/i.test(e.name)) continue
      if (!e.dir && !/\.(zip|7z|rar|pak|dll|jar|lua|json|esp|esm|package|ts4script|vpk|scs|gma)$/i.test(e.name)) continue
      ctx.add({ name: prettyName(e.name), kind: 'folder', path: e.abs, enabled: !isDisabledName(e.name), detectedBy: `${name} folder` })
    }
    break
  }
}

async function detectEngine(game: Game, roots: string[]): Promise<{ engine?: GameModInfo['engine']; antiCheat?: string }> {
  let engine: GameModInfo['engine']
  let antiCheat: string | undefined
  for (const root of roots) {
    const entries = await list(root)
    const has = (re: RegExp, dir?: boolean) => entries.some((e) => (dir === undefined || e.dir === dir) && re.test(e.name))
    if (has(/^easyanticheat(_eos)?$/i, true) || has(/^start_protected_game\.exe$/i, false)) antiCheat ??= 'EasyAntiCheat'
    if (has(/^battleye$/i, true) || has(/_be\.exe$/i, false)) antiCheat ??= 'BattlEye'
    if (engine) continue
    if (has(/^unityplayer\.dll$/i, false) || has(/_data$/i, true)) engine = 'unity'
    else if (has(/^garrysmod$/i, true) || has(/^(hl2|srcds)\.exe$/i, false)) engine = 'source'
    else if (findPreset(game)?.keepArchive) engine = 'beamng'
    else if ((await contentPaks(root)).length || has(/^engine$/i, true)) engine = 'unreal'
    else if (await exists(join(root, 'Data'))) {
      const data = await list(join(root, 'Data'))
      if (data.some((f) => /\.esm$/i.test(f.name))) engine = 'bethesda'
    }
  }
  return { engine, antiCheat }
}

export interface DetectExtras {
  /** Files NexusForge deployed (lower-case absolute path -> installed mod id). */
  managed?: Array<[string, string]>
  /** How many mods NexusForge manages for the game (deployed or not). */
  managedCount?: number
}

export async function detectGameMods(game: Game, extras: DetectExtras = {}): Promise<GameModInfo> {
  const roots = [...new Set([game.exePath && !game.emulator && dirname(game.exePath).toLowerCase().startsWith(game.installDir.toLowerCase()) ? dirname(game.exePath) : undefined, game.installDir].filter(Boolean) as string[])]
  const mods: DetectedMod[] = []
  const seen = new Set<string>()
  const ctx: Ctx = {
    game,
    roots,
    mods,
    support: new Set(),
    add(m) {
      const rel = relative(game.installDir, m.path)
      const key = `${m.kind}:${(rel.startsWith('..') ? m.path : rel).toLowerCase()}${m.kind === 'modio' ? `:${m.source?.modId}` : ''}`
      if (seen.has(key)) return
      seen.add(key)
      mods.push({ ...m, key })
    }
  }
  if (!game.missing && (await exists(game.installDir))) {
    for (const root of roots) {
      await detectBepInEx(ctx, root)
      await detectMelonLoader(ctx, root)
      await detectScriptHooks(ctx, root)
      await detectPaks(ctx, root)
      await detectGmod(ctx, root)
      await detectPeoplePlayground(ctx, root)
      await detectBo3(ctx, root)
      await detectXPlane(ctx, root)
      await detectBethesda(ctx, root)
      await detectMinecraft(ctx, root)
    }
    await detectBeamng(ctx)
    await detectModio(ctx)
    await detectSteamWorkshop(ctx)
    for (const root of roots) await detectModsFolder(ctx, root)
  }

  // Which of these NexusForge deployed itself.
  const managed = extras.managed ?? []
  if (managed.length) {
    for (const m of mods) {
      const p = m.path.toLowerCase()
      const hit = managed.find(([abs]) => abs === p || abs.startsWith(p + sep))
      if (hit) m.managedModId = hit[1]
    }
  }

  const { engine, antiCheat } = await detectEngine(game, roots)
  const preset = findPreset(game)
  if (preset) ctx.support.add('Known mod setup')
  if (engine === 'unity' && !ctx.support.has('BepInEx installed') && !ctx.support.has('MelonLoader installed')) ctx.support.add('Unity (BepInEx / MelonLoader mods)')
  if (engine === 'source' && !ctx.support.has("Garry's Mod addons")) ctx.support.add('Source engine addons')
  const managedCount = extras.managedCount ?? 0
  if (managedCount) ctx.support.add('Mods installed with NexusForge')
  const userMods = mods.filter((m) => m.kind !== 'loader')
  const evidence = Boolean(preset) || userMods.length > 0 || mods.some((m) => m.kind === 'loader') || managedCount > 0
  const supported = evidence || (Boolean(engine) && !antiCheat)
  const support = [...ctx.support]
  if (antiCheat) support.push(`${antiCheat}: mods are usually blocked online`)
  // Loaders first, then alphabetical.
  mods.sort((a, b) => Number(b.kind === 'loader') - Number(a.kind === 'loader') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return { gameId: game.id, scannedAt: Date.now(), supported, support, engine, mods }
}

