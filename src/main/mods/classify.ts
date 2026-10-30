// The shared part of mod classification: package types that must never be laid out as plain files, whatever the
// game. It runs before the game's own rules (GameIntegration.classify):
//
//   setup programs   an .exe/.msi installer copied into a game does nothing; it has to be run (NexusForge never
//                    runs downloaded programs by itself)
//   save games       go into the folder the game reads saves from, when the game's integration knows it; otherwise
//                    they are not deployed (a save next to the .exe is never read)
//   framework mods   mods for a mod loader NexusForge can't drive and whose mod folder it doesn't know (NexusTools)
//   ReShade presets  deployed, but flagged when ReShade is not installed for the game
//
// Each strategy states what it needs, where the files go, how the result is checked and how it is undone; the list
// is shown in docs/INTEGRATIONS.md and in the diagnostic report.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, StagedPackage } from '../integrations/types'
import { children, isDocFile, route } from '../integrations/common'
import { looksLikeSave } from '../integrations/generic'
import { fileStrings } from '../integrations/proxy'
import { readVersionStrings } from '../library/exe-version'
import { safeReaddir } from '../util/fs'
import { GAME_DIRS } from './layout'
import { IniDoc } from '../reshade/ini'
import { isPresetText, parsePreset } from '../reshade/presets'
import {
  chooseModule,
  EFFECTS_ID,
  EFFECTS_MARKER,
  findReshade,
  moduleNames,
  renderTarget,
  RESHADE_ID,
  RESHADE_MARKER,
  reshadeTargetId,
  type EffectsMarker,
  type ReshadeApi,
  type ReshadeMarker
} from '../reshade/core'

export interface ClassifyContext {
  game: Game
  info: IntegrationInfo
  integration: GameIntegration
  env: IntegrationEnv
  /** The game's installed mods (NexusForge's own ReShade keeps the file name it has). */
  mods?: InstalledMod[]
  /** Files this mod already has in the save target (laying a save out again keeps its slot). */
  owned?: string[]
}

export interface InstallStrategy {
  id: string
  label: string
  /** What must be there before it works. */
  prerequisites: string
  /** Where the files go. */
  destination: string
  /** How NexusForge checks the result. */
  validation: string
  /** How it is undone. */
  rollback: string
  /** A classification when the package is of this type; undefined lets the next strategy (and the game's rules) decide. */
  match?(pkg: StagedPackage, ctx: ClassifyContext): Promise<Classification | undefined>
  /** Adds findings to the game's own classification. */
  amend?(cls: Classification, pkg: StagedPackage, ctx: ClassifyContext): Promise<void>
}

/** Files of a package that are not read-me files. */
function payload(pkg: StagedPackage): string[] {
  return pkg.files.map((f) => f.rel).filter((rel) => !isDocFile(basename(rel)) && !/\.(jpe?g|png|gif|webp|bmp)$/i.test(rel))
}

const INSTALLER_SIGNS: Array<[RegExp, string]> = [
  [/Inno Setup Setup Data|This installation was built with Inno Setup/, 'Inno Setup installer'],
  [/Nullsoft Install System|NSIS Error/, 'NSIS installer'],
  [/InstallShield/, 'InstallShield installer'],
  [/WiX Toolset|WixBundle/, 'WiX installer'],
  [/Setup Factory/, 'Setup Factory installer'],
  [/Advanced Installer/, 'Advanced Installer setup']
]

/** What kind of installer a file is, or undefined when it is not one. */
export async function installerKind(file: string): Promise<string | undefined> {
  if (/\.msi$/i.test(file)) return 'Windows Installer package (.msi)'
  if (!/\.exe$/i.test(file)) return undefined
  let text = ''
  try {
    text = await fileStrings(file, 32 * 1024 * 1024)
  } catch {
    return undefined
  }
  for (const [re, label] of INSTALLER_SIGNS) if (re.test(text)) return label
  if (/(^|[^a-z])(setup|install(er)?)([^a-z]|$)/i.test(basename(file))) return 'setup program'
  return undefined
}

export const installerStrategy: InstallStrategy = {
  id: 'installer',
  label: 'Setup program',
  prerequisites: 'Someone runs it: NexusForge never starts a downloaded program by itself.',
  destination: 'Nowhere: the setup program stays in NexusForge storage until you run it (Run installer).',
  validation: 'None by NexusForge; the setup program does its own installation.',
  rollback: "The setup program's own uninstaller; removing the mod in NexusForge only deletes the downloaded file.",
  async match(pkg) {
    const files = payload(pkg)
    if (!files.length || files.length > 2 || !files.every((f) => /\.(exe|msi)$/i.test(f))) return undefined
    for (const rel of files) {
      const kind = await installerKind(join(pkg.dir, rel))
      if (!kind) continue
      return {
        kind: 'installer',
        routes: [],
        skipped: [],
        rootPath: '',
        meta: { installer: rel },
        checks: [
          {
            level: 'error',
            code: 'installer',
            message: `${basename(rel)} is a setup program (${kind}). Copying it into the game does nothing; it has to be run, and NexusForge never runs downloaded programs by itself.`,
            userAction: 'Run the installer yourself (the mod\'s menu › Run installer) and follow its steps; it installs into the game folder you pick there.'
          }
        ]
      }
    }
    return undefined
  }
}

export const saveStrategy: InstallStrategy = {
  id: 'savegame',
  label: 'Save game',
  prerequisites: "The game's integration knows where this copy of the game keeps its saves (the folder must exist: start the game once).",
  destination: 'The save folder of this copy (a deploy target marked as user data: always copied, never linked).',
  validation: 'Every file is checked after deployment; a save you already have is never overwritten (the integration picks a free slot or refuses).',
  rollback: 'Purge removes the save again unless the game changed it after deployment (then it is your progress and stays).',
  async match(pkg, ctx) {
    const files = pkg.files.map((f) => f.rel)
    if (!looksLikeSave(pkg, files)) return undefined
    const saveFiles = files.filter((f) => !isDocFile(basename(f)))
    const skipped = files.filter((f) => isDocFile(basename(f))).map((path) => ({ path, reason: 'read-me file, not part of the save' }))
    const target = ctx.info.targets.find((t) => t.id === 'saves')
    if (target && ctx.integration.saveRoutes) {
      const r = await ctx.integration.saveRoutes(pkg, saveFiles, target, ctx.game, ctx.owned)
      return { kind: 'savegame', routes: r.routes, skipped, checks: r.checks, rootPath: '' }
    }
    return {
      kind: 'savegame',
      routes: [],
      skipped,
      rootPath: '',
      checks: [
        {
          level: 'error',
          code: 'savegame',
          message: ctx.integration.saveRoutes
            ? `This is a save game, but NexusForge didn't find the save folder of this copy of ${ctx.game.name} (start the game once and save, so the folder exists). It is not deployed: a save in the game folder is never read.`
            : `This is a save game. Saves don't belong in the game folder and NexusForge doesn't know where ${ctx.game.name} keeps them, so it is not deployed.`,
          userAction: "Open the mod's folder and copy the save where the mod page says (back up the save it replaces first)."
        }
      ]
    }
  }
}

interface NexusToolsConfig {
  friendlyId?: string
  name?: string
  minTntVersion?: string
}

export const frameworkModStrategy: InstallStrategy = {
  id: 'framework-mod',
  label: 'Mod for a mod manager NexusForge cannot drive',
  prerequisites: 'The framework itself (NexusTools for WATCH_DOGS), installed with its own setup.',
  destination: "Unknown to NexusForge: the framework doesn't document a mods folder, so nothing is deployed rather than guessed.",
  validation: 'None by NexusForge.',
  rollback: 'Nothing was deployed.',
  async match(pkg) {
    const configs = pkg.files.filter((f) => /(^|\/)modconfig\.json$/i.test(f.rel))
    for (const c of configs) {
      let cfg: NexusToolsConfig | undefined
      try {
        cfg = JSON.parse((await fsp.readFile(join(pkg.dir, c.rel), 'utf8')).replace(/^﻿/, '')) as NexusToolsConfig
      } catch {
        continue
      }
      if (!cfg || typeof cfg !== 'object' || !('minTntVersion' in cfg)) continue
      const root = dirname(c.rel) === '.' ? '' : dirname(c.rel).replace(/\\/g, '/')
      return {
        kind: 'framework-mod',
        routes: [],
        skipped: [],
        rootPath: root,
        meta: { framework: 'nexustools', frameworkMin: cfg.minTntVersion ?? '' },
        checks: [
          {
            level: 'error',
            code: 'needs_framework',
            message: `A NexusTools mod (modconfig.json "${cfg.friendlyId ?? cfg.name ?? root}", NexusTools ${cfg.minTntVersion ?? ''}+). NexusTools loads its mods itself and does not document a mods folder, so NexusForge doesn't put the files anywhere: loose files in the game folder do nothing.`,
            userAction: "Install NexusTools with its own setup, then add this mod in NexusTools' mod manager (the mod's folder: the mod's menu › Open folder)."
          }
        ]
      }
    }
    return undefined
  }
}

/** ReShade is installed next to the game's .exe: the file it runs as, else its ReShade.ini. */
export async function reshadeInstalled(game: Pick<Game, 'exePath' | 'installDir'>): Promise<string | undefined> {
  const dir = game.exePath ? dirname(game.exePath) : game.installDir
  const copy = (await findReshade(dir))[0]
  if (copy) return copy.name
  return (await safeReaddir(dir)).find((e) => e.isFile() && /^reshade\.ini$/i.test(e.name))?.name
}

/** NexusForge's own ReShade and shader-pack packages (built by reshade/core.ts from the official downloads). */
export const reshadePackageStrategy: InstallStrategy = {
  id: 'reshade',
  label: 'ReShade (installed by NexusForge)',
  prerequisites: "The game's executable is known and ReShade's compatibility list doesn't mark the game as banning ReShade.",
  destination: "ReShade's DLL next to the game's executable under the name for its graphics API (dxgi.dll, d3d9.dll, opengl32.dll; never over a file that came with the game); shader packs into reshade-shaders\\ there.",
  validation: "ReShade is in place under one name only, has add-on support when a mod needs it, and ReShade.ini searches reshade-shaders\\. After a start, ReShade.log shows whether it attached to the game and which effects compiled.",
  rollback: 'Purge removes the DLL and the shader packs and puts back any file they replaced; ReShade.ini goes too when NexusForge created it.',
  async match(pkg, ctx): Promise<Classification | undefined> {
    const marker = pkg.files.find((f) => f.rel === RESHADE_MARKER)
    const fxMarker = pkg.files.find((f) => f.rel === EFFECTS_MARKER)
    if (!marker && !fxMarker) return undefined
    const t = await renderTarget(ctx.game, ctx.env)
    const dir = t?.dir ?? (ctx.game.exePath ? dirname(ctx.game.exePath) : ctx.game.installDir)
    const target = reshadeTargetId(ctx.info, dir)
    if (fxMarker) {
      const m = JSON.parse(await fsp.readFile(fxMarker.abs, 'utf8')) as EffectsMarker
      return {
        kind: 'loader',
        loaderId: EFFECTS_ID,
        name: 'ReShade shader packs',
        routes: pkg.files.some((f) => f.rel.toLowerCase().startsWith('reshade-shaders/')) ? [route('reshade-shaders', target, 'reshade-shaders')] : [],
        skipped: [{ path: EFFECTS_MARKER, reason: "NexusForge's note of the packs it put together" }],
        checks: [],
        needsLoader: RESHADE_ID,
        rootPath: '',
        meta: { packages: m.packages.join('|') }
      }
    }
    const m = JSON.parse(await fsp.readFile(marker!.abs, 'utf8')) as ReshadeMarker
    const dll = pkg.files.find((f) => /^reshade(32|64)\.dll$/i.test(f.rel))
    const checks: Classification['checks'] = []
    let to: string | undefined
    if (dll && m.api !== 'vulkan') {
      const managed = (ctx.mods ?? []).find((x) => x.loaderId === RESHADE_ID)
      const ours = (managed?.routes ?? []).filter((r) => /\.(dll|asi)$/i.test(r.to)).map((r) => basename(r.to))
      const api = m.api as ReshadeApi
      const choice = await chooseModule(dir, await moduleNames(api, api === 'd3d11' ? '11' : api === 'd3d12' ? '12' : undefined, dir, m.arch, t?.exeName), ours)
      to = choice.name
      if (!to) checks.push({ level: 'error', code: 'proxy_taken', message: `Every name ReShade can load under is taken by files that came with the game: ${choice.taken.map((x) => `${x.name} (${x.label})`).join(', ')}.` })
      else if (choice.fallback) checks.push({ level: 'info', code: 'reshade_name', message: `${choice.fallback} next to the game belongs to something else and stays; ReShade goes in as ${to}.` })
    }
    return {
      kind: 'loader',
      loaderId: RESHADE_ID,
      name: 'ReShade',
      version: m.version,
      routes: dll && to ? [route(dll.rel, target, to)] : [],
      skipped: [{ path: RESHADE_MARKER, reason: "NexusForge's note of the ReShade build it installed" }],
      checks,
      rootPath: '',
      meta: { build: m.build, api: m.api, arch: m.arch, ...(m.thumbprint ? { thumbprint: m.thumbprint } : {}) } as Record<string, string>
    }
  }
}

/** Files a classification deploys: package path, its route, and where it goes inside the route's target. */
function routedFiles(cls: Classification, pkg: StagedPackage): Array<{ rel: string; target: string; to: string }> {
  const skip = cls.skipped.map((s) => s.path.toLowerCase())
  const skipped = (rel: string) => skip.some((s) => s === '' || rel.toLowerCase() === s || rel.toLowerCase().startsWith(`${s}/`))
  const out: Array<{ rel: string; target: string; to: string }> = []
  for (const r of cls.routes) {
    const from = r.from.replace(/^\/+|\/+$/g, '')
    const file = pkg.files.find((f) => f.rel.toLowerCase() === from.toLowerCase())
    if (file) {
      if (!skipped(file.rel)) out.push({ rel: file.rel, target: r.target, to: r.to || basename(file.rel) })
      continue
    }
    const prefix = from ? `${from.toLowerCase()}/` : ''
    for (const f of pkg.files) {
      if (prefix && !f.rel.toLowerCase().startsWith(prefix)) continue
      if (skipped(f.rel)) continue
      const sub = f.rel.slice(prefix.length)
      out.push({ rel: f.rel, target: r.target, to: r.to ? `${r.to.replace(/\/+$/, '')}/${sub}` : sub })
    }
  }
  return out
}

function addNeed(cls: Classification, id: string): void {
  if (!cls.needsLoader) cls.needsLoader = id
  else if (cls.needsLoader !== id && !(cls.needsLoaders ?? []).includes(id)) cls.needsLoaders = [...(cls.needsLoaders ?? []), id]
}

async function textOf(file: string, max = 2 * 1024 * 1024): Promise<string | undefined> {
  try {
    const st = await fsp.stat(file)
    if (st.size > max) return undefined
    return await fsp.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * ReShade parts of any mod: a ReShade copy bundled with a mod stays out (NexusForge installs ReShade once, in the
 * version and under the name that fit the game), as do ReShade.ini and ReShade.log (NexusForge writes ReShade.ini;
 * search paths and depth settings from the mod's copy are carried over). Presets, add-ons and shader folders make
 * the mod need ReShade (and the shader packs its presets use); they go next to ReShade even when the game's mod
 * folder is elsewhere.
 */
export const reshadeContentStrategy: InstallStrategy = {
  id: 'reshade-content',
  label: 'ReShade presets, shaders and add-ons',
  prerequisites: 'ReShade for the game (NexusForge installs it, with add-on support when an add-on needs it, plus the shader packs presets use).',
  destination: "Next to ReShade (the game's executable): presets and add-ons at the top, shaders in reshade-shaders\\Shaders, textures in reshade-shaders\\Textures.",
  validation: 'ReShade is in place (with add-on support if needed); the ReShade tab lists effects a preset uses that are not installed.',
  rollback: 'Purge removes the files; a preset NexusForge made active is switched back to ReShadePreset.ini.',
  async amend(cls, pkg, ctx) {
    if (cls.kind === 'loader' || cls.kind === 'installer' || cls.kind === 'savegame' || cls.kind === 'framework-mod' || cls.kind === 'archive') return
    const files = routedFiles(cls, pkg)
    if (!files.length) return
    const t = await renderTarget(ctx.game, ctx.env).catch(() => undefined)
    const dir = t?.dir ?? (ctx.game.exePath ? dirname(ctx.game.exePath) : ctx.game.installDir)
    const rsTarget = reshadeTargetId(ctx.info, dir)
    const moved = new Set<string>()
    let uses = false
    let addon = false
    const notes: string[] = []
    const meta = (k: string, v: string[]) => {
      if (v.length) cls.meta = { ...cls.meta, [k]: [...new Set([...(cls.meta?.[k] ?? '').split('|').filter(Boolean), ...v])].join('|') }
    }
    // ReShade itself, its settings and log.
    for (const f of files) {
      const name = basename(f.rel)
      const lower = name.toLowerCase()
      if (lower === 'reshade.ini' || lower === 'reshade.log') {
        if (lower === 'reshade.ini') {
          const doc = IniDoc.parse((await textOf(join(pkg.dir, f.rel))) ?? '')
          const outside = (key: string) => (doc.getList('GENERAL', key) ?? []).filter((p) => !/^\.?[\\/]?reshade-shaders([\\/]|$)/i.test(p.replace(/^\.[\\/]/, '')) && !/^\.?[\\/]?$/.test(p))
          meta('reshadeEffectPaths', outside('EffectSearchPaths'))
          meta('reshadeTexturePaths', outside('TextureSearchPaths'))
          meta('reshadeDefines', (doc.getList('GENERAL', 'PreprocessorDefinitions') ?? []).filter((d) => /^RESHADE_DEPTH_/.test(d)))
        }
        cls.skipped.push({ path: f.rel, reason: lower === 'reshade.ini' ? "ReShade's settings file: NexusForge writes ReShade.ini for the game (keeping your own settings) and takes over this one's shader paths and depth settings" : "ReShade's log from the mod author's PC" })
        uses = true
        continue
      }
      if (!/\.(dll|asi|addon|addon32|addon64)$/i.test(name)) continue
      const abs = join(pkg.dir, f.rel)
      const vs = await readVersionStrings(abs).catch(() => undefined)
      const text = vs?.productName === 'ReShade' ? '' : /\.(dll|asi|addon\d*)$/i.test(name) ? await fileStrings(abs, 32 * 1024 * 1024).catch(() => '') : ''
      if (vs?.productName === 'ReShade' || /crosire's ReShade/.test(text)) {
        cls.skipped.push({ path: f.rel, reason: `a copy of ReShade${vs?.version ? ` ${vs.version.replace(/,\s*/g, '.')}` : ''} that came with the mod; NexusForge installs ReShade itself, once, in the newest version and under the name that fits the game` })
        uses = true
        continue
      }
      if (/\.addon(32|64)?$/i.test(name) || /ReShadeRegisterAddon/.test(text)) {
        uses = true
        addon = true
        notes.push(`${name} is a ReShade add-on`)
        if (/\.addon(32|64)?$/i.test(name) && (f.target !== rsTarget || f.to.includes('/'))) {
          cls.skipped.push({ path: f.rel, reason: 'moved next to ReShade, where it looks for add-ons', moved: true })
          moved.add(f.rel)
          cls.routes.push(route(f.rel, rsTarget, name))
        }
      }
    }
    // Presets and the effects they use.
    const pkgFx = new Set(pkg.files.filter((f) => /\.fx$/i.test(f.rel)).map((f) => basename(f.rel).toLowerCase()))
    const wanted = new Set<string>()
    let presets = 0
    for (const f of files) {
      if (!/\.ini$/i.test(f.rel) || /^reshade\.ini$/i.test(basename(f.rel)) || moved.has(f.rel)) continue
      const text = await textOf(join(pkg.dir, f.rel))
      if (!text || !isPresetText(text)) continue
      presets++
      uses = true
      for (const fx of parsePreset(text).effects) if (!pkgFx.has(fx.toLowerCase())) wanted.add(fx)
      if (f.target !== rsTarget) {
        cls.skipped.push({ path: f.rel, reason: 'moved next to ReShade, where presets go', moved: true })
        cls.routes.push(route(f.rel, rsTarget, basename(f.rel)))
      }
    }
    // Shader folders: reshade-shaders\ as it is, or Shaders\ / Textures\ folders with effects in them.
    const shaderFolder = (prefixTest: (dirPath: string) => boolean) => {
      const dirs = new Set<string>()
      for (const f of files) {
        const parts = f.rel.split('/')
        for (let i = 0; i < parts.length - 1; i++) if (prefixTest(parts[i])) dirs.add(parts.slice(0, i + 1).join('/'))
      }
      return [...dirs].sort((a, b) => a.length - b.length).filter((d, i, all) => !all.slice(0, i).some((p) => d.startsWith(`${p}/`)))
    }
    const hasFx = files.some((f) => /\.fxh?$/i.test(f.rel))
    if (hasFx) {
      uses = true
      for (const d of shaderFolder((p) => /^reshade-shaders$/i.test(p))) {
        const sample = files.find((f) => f.rel.startsWith(`${d}/`))
        if (sample && (sample.target !== rsTarget || !/^reshade-shaders\//i.test(sample.to))) {
          cls.skipped.push({ path: d, reason: 'moved next to ReShade', moved: true })
          cls.routes.push(route(d, rsTarget, 'reshade-shaders'))
        }
      }
      const outsideRs = files.filter((f) => /\.fxh?$/i.test(f.rel) && !/(^|\/)reshade-shaders\//i.test(f.rel))
      if (outsideRs.length) {
        for (const [name, dest] of [
          [/^shaders$/i, 'reshade-shaders/Shaders'],
          [/^textures$/i, 'reshade-shaders/Textures']
        ] as const) {
          for (const d of shaderFolder((p) => name.test(p))) {
            if (/(^|\/)reshade-shaders\//i.test(`${d}/`)) continue
            cls.skipped.push({ path: d, reason: `ReShade ${dest.endsWith('Shaders') ? 'shaders' : 'textures'}: moved to ${dest.replace(/\//g, '\\')} next to ReShade, where ReShade looks for them`, moved: true })
            cls.routes.push(route(d, rsTarget, dest))
          }
        }
        // Loose effects at the top of the package.
        for (const f of files.filter((x) => /\.fxh?$/i.test(x.rel) && !x.rel.includes('/'))) {
          cls.skipped.push({ path: f.rel, reason: 'ReShade effect: moved to reshade-shaders\\Shaders', moved: true })
          cls.routes.push(route(f.rel, rsTarget, `reshade-shaders/Shaders/${basename(f.rel)}`))
        }
      }
    }
    if (!uses) return
    addNeed(cls, RESHADE_ID)
    if (wanted.size) {
      addNeed(cls, EFFECTS_ID)
      cls.meta = { ...cls.meta, reshadeEffects: [...wanted].join(',') }
    }
    if (addon) cls.meta = { ...cls.meta, reshadeAddon: '1' }
    if (presets && payload(pkg).every((rel) => /\.ini$/i.test(rel))) cls.kind = 'preset'
    const status = ctx.info.loaders.find((l) => l.id === RESHADE_ID)
    const parts = [
      presets ? `${presets === 1 ? 'A ReShade preset' : `${presets} ReShade presets`}${wanted.size ? ` (uses ${[...wanted].slice(0, 6).join(', ')}${wanted.size > 6 ? ', …' : ''}, which come with ReShade's shader packs)` : ''}` : undefined,
      addon ? `${notes.join(', ')}: it needs ReShade with add-on support` : undefined
    ].filter(Boolean)
    if (status?.state === 'unsupported') {
      cls.checks.push({ level: 'warning', code: 'needs_reshade', message: `${parts.join('. ') || 'This mod is for ReShade'}. ${status.blocked ?? 'ReShade cannot be installed for this game.'}`, userAction: status.blocked })
    } else {
      cls.checks.push({
        level: 'info',
        code: 'needs_reshade',
        message: `${parts.join('. ') || 'This mod is for ReShade'}. ${status?.state === 'installed' || status?.state === 'outdated' ? `ReShade is installed for this game${status.proxy ? ` (${status.proxy})` : ''}` : 'NexusForge installs ReShade from reshade.me with the next setup'}${presets ? ', and makes the preset the active one' : ''}.`
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Archives with one folder per game ("GTA V/" next to "Minecraft/")

/** Folder names that belong inside a game folder: never a folder "for another game". */
const CONTENT_DIRS = new Set([
  ...GAME_DIRS,
  'scripts', 'lml', 'update', 'common', 'redux', 'menyoostuff', 'bepinex', 'reshade-shaders', 'shaders', 'textures', 'win64', 'x86', 'saves', 'save'
])

/** Comparable forms of a name: "Grand Theft Auto V" -> grandtheftautov, grandtheftauto5, gtav, gta5. */
export function nameForms(name: string): Set<string> {
  const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }
  const DIGIT = Object.fromEntries(Object.entries(ROMAN).map(([r, d]) => [d, r]))
  const tokens = name
    .replace(/\.(exe|zip|7z|rar)$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const out = new Set<string>()
  const add = (t: string[]) => {
    if (!t.length) return
    out.add(t.join(''))
    if (t.length >= 3 || (t.length === 2 && /^(\d+|[ivx]+)$/.test(t[1]))) out.add(t.map((x) => (/^(\d+|[ivx]+)$/.test(x) ? x : x[0])).join(''))
  }
  add(tokens)
  add(tokens.map((t) => ROMAN[t] ?? t))
  add(tokens.map((t) => DIGIT[t] ?? t))
  for (const f of [...out]) if (f.length < 3) out.delete(f)
  return out
}

function gameNames(game: Game): Set<string> {
  const out = new Set<string>()
  const names = [game.name, basename(game.installDir), game.exePath ? basename(game.exePath) : '', game.exePath ? basename(dirname(game.exePath)) : '']
  for (const n of names) if (n) for (const f of nameForms(n)) out.add(f)
  return out
}

export interface GameFolderSplit {
  /** Folder of the package that is for this game. */
  prefix: string
  /** Its siblings, and why they stay out. */
  others: Array<{ path: string; reason: string }>
}

/**
 * An archive with one folder per game or program ("GTA V/…" and "Minecraft/…", maybe inside a wrapper folder):
 * the folder named after this game is the mod; the others are for something else. Undefined when the package
 * isn't laid out like that (the game's own rules decide then).
 */
export function perGameFolder(pkg: Pick<StagedPackage, 'files'>, game: Game): GameFolderSplit | undefined {
  const names = gameNames(game)
  let prefix = ''
  for (let depth = 0; depth < 4; depth++) {
    const c = children(pkg.files, prefix)
    if (c.files.some((f) => !isDocFile(f) && !/\.(jpe?g|png|gif|webp|bmp)$/i.test(f))) return undefined
    if (c.dirs.length === 1) {
      prefix = prefix ? `${prefix}/${c.dirs[0]}` : c.dirs[0]
      continue
    }
    if (c.dirs.length < 2) return undefined
    const matching = c.dirs.filter((d) => [...nameForms(d)].some((f) => names.has(f)))
    if (matching.length !== 1) return undefined
    const others = c.dirs.filter((d) => d !== matching[0])
    if (others.some((d) => CONTENT_DIRS.has(d.toLowerCase()))) return undefined
    const j = (d: string) => (prefix ? `${prefix}/${d}` : d)
    return {
      prefix: j(matching[0]),
      others: others.map((d) => {
        const inside = pkg.files.filter((f) => f.rel.toLowerCase().startsWith(`${j(d).toLowerCase()}/`)).map((f) => basename(f.rel))
        const reason = /^(screens?hots?|images?|pictures?|previews?|docs?|documentation)$/i.test(d)
          ? 'pictures or documentation, not part of the mod'
          : /optional|extra|addon|bonus|alternat|variant/i.test(d)
            ? `optional files; only the "${matching[0]}" folder is installed (copy what you want from the mod's folder by hand)`
            : `for another game or program${inside.some((f) => /\.jar$/i.test(f)) ? ` (it holds ${inside.find((f) => /\.jar$/i.test(f))}, a Java mod)` : ''}; only the "${matching[0]}" folder is for ${game.name}`
        return { path: j(d), reason }
      })
    }
  }
  return undefined
}

/** The package seen from one of its folders. */
function narrowed(pkg: StagedPackage, prefix: string): StagedPackage {
  const p = `${prefix.toLowerCase()}/`
  return { ...pkg, dir: join(pkg.dir, ...prefix.split('/')), files: pkg.files.filter((f) => f.rel.toLowerCase().startsWith(p)).map((f) => ({ ...f, rel: f.rel.slice(p.length) })) }
}

function widened(cls: Classification, split: GameFolderSplit): Classification {
  const j = (rel: string) => (rel ? `${split.prefix}/${rel}` : split.prefix)
  return {
    ...cls,
    rootPath: j(cls.rootPath),
    routes: cls.routes.map((r) => ({ ...r, from: j(r.from) })),
    skipped: [...split.others, ...cls.skipped.map((s) => ({ ...s, path: j(s.path) }))],
    meta: cls.meta?.installer ? { ...cls.meta, installer: j(cls.meta.installer) } : cls.meta,
    checks: [{ level: 'info', code: 'game_folder', message: `The archive has a folder per game; NexusForge installs "${basename(split.prefix)}" and leaves out ${split.others.map((o) => `"${basename(o.path)}"`).join(', ')}.` }, ...cls.checks]
  }
}

/** Shared strategies, in the order they are tried. */
export const STRATEGIES: InstallStrategy[] = [reshadePackageStrategy, installerStrategy, saveStrategy, frameworkModStrategy, reshadeContentStrategy]

/** Raised when shared classification rules change: every mod is laid out again (manual layouts excepted). */
// 2: ReShade content (bundled ReShade copies left out, presets/shaders next to ReShade), folder-per-game archives.
export const SHARED_RULES_REVISION = 2

/** Classifies a package: shared strategies first, then the game's own rules, then shared amendments. */
export async function classifyPackage(pkg: StagedPackage, ctx: ClassifyContext): Promise<Classification> {
  const split = perGameFolder(pkg, ctx.game)
  if (split) return widened(await classifyPackage(narrowed(pkg, split.prefix), ctx), split)
  for (const s of STRATEGIES) {
    const hit = await s.match?.(pkg, ctx)
    if (hit) return { ...hit, meta: { ...hit.meta, strategy: s.id } }
  }
  const cls = await ctx.integration.classify(pkg, ctx.game, ctx.info, ctx.env)
  for (const s of STRATEGIES) await s.amend?.(cls, pkg, ctx)
  return cls
}
