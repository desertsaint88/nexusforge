import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVdf, vstr, vget } from '../src/main/library/vdf'
import { findExecutables } from '../src/main/library/exe-detect'
import { cleanGameName, scanCustomFolders } from '../src/main/library/custom'
import { parseGamingRoot, publisherId } from '../src/main/library/xbox-ids'
import { findPreset } from '../src/main/library/presets'

describe('vdf', () => {
  it('parses libraryfolders and escaped paths', () => {
    const text = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"228980"		"177083846"
		}
	}
	"1" { "path" "E:\\\\SteamLibrary" }
}`
    const vdf = parseVdf(text)
    expect(vstr(vdf, 'libraryfolders', '0', 'path')).toBe('C:\\Program Files (x86)\\Steam')
    expect(vstr(vdf, 'LIBRARYFOLDERS', '1', 'PATH')).toBe('E:\\SteamLibrary')
    expect(vget(vdf, 'libraryfolders', '0', 'apps')).toEqual({ '228980': '177083846' })
  })

  it('parses app manifests', () => {
    const acf = `"AppState"\n{\n\t"appid"\t\t"438100"\n\t"name"\t\t"VRChat"\n\t"installdir"\t\t"VRChat"\n}`
    const s = vget(parseVdf(acf), 'AppState')
    expect(vstr(s, 'appid')).toBe('438100')
    expect(vstr(s, 'installdir')).toBe('VRChat')
  })
})

describe('xbox ids', () => {
  it('computes the publisher id Windows uses in package family names', () => {
    expect(publisherId('CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US')).toBe('8wekyb3d8bbwe')
  })

  it('parses .GamingRoot', () => {
    const buf = Buffer.concat([Buffer.from('RGBX', 'ascii'), Buffer.from([1, 0, 0, 0]), Buffer.from('XboxGames\u0000', 'utf16le')])
    expect(parseGamingRoot(buf, 'C:\\')).toEqual(['C:\\XboxGames'])
  })
})

describe('game names and presets', () => {
  it('cleans release folder names', () => {
    expect(cleanGameName('The.Witcher.3.Wild.Hunt-GOG')).toBe('The Witcher 3 Wild Hunt')
    expect(cleanGameName('Sniper Killer [FitGirl Repack]')).toBe('Sniper Killer')
    expect(cleanGameName('People Playground')).toBe('People Playground')
    expect(cleanGameName('Hades II v1.0.2')).toBe('Hades II')
    expect(cleanGameName('Call-Of-Duty-Black-Ops-III')).toBe('Call Of Duty Black Ops III')
    expect(cleanGameName('Bodycam-AnkerGames')).toBe('Bodycam')
    expect(cleanGameName('Half-Life')).toBe('Half-Life')
    expect(cleanGameName('BeamNG.drive')).toBe('BeamNG.drive')
  })

  it('finds presets by Steam app id and by name', () => {
    expect(findPreset({ platform: 'steam', platformId: '489830', name: 'whatever' })?.target).toBe('Data')
    expect(findPreset({ platform: 'custom', name: 'Grand Theft Auto V' })?.sources?.nexus).toBe('gta5')
    expect(findPreset({ platform: 'custom', name: 'Unknown Game' })).toBeUndefined()
  })
})

describe('executable detection', () => {
  let root: string
  beforeEach(async () => {
    root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-exe-'))
  })
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  const exe = async (rel: string, kb: number) => {
    await fsp.mkdir(join(root, rel, '..'), { recursive: true })
    await fsp.writeFile(join(root, rel), Buffer.alloc(kb * 1024))
  }

  it('prefers the real game binary over helpers', async () => {
    const dir = join(root, 'Cool Game')
    await exe('Cool Game/unins000.exe', 3000)
    await exe('Cool Game/UnityCrashHandler64.exe', 1500)
    await exe('Cool Game/_CommonRedist/vcredist_x64.exe', 20000)
    await exe('Cool Game/CoolGame.exe', 650)
    await exe('Cool Game/Launcher.exe', 4000)
    const found = await findExecutables(dir, 'Cool Game')
    expect(found[0].path).toBe(join(dir, 'CoolGame.exe'))
    expect(found.some((f) => /unins|crash|vcredist/i.test(f.path))).toBe(false)
  })

  it('expands container folders when scanning custom roots', async () => {
    await exe('Alpha/Alpha.exe', 900)
    await exe('Old Drive/Beta/Beta.exe', 900)
    await exe('Old Drive/Gamma/bin/Gamma.exe', 900)
    await exe('Old Drive/Gamma/Gamma.exe', 900)
    const games = await scanCustomFolders([root], new Set())
    expect(games.map((g) => g.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})
