import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGameRoots, gameRootsOnDrive } from '../src/main/library/drives'
import { cleanGameName, scanCustomFolders } from '../src/main/library/custom'

describe('game folders on a drive', () => {
  let drive: string
  beforeEach(async () => {
    drive = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-drive-'))
  })
  afterEach(async () => {
    await fsp.rm(drive, { recursive: true, force: true })
  })
  const exe = async (rel: string, kb = 900) => {
    await fsp.mkdir(join(drive, rel, '..'), { recursive: true })
    await fsp.writeFile(join(drive, rel), Buffer.alloc(kb * 1024))
  }

  it('finds Games folders, stray Steam libraries and launcher folders, and skips the rest', async () => {
    await exe('Games/Alpha/Alpha.exe')
    await exe('Games/Steam/steamapps/common/Delta/Delta.exe')
    await exe('SteamLibrary/steamapps/common/Beta/Beta.exe')
    await exe('Program Files/Epic Games/Gamma/Gamma.exe')
    await exe('Program Files/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe')
    await exe('Program Files (x86)/Rockstar Games/Social Club/SocialClubHelper.exe')
    await exe('Tools/SomeApp/SomeApp.exe')
    await exe('Users/me/Downloads/Setup/thing.exe')
    const roots = await gameRootsOnDrive(drive)
    const rel = roots.map((r) => r.slice(drive.length + 1).replace(/\\/g, '/')).sort()
    expect(rel).toEqual([
      'Games',
      'Games/Steam/steamapps/common',
      'Program Files (x86)/Rockstar Games',
      'Program Files/Epic Games',
      'SteamLibrary/steamapps/common'
    ])
    const games = await scanCustomFolders(roots, new Set())
    expect(games.map((g) => g.name).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
  })
})

describe('release folder names', () => {
  it('drops versions, groups and years', () => {
    expect(cleanGameName('Hell.Let.Loose.Vietnam.v1.4.1.1176458-OFME')).toBe('Hell Let Loose Vietnam')
    expect(cleanGameName('People.Playground.v2026.02.09')).toBe('People Playground')
    expect(cleanGameName('Hollow-Knight-SteamRIP.com')).toBe('Hollow Knight')
    expect(cleanGameName('Uplink (GOG)')).toBe('Uplink')
    expect(cleanGameName('Call of Duty - Modern Warfare 4 (2026)')).toBe('Call of Duty - Modern Warfare 4')
    expect(cleanGameName('Way-of-the-Hunter-2-AnkerGames')).toBe('Way of the Hunter 2')
    expect(cleanGameName('X-Plane 12')).toBe('X-Plane 12')
    expect(cleanGameName('GROUND BRANCH')).toBe('GROUND BRANCH')
  })
})

// Opt-in check against this PC's real drives (read-only): NEXUSFORGE_REAL_DRIVES=1 npx vitest run tests/drives.test.ts
describe.skipIf(!process.env.NEXUSFORGE_REAL_DRIVES)('this PC', () => {
  it('lists the game folders and games on every drive', async () => {
    const roots = await findGameRoots()
    const games = await scanCustomFolders(roots, new Set())
    console.log(`roots:\n  ${roots.join('\n  ')}\ngames (${games.length}):\n  ${games.map((g) => `${g.name}  <-  ${g.installDir}`).join('\n  ')}`)
    expect(roots.length).toBeGreaterThan(0)
  }, 120_000)
})
