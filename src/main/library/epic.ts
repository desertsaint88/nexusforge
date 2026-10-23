import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { DetectedGame } from '@shared/types'
import { exists, safeReaddir } from '../util/fs'
import { regValue } from '../util/exec'
import { findMainExecutable } from './exe-detect'

interface EpicManifest {
  DisplayName?: string
  InstallLocation?: string
  LaunchExecutable?: string
  AppName?: string
  CatalogNamespace?: string
  CatalogItemId?: string
  MainGameAppName?: string
  InstallSize?: number
  bIsIncompleteInstall?: boolean
  AppCategories?: string[]
}

async function manifestDir(): Promise<string | undefined> {
  const fromReg = await regValue('HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath')
  const candidates = [fromReg ? join(fromReg, 'Manifests') : undefined, 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests']
  for (const c of candidates) if (c && (await exists(c))) return c
  return undefined
}

export async function scanEpic(): Promise<DetectedGame[]> {
  const dir = await manifestDir()
  if (!dir) return []
  const games: DetectedGame[] = []
  for (const e of await safeReaddir(dir)) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.item')) continue
    try {
      const m = JSON.parse(await fsp.readFile(join(dir, e.name), 'utf8')) as EpicManifest
      if (!m.DisplayName || !m.InstallLocation || !m.AppName) continue
      if (m.bIsIncompleteInstall) continue
      // DLC manifests point at their parent game.
      if (m.MainGameAppName && m.MainGameAppName !== m.AppName) continue
      if (m.AppCategories && !m.AppCategories.some((c) => c === 'games')) continue
      if (!(await exists(m.InstallLocation))) continue
      const exePath = m.LaunchExecutable ? join(m.InstallLocation, m.LaunchExecutable) : await findMainExecutable(m.InstallLocation, m.DisplayName)
      const launchId = [m.CatalogNamespace, m.CatalogItemId, m.AppName].filter(Boolean).join('%3A')
      games.push({
        id: `epic:${m.AppName}`,
        name: m.DisplayName,
        platform: 'epic',
        platformId: m.AppName,
        installDir: m.InstallLocation,
        exePath,
        launch: { kind: 'url', url: `com.epicgames.launcher://apps/${launchId}?action=launch&silent=true` },
        art: { capsule: [], hero: [], header: [], logo: [] },
        sizeBytes: m.InstallSize
      })
    } catch {
      // unreadable manifest
    }
  }
  return games
}
