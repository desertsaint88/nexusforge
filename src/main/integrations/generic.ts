// Games NexusForge has no specific knowledge of: files go into the game's deploy folder (from the game's
// preset, or the install folder) as the package lays them out. Read-me files stay out, and packages that are
// clearly save games are not dumped into the game folder.

import { basename } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, StagedPackage } from './types'
import { findPreset } from '../library/presets'
import { applyThunderstoreLayout, detectRoot, readThunderstoreManifest } from '../mods/layout'
import { walkFiles } from '../util/fs'
import { distributionOf, isDocFile, route, skipDocs } from './common'

const SAVE_FILE = /^(sgta\d+.*|.*\.sav|.*\.save|savegame.*|save\d*\.dat|.*\.sl2|.*\.ess|.*\.fos)$/i

/** A package that is nothing but save files, from a download that says it is a save. */
export function looksLikeSave(pkg: StagedPackage, files: string[]): boolean {
  const name = `${pkg.name} ${pkg.archiveName ?? ''}`
  if (!/\bsave(s|game|file)?\b|100 ?%|100 percent/i.test(name)) return false
  const real = files.filter((f) => !isDocFile(basename(f)))
  return real.length > 0 && real.every((f) => SAVE_FILE.test(basename(f)) || /\.bak$/i.test(f))
}

export async function genericClassify(pkg: StagedPackage, game: Game): Promise<Classification> {
  const preset = findPreset(game)
  if (preset?.keepArchive) {
    return { kind: 'archive', routes: [route('', 'game')], skipped: [], checks: [], rootPath: '' }
  }
  const ts = pkg.source?.sourceId === 'thunderstore' ? pkg.source.modId.replace('/', '-') : undefined
  const tsManifest = await readThunderstoreManifest(pkg.dir)
  if (ts || tsManifest) {
    const rootPath = await applyThunderstoreLayout(pkg.dir, ts ?? tsManifest?.name ?? 'plugin')
    return { kind: 'plugin', routes: [route(rootPath, 'game')], skipped: [], checks: [], rootPath, name: tsManifest?.name?.replace(/_/g, ' '), version: tsManifest?.version_number }
  }
  const rootPath = await detectRoot(pkg.dir, basename(game.modding.targetDir), preset?.keepWrapper)
  const files = (await walkFiles(pkg.dir)).map((f) => f.rel)
  if (looksLikeSave(pkg, files)) {
    return {
      kind: 'savegame',
      routes: [],
      skipped: [],
      rootPath,
      checks: [
        {
          level: 'error',
          code: 'savegame',
          message: `This is a save game. Saves don't belong in the game folder and NexusForge doesn't know where ${game.name} keeps them, so it is not deployed. Open the mod folder and copy the save where the mod page says.`
        }
      ]
    }
  }
  return { kind: 'files', routes: [route(rootPath, 'game')], skipped: skipDocs(pkg.files, rootPath), checks: [], rootPath }
}

export const genericIntegration: GameIntegration = {
  id: 'generic',
  revision: 1,
  loadVerifiable: false,
  loaders: [],
  async matches() {
    return true
  },
  async inspect(game: Game, _env: IntegrationEnv, _state: IntegrationState, _mods: InstalledMod[]): Promise<IntegrationInfo> {
    const preset = findPreset(game)
    return {
      gameId: game.id,
      integrationId: 'generic',
      name: preset ? 'Known mod folder' : 'Generic',
      support: 'basic',
      distribution: await distributionOf(game),
      version: game.version || undefined,
      valid: !game.missing,
      problems: game.missing ? ['The install folder is missing.'] : [],
      targets: [{ id: 'game', label: preset?.target ? 'Mods folder' : 'Game folder', dir: game.modding.targetDir }],
      loaders: [],
      launchOptions: [{ id: 'default', label: 'Play', available: true, primary: true }],
      capabilities: ['Puts mod files into the deploy folder as the package lays them out, and removes them again cleanly.'],
      warnings: [],
      limitations: [
        `NexusForge has no specific support for ${game.name}: it can check that the files are in place, not that the game loads them. Mods that need a mod loader or a special folder may need the deploy folder changed in the game settings.`
      ],
      inspectedAt: Date.now()
    }
  },
  classify: genericClassify
}
