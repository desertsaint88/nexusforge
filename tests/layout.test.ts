import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyThunderstoreLayout, detectRoot } from '../src/main/mods/layout'
import { walkFiles } from '../src/main/util/fs'

let root: string
const touch = async (rel: string, content = 'x') => {
  await fsp.mkdir(join(root, rel, '..'), { recursive: true })
  await fsp.writeFile(join(root, rel), content)
}

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-layout-'))
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('detectRoot', () => {
  it('strips a wrapper folder and descends into the target folder', async () => {
    await touch('Cool Mod v1.2/readme.txt')
    await touch('Cool Mod v1.2/Data/meshes/a.nif')
    expect(await detectRoot(root, 'Data')).toBe('Cool Mod v1.2/Data')
  })

  it('keeps archives that are already laid out', async () => {
    await touch('meshes/a.nif')
    await touch('Cool.esp')
    expect(await detectRoot(root, 'Data')).toBe('')
  })

  it('does not unwrap known game folders', async () => {
    await touch('bin/x64/plugin.dll')
    expect(await detectRoot(root, 'Cyberpunk 2077')).toBe('')
  })

  it('keeps the addon folder for games where every mod is its own folder', async () => {
    await touch('my_addon/lua/autorun/init.lua')
    expect(await detectRoot(root, 'addons', true)).toBe('')
  })
})

describe('thunderstore layout', () => {
  it('maps a plugin package into BepInEx/plugins/<name>', async () => {
    await touch('manifest.json', JSON.stringify({ name: 'CoolPlugin', version_number: '1.0.0', website_url: '', description: '', dependencies: [] }))
    await touch('icon.png')
    await touch('README.md')
    await touch('CoolPlugin.dll')
    await touch('config/cool.cfg')
    const rootPath = await applyThunderstoreLayout(root, 'Author-CoolPlugin')
    expect(rootPath).toBe('__deploy')
    const files = (await walkFiles(join(root, rootPath))).map((f) => f.rel).sort()
    expect(files).toEqual(['BepInEx/config/cool.cfg', 'BepInEx/plugins/Author-CoolPlugin/CoolPlugin.dll'])
  })

  it('deploys BepInExPack from its pack folder', async () => {
    await touch('manifest.json', JSON.stringify({ name: 'BepInExPack_Valheim', version_number: '5.4.0' }))
    await touch('BepInExPack_Valheim/winhttp.dll')
    await touch('BepInExPack_Valheim/BepInEx/core/BepInEx.dll')
    expect(await applyThunderstoreLayout(root, 'denikson-BepInExPack_Valheim')).toBe('BepInExPack_Valheim')
  })
})
