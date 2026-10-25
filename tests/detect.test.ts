import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Game } from '@shared/types'
import { detectGameMods, gmaTitle, prettyName } from '../src/main/mods/detect-core'
import { matchKind, storeQueries } from '../src/main/library/names'
import { sortResults } from '@shared/sort'
import { installedIndex, isInstalled } from '@shared/installed'

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-detect-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const put = async (rel: string, content: string | Buffer = '') => {
  const p = join(dir, rel)
  await fsp.mkdir(join(p, '..'), { recursive: true })
  await fsp.writeFile(p, content)
  return p
}

const game = (name: string, extra: Partial<Game> = {}): Game => ({
  id: `custom:${name}`,
  name,
  platform: 'custom',
  installDir: dir,
  launch: { kind: 'exe', exe: join(dir, 'game.exe') },
  art: { capsule: [], hero: [], header: [], logo: [] },
  playtimeMinutes: 0,
  addedAt: 0,
  modding: { targetDir: dir, strategy: 'symlink', sources: {} },
  ...extra
})

/** A minimal .gma: magic, version 3, steamid, timestamp, empty required list, name, description, author. */
function gma(name: string): Buffer {
  return Buffer.concat([Buffer.from('GMAD'), Buffer.from([3]), Buffer.alloc(16), Buffer.from([0]), Buffer.from(`${name}\0desc\0author\0`), Buffer.alloc(8)])
}

describe('installed mod detection', () => {
  it('reads BepInEx plugins: Thunderstore manifests, loose DLLs and disabled files', async () => {
    await put('UnityPlayer.dll')
    await put('BepInEx/core/BepInEx.dll', 'x')
    await put('BepInEx/plugins/ValheimPlus-ValheimPlus/manifest.json', JSON.stringify({ name: 'ValheimPlus', version_number: '0.9.9' }))
    await put('BepInEx/plugins/ValheimPlus-ValheimPlus/ValheimPlus.dll', 'x')
    await put('BepInEx/plugins/Loose.dll', 'x')
    await put('BepInEx/plugins/Old.dll.disabled', 'x')
    const info = await detectGameMods(game('Some Unity Game'))
    const names = info.mods.map((m) => `${m.kind}:${m.name}${m.enabled === false ? ' (off)' : ''}`)
    expect(names).toEqual(['loader:BepInEx', 'bepinex:Loose', 'bepinex:Old (off)', 'bepinex:ValheimPlus'])
    const vp = info.mods.find((m) => m.name === 'ValheimPlus')!
    expect(vp.version).toBe('0.9.9')
    expect(vp.source).toEqual({ sourceId: 'thunderstore', modId: 'ValheimPlus/ValheimPlus' })
    expect(vp.detectedBy).toBe('manifest.json')
    expect(info.supported).toBe(true)
    expect(info.support).toContain('BepInEx installed')
    expect(info.engine).toBe('unity')
  })

  it("names Garry's Mod addons from addon.json, GMA headers and folder names", async () => {
    await put('garrysmod/addons/amogus_gun/lua/x.lua')
    await put('garrysmod/addons/with_meta/addon.json', JSON.stringify({ title: 'Proper Title' }))
    await put('garrysmod/addons/ds_123456789.gma', gma('Packed Addon'))
    expect(await gmaTitle(join(dir, 'garrysmod/addons/ds_123456789.gma'))).toBe('Packed Addon')
    const info = await detectGameMods(game('GarrysMod'))
    const byName = new Map(info.mods.map((m) => [m.name, m]))
    expect([...byName.keys()].sort()).toEqual(['Amogus Gun', 'Packed Addon', 'Proper Title'])
    expect(byName.get('Packed Addon')!.source).toEqual({ sourceId: 'steamworkshop', modId: '123456789' })
    expect(info.support).toContain("Garry's Mod addons")
  })

  it('finds Unreal .pak mods but not the base game paks', async () => {
    await put('MyGame/Content/Paks/pakchunk0-Windows.pak')
    await put('MyGame/Content/Paks/MyGame-Windows.pak')
    await put('MyGame/Content/Paks/CoolMod_P.pak')
    await put('MyGame/Content/Paks/~mods/Another_P.pak')
    await put('MyGame/Content/Paks/~mods/Another_P.ucas')
    await put('MyGame/Content/Paks/LogicMods/Logic.pak')
    const info = await detectGameMods(game('My Game'))
    expect(info.mods.map((m) => m.name).sort()).toEqual(['Another', 'CoolMod', 'Logic'])
    expect(info.engine).toBe('unreal')
    expect(info.support).toContain('Unreal Engine (.pak mods)')
  })

  it('reads BeamNG mods from db.json in the user folder (startup.ini) and skips other files', async () => {
    const user = join(dir, 'user')
    await put('BeamNG.drive.exe')
    await put('startup.ini', `UserPath = ${user}\n`)
    const mods = join(user, 'current', 'mods')
    await put('user/current/mods/car_jump_arena.zip', 'zip')
    await put('user/current/mods/unregistered.zip', 'zip')
    await put('user/current/mods/DiscordSetup.exe', 'exe')
    await put(
      'user/current/mods/db.json',
      JSON.stringify({
        mods: {
          car_jump_arena: { active: false, fullpath: '/mods/car_jump_arena.zip', modData: { title: 'Car Jump Arena', resource_id: 1362, version_string: 'Final Release', username: 'someone' } }
        }
      })
    )
    const info = await detectGameMods(game('BeamNG.drive'))
    const arena = info.mods.find((m) => m.name === 'Car Jump Arena')!
    expect(arena.enabled).toBe(false)
    expect(arena.source).toEqual({ sourceId: 'beamng', modId: '1362' })
    expect(arena.path).toBe(join(mods, 'car_jump_arena.zip'))
    expect(info.mods.map((m) => m.name).sort()).toEqual(['Car Jump Arena', 'Unregistered'])
  })

  it('reads BO3 workshop.json, X-Plane add-ons and Bethesda plugins', async () => {
    await put('BlackOps3.exe')
    await put('mods/zm_cool/zone/workshop.json', JSON.stringify({ Title: 'Cool Zombies', PublisherID: '987654321' }))
    await put('usermaps/zm_map/zone/x.ff')
    await put('Custom Scenery/X-Plane Landmarks - London/x.dsf')
    await put('Custom Scenery/Aerosoft - LPFR Faro/x.dsf')
    await put('Aircraft/Laminar Research/x.acf')
    await put('Aircraft/Fancy Jet/x.acf')
    await put('Data/Skyrim.esm')
    await put('Data/Update.esm')
    await put('Data/SkyUI_SE.esp')
    const info = await detectGameMods(game('Mixed'))
    const names = info.mods.map((m) => `${m.kind}:${m.name}`).sort()
    expect(names).toEqual(['aircraft:Fancy Jet', 'bo3:Cool Zombies', 'bo3:Zm Map', 'plugin:SkyUI_SE', 'scenery:Aerosoft - LPFR Faro'])
    expect(info.mods.find((m) => m.name === 'Cool Zombies')!.source).toEqual({ sourceId: 'steamworkshop', modId: '987654321' })
  })

  it('marks files NexusForge deployed and says when a game has no known mod support', async () => {
    const addon = await put('garrysmod/addons/managed_one/lua/a.lua')
    const info = await detectGameMods(game('GarrysMod'), { managed: [[addon.toLowerCase(), 'mod-1']], managedCount: 1 })
    expect(info.mods[0].managedModId).toBe('mod-1')
    expect(info.support).toContain('Mods installed with NexusForge')

    await fsp.rm(join(dir, 'garrysmod'), { recursive: true })
    await put('EasyAntiCheat/x.dll')
    const locked = await detectGameMods(game('Locked Shooter'))
    expect(locked.supported).toBe(false)
    expect(locked.support.join()).toMatch(/EasyAntiCheat/)
  })

  it('makes readable names', () => {
    expect(prettyName('amogus_gun')).toBe('Amogus Gun')
    expect(prettyName('CrashHard20.zip')).toBe('CrashHard20')
  })
})

describe('store name matching', () => {
  it('builds store queries from folder-style names', () => {
    expect(storeQueries('Call of Duty - Modern Warfare 4')).toContain('Call of Duty: Modern Warfare 4')
    expect(storeQueries('FNAF In Real Time')).toContain("Five Nights at Freddy's In Real Time")
    expect(storeQueries('Rolla Demo')).toContain('Rolla')
  })

  it('accepts punctuation and edition differences, refuses other games', () => {
    expect(matchKind('Hell Let Loose Vietnam', 'Hell Let Loose: Vietnam')).toBe('exact')
    expect(matchKind('GarrysMod', "Garry's Mod")).toBe('exact')
    expect(matchKind('Call of Duty: Modern Warfare 4', 'Call of Duty®: Modern Warfare® 4')).toBe('exact')
    expect(matchKind('Rolla Demo', 'ROLLA')).toBe('edition')
    expect(matchKind('Grand Theft Auto V', 'Grand Theft Auto V Enhanced')).toBe('edition')
    expect(matchKind('Rolla Demo', 'Rollamon Demo')).toBeUndefined()
    expect(matchKind('Rolla', 'ROLLA Soundtrack')).toBeUndefined()
    expect(matchKind('Watch Dogs', 'Watch Dogs 2')).toBeUndefined()
  })
})

describe('mod sorting and installed matching', () => {
  const now = Date.parse('2026-10-25T00:00:00Z')
  const day = 86_400_000
  const r = (id: string, x: { e?: number; d?: number; c?: number; u?: number }) => ({
    id,
    sourceId: 'nexus',
    name: id,
    summary: '',
    endorsements: x.e,
    downloads: x.d,
    createdAt: x.c !== undefined ? new Date(now - x.c * day).toISOString() : undefined,
    updatedAt: x.u !== undefined ? new Date(now - x.u * day).toISOString() : undefined
  })
  const list = [r('old-classic', { e: 5000, d: 900000, c: 900, u: 400 }), r('new-hit', { e: 300, d: 4000, c: 3, u: 2 }), r('fresh-meh', { e: 2, d: 50, c: 1, u: 1 })]

  it('orders by rating, downloads, date and trend', () => {
    expect(sortResults(list, 'endorsed', now).map((x) => x.id)).toEqual(['old-classic', 'new-hit', 'fresh-meh'])
    expect(sortResults(list, 'downloads', now)[0].id).toBe('old-classic')
    expect(sortResults(list, 'newest', now)[0].id).toBe('fresh-meh')
    expect(sortResults(list, 'trending', now)[0].id).toBe('new-hit')
    expect(sortResults(list, 'downloads_recent', now).map((x) => x.id)).toEqual(['new-hit', 'fresh-meh', 'old-classic'])
  })

  it('recognizes installed mods by source id (BeamNG numeric ids too) and by exact name', () => {
    const index = installedIndex(
      [{ source: { sourceId: 'nexus', modId: 'skyrim/1/12604' } } as never],
      [
        { key: 'a', kind: 'beamng', name: 'Car Jump Arena', path: 'x', detectedBy: 'db.json', source: { sourceId: 'beamng', modId: '1362' } },
        { key: 'b', kind: 'gmod-addon', name: 'Amogus Gun', path: 'y', detectedBy: 'folder layout' },
        { key: 'c', kind: 'loader', name: 'BepInEx', path: 'z', detectedBy: 'folder layout' }
      ]
    )
    expect(isInstalled(index, { sourceId: 'nexus', id: 'skyrim/1/12604', name: 'SkyUI' })).toBe(true)
    expect(isInstalled(index, { sourceId: 'beamng', id: 'car-jump-arena.1362', name: 'Car Jump Arena' })).toBe(true)
    expect(isInstalled(index, { sourceId: 'steamworkshop', id: '42', name: 'Amogus Gun v1.2' })).toBe(true)
    expect(isInstalled(index, { sourceId: 'thunderstore', id: 'x/BepInEx', name: 'BepInEx' })).toBe(false)
    expect(isInstalled(index, { sourceId: 'nexus', id: 'other', name: 'Other Mod' })).toBe(false)
  })
})
