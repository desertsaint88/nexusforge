import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDeployment, EMPTY_PLAN, readManifest, hasInterruptedDeployment, type DeployOptions, type TargetSpec } from '../src/main/mods/deploy'
import { buildPlan, conflictReport, entryKey, type PlanMod } from '../src/main/mods/plan'
import { walkFiles, writeJsonAtomic } from '../src/main/util/fs'
import type { DeployStrategy } from '../src/shared/types'

let root: string
let game: string
let mods: string

async function write(path: string, content: string): Promise<void> {
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, content)
}

async function planMod(id: string, dir: string, revision = 1, target = 'game'): Promise<PlanMod> {
  return { id, revision, files: (await walkFiles(dir)).map((f) => ({ target, rel: f.rel, source: f.abs, size: f.size })) }
}

function opts(plan: ReturnType<typeof buildPlan>, strategy: DeployStrategy, extra: Partial<DeployOptions> = {}, targets?: Record<string, TargetSpec>): DeployOptions {
  return {
    gameId: 'test:game',
    profileId: 'p1',
    targets: targets ?? { game: { dir: game, label: 'Game folder' } },
    strategy,
    plan,
    manifestPath: join(root, 'manifest.json'),
    backupDir: join(root, 'backups'),
    overwriteDir: join(root, 'overwrite'),
    retryDelays: [5, 10],
    ...extra
  }
}

const read = (p: string) => fsp.readFile(p, 'utf8')
const errno = (code: string) => Object.assign(new Error(code), { code })
const gameFiles = async () => (await walkFiles(game)).map((f) => f.rel).sort()

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-test-'))
  game = join(root, 'game')
  mods = join(root, 'mods')
  await write(join(game, 'Data', 'original.txt'), 'ORIGINAL')
  await write(join(game, 'game.exe'), 'exe')
  await write(join(mods, 'a', 'Data', 'original.txt'), 'FROM A')
  await write(join(mods, 'a', 'Data', 'new', 'shared.txt'), 'A SHARED')
  await write(join(mods, 'b', 'Data', 'new', 'shared.txt'), 'B SHARED')
  await write(join(mods, 'b', 'Data', 'new', 'deep', 'only-b.txt'), 'ONLY B')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(root, { recursive: true, force: true })
})

describe('plan', () => {
  it('lets later mods win and honours file overrides (old path-only overrides apply to the game folder)', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const b = await planMod('b', join(mods, 'b'))
    const plan = buildPlan([a, b], {})
    expect(plan.entries.get('game|data/new/shared.txt')?.modId).toBe('b')
    expect(plan.entries.get('game|data/original.txt')?.modId).toBe('a')
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].target).toBe('game')

    const pinned = buildPlan([a, b], { 'game|data/new/shared.txt': 'a' })
    expect(pinned.entries.get('game|data/new/shared.txt')?.modId).toBe('a')
    expect(pinned.conflicts[0].overridden).toBe(true)
    expect(pinned.hash).not.toBe(plan.hash)
    const legacy = buildPlan([a, b], { 'data/new/shared.txt': 'a' })
    expect(legacy.entries.get('game|data/new/shared.txt')?.modId).toBe('a')

    const report = conflictReport(plan, 'g', 'p', ['a', 'b'])
    expect(report.groups[0].mods).toEqual(['a', 'b'])
    expect(report.perMod.b).toEqual({ wins: 1, loses: 0 })
    expect(report.perMod.a).toEqual({ wins: 0, loses: 1 })
  })

  it('treats paths case-insensitively and keeps targets apart', () => {
    const plan = buildPlan(
      [
        { id: 'x', revision: 1, files: [{ target: 'game', rel: 'Data/Tex.dds', source: 'C:\\x\\Data\\Tex.dds', size: 1 }] },
        { id: 'y', revision: 1, files: [{ target: 'game', rel: 'data/tex.DDS', source: 'C:\\y\\data\\tex.DDS', size: 2 }, { target: 'worlds', rel: 'data/tex.DDS', source: 'C:\\y\\w', size: 3 }] }
      ],
      {}
    )
    expect(plan.entries.size).toBe(2)
    expect(plan.entries.get(entryKey('game', 'Data/Tex.dds'))?.modId).toBe('y')
    expect(plan.entries.get('worlds|data/tex.dds')?.size).toBe(3)
  })
})

describe.each<DeployStrategy>(['copy', 'hardlink', 'symlink', 'auto'])('deploy (%s)', (strategy) => {
  it('deploys, backs up originals, redeploys incrementally and purges cleanly', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const b = await planMod('b', join(mods, 'b'))

    const r1 = await applyDeployment(opts(buildPlan([a, b], {}), strategy))
    expect(r1.errors).toEqual([])
    expect(r1.outcome).toBe('verified')
    expect(r1.verification?.ok).toBe(true)
    expect(r1.verification?.checked).toBe(3)
    expect(r1.placed).toBe(3)
    expect(r1.backedUp).toBe(1)
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('FROM A')
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('B SHARED')
    expect(await read(join(root, 'backups', 'Data', 'original.txt'))).toBe('ORIGINAL')
    const manifest = await readManifest(join(root, 'manifest.json'))
    expect(manifest?.entries).toHaveLength(3)
    expect(manifest?.verified?.ok).toBe(true)
    expect(Object.values(r1.methods).reduce((x, y) => x + y, 0)).toBe(3)
    if (strategy === 'auto') expect(r1.methods.hardlink).toBe(3)
    // Without symlink rights (no Developer Mode / not elevated) the engine falls back and says it calmly.
    if (strategy === 'symlink' && r1.methods.symlink === 0) {
      expect(r1.notes.join(' ')).toMatch(/nothing needs changing/)
      expect(r1.notes.join(' ')).not.toMatch(/enable developer mode/i)
    }
    expect(r1.stages.map((s) => s.stage)).toEqual(expect.arrayContaining(['plan', 'preflight', 'remove', 'place', 'verify', 'record']))

    // Disable B: its files go away, A's shared.txt takes over, nothing else is touched.
    const r2 = await applyDeployment(opts(buildPlan([a], {}), strategy))
    expect(r2.errors).toEqual([])
    expect(r2.unchanged).toBe(1)
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('A SHARED')
    await expect(fsp.access(join(game, 'Data', 'new', 'deep'))).rejects.toThrow()

    // Purge: original restored, created folders removed, manifest gone, game files intact.
    const r3 = await applyDeployment(opts(EMPTY_PLAN, strategy))
    expect(r3.errors).toEqual([])
    expect(r3.outcome).toBe('verified')
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
    await expect(fsp.access(join(game, 'Data', 'new'))).rejects.toThrow()
    expect(await readManifest(join(root, 'manifest.json'))).toBeUndefined()
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
  })
})

describe('choosing the method', () => {
  it('uses hardlinks when Windows refuses symlinks, without asking for Developer Mode', async () => {
    vi.spyOn(fsp, 'symlink').mockRejectedValue(errno('EPERM'))
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'symlink'))
    expect(r.outcome).toBe('verified')
    expect(r.methods).toEqual({ symlink: 0, hardlink: 2, copy: 0 })
    expect(r.notes[0]).toMatch(/Create symbolic links/)
    expect(r.notes[0]).toMatch(/nothing needs changing/)
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('FROM A')
  })

  it('never tries symlinks on automatic, so no rights are ever needed', async () => {
    const spy = vi.spyOn(fsp, 'symlink')
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'auto'))
    expect(r.outcome).toBe('verified')
    expect(spy).not.toHaveBeenCalled()
    expect(r.notes).toEqual([])
  })

  it('copies when the drive does not take hardlinks (other drive, FAT32) and explains it', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'))
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'auto'))
    expect(r.outcome).toBe('verified')
    expect(r.methods).toEqual({ symlink: 0, hardlink: 0, copy: 2 })
    expect(r.notes.join(' ')).toMatch(/hardlinks|copied/i)
    vi.restoreAllMocks()
    await applyDeployment(opts(EMPTY_PLAN, 'auto'))
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })

  it('always copies into save folders', async () => {
    const worlds = join(root, 'Documents', 'Worlds')
    await write(join(mods, 'map', 'Map.wld'), 'WORLD')
    const plan = buildPlan([await planMod('map', join(mods, 'map'), 1, 'worlds')], {})
    const r = await applyDeployment(opts(plan, 'hardlink', {}, { game: { dir: game }, worlds: { dir: worlds, userData: true, create: true, label: 'Worlds' } }))
    expect(r.outcome).toBe('verified')
    expect(r.methods.copy).toBe(1)
    expect(await read(join(worlds, 'Map.wld'))).toBe('WORLD')
  })
})

describe('failures roll back', () => {
  it('restores the previous setup when a file is locked during an update', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    const before = await readManifest(join(root, 'manifest.json'))
    const b = await planMod('b', join(mods, 'b'))
    const unlink = fsp.unlink
    vi.spyOn(fsp, 'unlink').mockImplementation(async (p) => {
      if (String(p).endsWith('shared.txt')) throw errno('EBUSY')
      return unlink(p)
    })
    const r = await applyDeployment(opts(buildPlan([a, b], {}), 'copy'))
    expect(r.outcome).toBe('rolled_back')
    expect(r.problem?.code).toBe('locked')
    expect(r.problem?.advice.join(' ')).toMatch(/Close the game/)
    vi.restoreAllMocks()
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('A SHARED')
    await expect(fsp.access(join(game, 'Data', 'new', 'deep'))).rejects.toThrow()
    const after = await readManifest(join(root, 'manifest.json'))
    expect(after?.entries.map((e) => e.rel).sort()).toEqual(before?.entries.map((e) => e.rel).sort())
    expect(await hasInterruptedDeployment(join(root, 'manifest.json'))).toBe(false)
  })

  it('rolls back a deployment whose checks fail afterwards (failed post-install verification)', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy', { verifyExtra: async () => [{ label: 'Loader present', ok: false, level: 'error', detail: 'core missing' }] }))
    expect(r.outcome).toBe('rolled_back')
    expect(r.problem?.code).toBe('check_failed')
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
    expect(await readManifest(join(root, 'manifest.json'))).toBeUndefined()
  })

  it('notices a placed file that is gone or different (antivirus) and rolls back', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const copy = fsp.copyFile
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dst, mode) => {
      await copy(src, dst, mode)
      if (String(dst).endsWith('shared.txt')) await fsp.writeFile(dst, 'TAMPERED')
    })
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    expect(r.outcome).toBe('rolled_back')
    expect(r.problem?.code).toBe('verify_failed')
    vi.restoreAllMocks()
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
  })

  it('rolls back a failed update to the old version of a mod', async () => {
    await write(join(mods, 'v1', 'Data', 'mod.dll'), 'VERSION 1')
    await write(join(mods, 'v2', 'Data', 'mod.dll'), 'VERSION 2')
    await write(join(mods, 'v2', 'Data', 'extra.dll'), 'NEW IN 2')
    await applyDeployment(opts(buildPlan([await planMod('m', join(mods, 'v1'), 1)], {}), 'copy'))
    const copy = fsp.copyFile
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (String(dst).endsWith('extra.dll')) throw errno('ENOSPC')
      return copy(src, dst, mode)
    })
    const r = await applyDeployment(opts(buildPlan([await planMod('m', join(mods, 'v2'), 2)], {}), 'copy'))
    expect(r.outcome).toBe('rolled_back')
    expect(r.problem?.code).toBe('disk_full')
    vi.restoreAllMocks()
    expect(await read(join(game, 'Data', 'mod.dll'))).toBe('VERSION 1')
    await expect(fsp.access(join(game, 'Data', 'extra.dll'))).rejects.toThrow()
  })

  it('stops before touching anything when the folder is not writable', async () => {
    const write0 = fsp.writeFile
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (p, d) => {
      if (String(p).includes('.nf-write-')) throw errno('EACCES')
      return write0(p, d)
    })
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'auto'))
    expect(r.outcome).toBe('failed')
    expect(r.problem?.code).toBe('not_writable')
    expect(r.title).toMatch(/Nothing was changed/)
    expect(r.problem?.advice.join(' ')).toMatch(/Program Files/)
    vi.restoreAllMocks()
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })

  it('checks free space for copies first', async () => {
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 } as never)
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    expect(r.outcome).toBe('failed')
    expect(r.problem?.code).toBe('disk_full')
  })

  it('refuses when mod files are missing from storage', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await fsp.rm(join(mods, 'a', 'Data', 'original.txt'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    expect(r.outcome).toBe('failed')
    expect(r.problem?.code).toBe('source_missing')
    expect(r.problem?.advice.join(' ')).toMatch(/Reinstall/)
  })

  it('refuses while the game is running', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy', { precheck: async () => ({ code: 'game_running', title: 'Game is running', detail: 'close it', advice: [] }) }))
    expect(r.outcome).toBe('failed')
    expect(r.problem?.code).toBe('game_running')
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
  })

  it('can be cancelled', async () => {
    const ctrl = new AbortController()
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(
      opts(buildPlan([a], {}), 'copy', {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.phase === 'place') ctrl.abort()
        }
      })
    )
    expect(r.problem?.code).toBe('cancelled')
    expect(['rolled_back', 'failed']).toContain(r.outcome)
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
  })

  it('refuses paths that escape the target folder', async () => {
    const plan = buildPlan([{ id: 'evil', revision: 1, files: [{ target: 'game', rel: '../outside.txt', source: join(mods, 'a', 'Data', 'original.txt'), size: 6 }] }], {})
    const r = await applyDeployment(opts(plan, 'copy'))
    expect(r.outcome).not.toBe('verified')
    expect(r.problem?.code).toBe('unsafe_path')
    await expect(fsp.access(join(root, 'outside.txt'))).rejects.toThrow()
  })
})

describe('interrupted deployments', () => {
  it('undoes a deployment that was cut off (files placed but never recorded)', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    const manifestPath = join(root, 'manifest.json')
    const before = await readManifest(manifestPath)
    // Simulate a crash in the middle of deploying B: one of B's files is in the game, unrecorded, journal left behind.
    await fsp.copyFile(join(mods, 'b', 'Data', 'new', 'deep', 'only-b.txt'), join(game, 'Data', 'new', 'only-b-orphan.txt'))
    await fsp.mkdir(join(game, 'Data', 'new', 'deep'), { recursive: true })
    await fsp.copyFile(join(mods, 'b', 'Data', 'new', 'deep', 'only-b.txt'), join(game, 'Data', 'new', 'deep', 'only-b.txt'))
    await writeJsonAtomic(`${manifestPath}.journal`, {
      version: 1,
      startedAt: Date.now(),
      restoreTo: before,
      changing: true,
      pending: [{ target: 'game', dir: game, rel: 'Data/new/deep/only-b.txt', source: join(mods, 'b', 'Data', 'new', 'deep', 'only-b.txt') }]
    })
    expect(await hasInterruptedDeployment(manifestPath)).toBe(true)
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    expect(r.recovered).toBe(true)
    expect(r.outcome).toBe('verified')
    await expect(fsp.access(join(game, 'Data', 'new', 'deep', 'only-b.txt'))).rejects.toThrow()
    // A file NexusForge can't prove is its own stays where it is.
    expect(await read(join(game, 'Data', 'new', 'only-b-orphan.txt'))).toBe('ONLY B')
    expect(await hasInterruptedDeployment(manifestPath)).toBe(false)
  })

  it('reads manifests written before deploy targets existed', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    const m = await readManifest(join(root, 'manifest.json'))
    const v1 = { version: 1, gameId: m!.gameId, profileId: m!.profileId, targetDir: game, strategy: 'symlink', deployedAt: m!.deployedAt, planHash: m!.planHash, entries: m!.entries.map(({ target: _t, ...e }) => e), createdDirs: m!.createdDirs.map((d) => d.replace(/^game\|/, '')) }
    await writeJsonAtomic(join(root, 'manifest.json'), v1)
    const read1 = await readManifest(join(root, 'manifest.json'))
    expect(read1?.version).toBe(2)
    expect(read1?.targets.game).toBe(game)
    const r = await applyDeployment(opts(EMPTY_PLAN, 'auto'))
    expect(r.outcome).toBe('verified')
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
  })
})

describe('save folders and several targets', () => {
  it('never deletes a world the game changed (your progress), even on purge', async () => {
    const worlds = join(root, 'Documents', 'Worlds')
    await write(join(mods, 'map', 'Map.wld'), 'WORLD')
    const targets = { game: { dir: game }, worlds: { dir: worlds, userData: true, create: true } }
    const plan = buildPlan([await planMod('map', join(mods, 'map'), 1, 'worlds')], {})
    await applyDeployment(opts(plan, 'auto', {}, targets))
    await new Promise((r) => setTimeout(r, 30))
    await fsp.writeFile(join(worlds, 'Map.wld'), 'WORLD AFTER 10 HOURS OF PLAY')
    const r = await applyDeployment(opts(EMPTY_PLAN, 'auto', {}, targets))
    expect(r.kept).toBe(1)
    expect(r.rescued).toBe(0)
    expect(await read(join(worlds, 'Map.wld'))).toBe('WORLD AFTER 10 HOURS OF PLAY')
    expect(await readManifest(join(root, 'manifest.json'))).toBeUndefined()
  })

  it('never deletes a deployed game file that was changed afterwards', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    await new Promise((r) => setTimeout(r, 30))
    await fsp.writeFile(join(game, 'Data', 'new', 'shared.txt'), 'EDITED BY GAME, LONGER')
    const r = await applyDeployment(opts(EMPTY_PLAN, 'copy'))
    expect(r.rescued).toBe(1)
    expect(await read(join(root, 'overwrite', 'Data', 'new', 'shared.txt'))).toBe('EDITED BY GAME, LONGER')
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })

  it('moves files when a target folder changes (game moved to another drive)', async () => {
    const second = join(root, 'D', 'Games', 'game')
    await write(join(second, 'game.exe'), 'exe')
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'auto'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'auto', {}, { game: { dir: second } }))
    expect(r.outcome).toBe('verified')
    expect(await read(join(second, 'Data', 'new', 'shared.txt'))).toBe('A SHARED')
    expect(await gameFiles()).toEqual(['Data/original.txt', 'game.exe'])
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })

  it('re-places files that went missing and survives a strategy change', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    await fsp.rm(join(game, 'Data', 'new', 'shared.txt'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    expect(r.placed).toBe(1)
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('A SHARED')
    const r2 = await applyDeployment(opts(buildPlan([a], {}), 'hardlink'))
    expect(r2.errors).toEqual([])
    expect(r2.placed).toBe(2)
    expect((await readManifest(join(root, 'manifest.json')))?.strategy).toBe('hardlink')
    await applyDeployment(opts(EMPTY_PLAN, 'hardlink'))
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })

  it('runs configure after placing and again after a rollback', async () => {
    const seen: number[] = []
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy', { configure: async (m) => void seen.push(m.entries.length) }))
    expect(seen).toEqual([2])
    const b = await planMod('b', join(mods, 'b'))
    const r = await applyDeployment(
      opts(buildPlan([a, b], {}), 'copy', {
        configure: async (m) => void seen.push(m.entries.length),
        verifyExtra: async () => [{ label: 'x', ok: false, level: 'error' }]
      })
    )
    expect(r.outcome).toBe('rolled_back')
    // configure for the new state (3 files), then for the restored one (2 files).
    expect(seen).toEqual([2, 3, 2])
  })
})
