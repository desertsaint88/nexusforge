import { join } from 'node:path'
import type { DetectedGame } from '@shared/types'
import { exists } from '../util/fs'
import { regSubKeys } from '../util/exec'

export async function scanGog(): Promise<DetectedGame[]> {
  const keys = await regSubKeys('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games')
  const games: DetectedGame[] = []
  for (const values of Object.values(keys)) {
    const id = values.gameID
    const name = values.gameName
    const path = values.path
    if (!id || !name || !path || values.dependsOn) continue
    if (!(await exists(path))) continue
    const exe = values.exe || (values.exeFile ? join(path, values.exeFile) : undefined)
    const galaxy = 'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe'
    const useGalaxy = await exists(galaxy)
    games.push({
      id: `gog:${id}`,
      name,
      platform: 'gog',
      platformId: id,
      installDir: path,
      exePath: exe,
      launch: useGalaxy
        ? { kind: 'exe', exe: galaxy, args: ['/command=runGame', `/gameId=${id}`, `/path=${path}`] }
        : { kind: 'exe', exe: exe ?? '', args: values.launchParam ? values.launchParam.split(' ') : undefined, cwd: values.workingDir || path },
      art: { capsule: [], hero: [], header: [], logo: [] }
    })
  }
  return games
}
