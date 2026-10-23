import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { DetectedGame } from '@shared/types'
import { exists, safeReaddir } from '../util/fs'
import { mediaUrl } from '../media-protocol'
import { findMainExecutable } from './exe-detect'
import { parseGamingRoot, publisherId } from './xbox-ids'

function attr(xml: string, tag: string, name: string): string | undefined {
  const tagMatch = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>`, 'i'))
  if (!tagMatch) return undefined
  const m = tagMatch[0].match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m?.[1]
}

async function gamingRoots(): Promise<string[]> {
  const roots: string[] = []
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`
    const marker = join(drive, '.GamingRoot')
    try {
      const buf = await fsp.readFile(marker)
      for (const r of parseGamingRoot(buf, drive)) if (await exists(r)) roots.push(r)
    } catch {
      // no marker on this drive
    }
  }
  if (!roots.length && (await exists('C:\\XboxGames'))) roots.push('C:\\XboxGames')
  return roots
}

export async function scanXbox(): Promise<DetectedGame[]> {
  const games: DetectedGame[] = []
  for (const root of await gamingRoots()) {
    for (const e of await safeReaddir(root)) {
      if (!e.isDirectory()) continue
      const content = join(root, e.name, 'Content')
      const configPath = join(content, 'MicrosoftGame.config')
      if (!(await exists(configPath))) continue
      try {
        const config = await fsp.readFile(configPath, 'utf8')
        let manifest = ''
        try {
          manifest = await fsp.readFile(join(content, 'AppxManifest.xml'), 'utf8')
        } catch {
          // older installs have no AppxManifest next to the config
        }
        const identityName = attr(manifest, 'Identity', 'Name') ?? attr(config, 'Identity', 'Name')
        const publisher = attr(manifest, 'Identity', 'Publisher') ?? attr(config, 'Identity', 'Publisher')
        const appId = attr(manifest, 'Application', 'Id') ?? attr(config, 'Executable', 'Id') ?? 'Game'
        let name = attr(config, 'ShellVisuals', 'DefaultDisplayName') ?? attr(manifest, 'VisualElements', 'DisplayName') ?? e.name
        if (name.startsWith('ms-resource:')) name = e.name
        const exeName = attr(config, 'Executable', 'Name')
        const exePath = exeName ? join(content, exeName) : await findMainExecutable(content, name)
        const logoRel = attr(config, 'ShellVisuals', 'Square480x480Logo') ?? attr(config, 'ShellVisuals', 'Square150x150Logo') ?? attr(config, 'ShellVisuals', 'StoreLogo')
        const logo = logoRel ? join(content, logoRel) : undefined
        const aumid = identityName && publisher ? `${identityName}_${publisherId(publisher)}!${appId}` : undefined
        games.push({
          id: `xbox:${identityName ?? basename(e.name)}`,
          name,
          platform: 'xbox',
          platformId: identityName,
          installDir: content,
          exePath,
          launch: aumid ? { kind: 'appx', aumid } : { kind: 'exe', exe: exePath ?? '' },
          art: { capsule: [], hero: [], header: [], logo: [], icon: logo && (await exists(logo)) ? mediaUrl(logo) : undefined }
        })
      } catch {
        // unreadable config
      }
    }
  }
  return games
}
