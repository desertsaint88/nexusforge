import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterContext } from '../src/main/sources/types'
import { createFrameworksAdapter, frameworkDependency, gameRuntime } from '../src/main/sources/frameworks'

// Asset names as they appear on the real GitHub releases (BepInEx 5.4.23.6 / 6.0.0-pre.2, MelonLoader 0.7.3).
const RELEASES: Record<string, unknown[]> = {
  'BepInEx/BepInEx': [
    {
      tag_name: 'v5.4.23.6', name: '5.4.23.6', prerelease: false, draft: false, published_at: '2026-05-01T00:00:00Z', html_url: '',
      assets: ['BepInEx_linux_x64_5.4.23.6.zip', 'BepInEx_Patcher_5.4.23.6.zip', 'BepInEx_win_x64_5.4.23.6.zip', 'BepInEx_win_x86_5.4.23.6.zip'].map((name) => ({ name, size: 1, browser_download_url: `https://dl/${name}` }))
    },
    {
      tag_name: 'v6.0.0-pre.2', name: '6.0.0-pre.2', prerelease: true, draft: false, published_at: '2024-09-01T00:00:00Z', html_url: '',
      assets: [
        'BepInEx-NET.CoreCLR-net6.0-win-x64-6.0.0-pre.2.zip', 'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip', 'BepInEx-Unity.IL2CPP-win-x86-6.0.0-pre.2.zip',
        'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip', 'BepInEx-Unity.Mono-linux-x64-6.0.0-pre.2.zip'
      ].map((name) => ({ name, size: 1, browser_download_url: `https://dl/${name}` }))
    }
  ],
  'LavaGang/MelonLoader': [
    {
      tag_name: 'v0.7.3', name: '0.7.3', prerelease: false, draft: false, published_at: '2026-01-01T00:00:00Z', html_url: '',
      assets: ['MelonLoader.Installer.exe', 'MelonLoader.Linux.x64.zip', 'MelonLoader.x64.zip', 'MelonLoader.x86.zip'].map((name) => ({ name, size: 1, browser_download_url: `https://dl/${name}` }))
    }
  ]
}

describe('mod loaders', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-fw-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  // A minimal PE header: "MZ", e_lfanew = 64, "PE\0\0", machine.
  const exe = async (machine: number) => {
    const b = Buffer.alloc(128)
    b.write('MZ', 0, 'ascii')
    b.writeUInt32LE(64, 0x3c)
    b.write('PE\0\0', 64, 'ascii')
    b.writeUInt16LE(machine, 68)
    await fsp.writeFile(join(dir, 'Game.exe'), b)
    return join(dir, 'Game.exe')
  }
  const ctxFor = (game: { installDir: string; exePath: string }): AdapterContext => ({
    getGame: () => ({ ...game, id: 'g', name: 'Game' }) as never,
    binding: async () => undefined,
    apiKey: () => undefined,
    json: async <T,>(url: string) => RELEASES[url.match(/repos\/([^/]+\/[^/]+)\//)![1]] as T,
    text: async () => '',
    browserHtml: async () => '',
    log: { info() {}, warn() {}, error() {} }
  })

  it('picks BepInEx 5 for a 64-bit Unity Mono game', async () => {
    const exePath = await exe(0x8664)
    await fsp.mkdir(join(dir, 'Game_Data', 'Managed'), { recursive: true })
    expect(await gameRuntime({ installDir: dir, exePath })).toEqual({ unity: 'mono', arch: 'x64' })
    const d = await createFrameworksAdapter(ctxFor({ installDir: dir, exePath })).getModDetails('bepinex', 'g')
    expect(d.versions[0].fileName).toBe('BepInEx_win_x64_5.4.23.6.zip')
    expect(d.versions[0].primary).toBe(true)
    expect(d.versions.some((v) => /linux|patcher|il2cpp|coreclr/i.test(v.fileName!))).toBe(false)
  })

  it('picks the IL2CPP edition for IL2CPP games and the 32-bit build for 32-bit games', async () => {
    const exePath = await exe(0x14c)
    await fsp.writeFile(join(dir, 'GameAssembly.dll'), '')
    const adapter = createFrameworksAdapter(ctxFor({ installDir: dir, exePath }))
    const d = await adapter.getModDetails('bepinex', 'g')
    expect(d.versions.map((v) => v.fileName)).toEqual(['BepInEx-Unity.IL2CPP-win-x86-6.0.0-pre.2.zip'])
    const ml = await adapter.getModDetails('melonloader', 'g')
    expect(ml.versions[0].fileName).toBe('MelonLoader.x86.zip')
    expect(await adapter.getDownloadUrl('melonloader', ml.versions[0].id)).toBe('https://dl/MelonLoader.x86.zip')
  })

  it('turns linked-only requirements into installable ones', () => {
    const ext = { sourceId: '', name: 'BepInEx', required: true, installable: false, url: 'https://github.com/BepInEx/BepInEx' }
    expect(frameworkDependency(ext)).toMatchObject({ sourceId: 'frameworks', modId: 'bepinex', installable: true })
    expect(frameworkDependency({ ...ext, name: 'MelonLoader', url: undefined })).toMatchObject({ modId: 'melonloader' })
    expect(frameworkDependency({ ...ext, name: 'SKSE64', url: 'https://skse.silverlock.org' })).toBeUndefined()
    // Requirements a source can already install (e.g. a Thunderstore BepInExPack) stay as they are.
    expect(frameworkDependency({ sourceId: 'thunderstore', modId: 'denikson-BepInExPack_Valheim', name: 'BepInExPack Valheim', required: true, installable: true })).toBeUndefined()
  })
})
