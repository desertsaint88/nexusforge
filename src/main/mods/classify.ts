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
import type { Game, IntegrationInfo } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, StagedPackage } from '../integrations/types'
import { isDocFile } from '../integrations/common'
import { looksLikeSave } from '../integrations/generic'
import { fileStrings, identifyProxy } from '../integrations/proxy'
import { safeReaddir } from '../util/fs'

export interface ClassifyContext {
  game: Game
  info: IntegrationInfo
  integration: GameIntegration
  env: IntegrationEnv
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
      const r = await ctx.integration.saveRoutes(pkg, saveFiles, target, ctx.game)
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

const PRESET_INI = /^Techniques=/m
const FX_SECTION = /^\[[^\]\r\n]+\.fx\]/m
const RESHADE_PROXIES = ['dxgi.dll', 'd3d9.dll', 'd3d10.dll', 'd3d11.dll', 'd3d12.dll', 'opengl32.dll', 'dinput8.dll', 'ddraw.dll', 'vulkan-1.dll']

/** ReShade is installed next to the game's .exe (its proxy DLL or ReShade.ini). */
export async function reshadeInstalled(game: Pick<Game, 'exePath' | 'installDir'>): Promise<string | undefined> {
  const dir = game.exePath ? dirname(game.exePath) : game.installDir
  const names = (await safeReaddir(dir)).filter((e) => e.isFile()).map((e) => e.name)
  const ini = names.find((n) => /^reshade\.ini$/i.test(n))
  if (ini) return ini
  for (const n of names) {
    if (!RESHADE_PROXIES.includes(n.toLowerCase())) continue
    if ((await identifyProxy(join(dir, n), n)).owner === 'reshade') return n
  }
  return undefined
}

export const reshadePresetStrategy: InstallStrategy = {
  id: 'reshade-preset',
  label: 'ReShade preset',
  prerequisites: 'ReShade installed for the game (with its own setup from reshade.me).',
  destination: "Next to the game's .exe, where ReShade looks for presets.",
  validation: 'NexusForge checks that ReShade is installed; whether the preset is selected is up to ReShade\'s overlay.',
  rollback: 'Purge removes the preset file.',
  async amend(cls, pkg, ctx) {
    const inis = pkg.files.filter((f) => /\.ini$/i.test(f.rel) && f.size < 2 * 1024 * 1024)
    let presets = 0
    for (const f of inis) {
      try {
        const text = await fsp.readFile(join(pkg.dir, f.rel), 'utf8')
        if (PRESET_INI.test(text) && FX_SECTION.test(text)) presets++
      } catch {
        // unreadable: not a preset we can recognize
      }
    }
    if (!presets) return
    if (payload(pkg).every((rel) => /\.ini$/i.test(rel))) cls.kind = 'preset'
    const installed = await reshadeInstalled(ctx.game)
    cls.checks.push(
      installed
        ? { level: 'info', code: 'reshade_preset', message: `A ReShade preset; ReShade is installed for this game (${installed}). Pick the preset in ReShade's overlay.` }
        : {
            level: 'warning',
            code: 'needs_reshade',
            message: 'A ReShade preset: it only changes anything with ReShade installed for this game, and ReShade is not installed here.',
            userAction: `Install ReShade for ${ctx.game.exePath ? basename(ctx.game.exePath) : ctx.game.name} with its own setup (reshade.me), then pick the preset in ReShade's overlay. NexusForge doesn't run installers.`
          }
    )
  }
}

/** Shared strategies, in the order they are tried. */
export const STRATEGIES: InstallStrategy[] = [installerStrategy, saveStrategy, frameworkModStrategy, reshadePresetStrategy]

/** Raised when shared classification rules change: every mod is laid out again (manual layouts excepted). */
export const SHARED_RULES_REVISION = 1

/** Classifies a package: shared strategies first, then the game's own rules, then shared amendments. */
export async function classifyPackage(pkg: StagedPackage, ctx: ClassifyContext): Promise<Classification> {
  for (const s of STRATEGIES) {
    const hit = await s.match?.(pkg, ctx)
    if (hit) return { ...hit, meta: { ...hit.meta, strategy: s.id } }
  }
  const cls = await ctx.integration.classify(pkg, ctx.game, ctx.info, ctx.env)
  for (const s of STRATEGIES) await s.amend?.(cls, pkg, ctx)
  return cls
}
