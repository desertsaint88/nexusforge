import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDeployment, EMPTY_PLAN, readManifest } from '../src/main/mods/deploy'
import { buildPlan, conflictReport, type PlanMod } from '../src/main/mods/plan'
import { walkFiles } from '../src/main/util/fs'
import type { DeployStrategy } from '../src/shared/types'

let root: string
let game: string
let mods: string

async function write(path: string, content: string): Promise<void> {
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, content)
}

async function planMod(id: string, dir: string, revision = 1): Promise<PlanMod> {
  return { id, root: dir, revision, files: (await walkFiles(dir)).map((f) => ({ rel: f.rel, size: f.size })) }
}

function opts(plan: ReturnType<typeof buildPlan>, strategy: DeployStrategy) {
  return {
    gameId: 'test:game',
    profileId: 'p1',
    targetDir: game,
    strategy,
    plan,
    manifestPath: join(root, 'manifest.json'),
    backupDir: join(root, 'backups'),
    overwriteDir: join(root, 'overwrite')
  }
}

const read = (p: string) => fsp.readFile(p, 'utf8')

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
  await fsp.rm(root, { recursive: true, force: true })
})

describe('plan', () => {
  it('lets later mods win and honours file overrides', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const b = await planMod('b', join(mods, 'b'))
    const plan = buildPlan([a, b], {})
    expect(plan.entries.get('data/new/shared.txt')?.modId).toBe('b')
    expect(plan.entries.get('data/original.txt')?.modId).toBe('a')
    expect(plan.conflicts).toHaveLength(1)

    const pinned = buildPlan([a, b], { 'data/new/shared.txt': 'a' })
    expect(pinned.entries.get('data/new/shared.txt')?.modId).toBe('a')
    expect(pinned.conflicts[0].overridden).toBe(true)
    expect(pinned.hash).not.toBe(plan.hash)

    const report = conflictReport(plan, 'g', 'p', ['a', 'b'])
    expect(report.groups[0].mods).toEqual(['a', 'b'])
    expect(report.perMod.b).toEqual({ wins: 1, loses: 0 })
    expect(report.perMod.a).toEqual({ wins: 0, loses: 1 })
  })

  it('treats paths case-insensitively', () => {
    const plan = buildPlan(
      [
        { id: 'x', root: 'C:\\x', revision: 1, files: [{ rel: 'Data/Tex.dds', size: 1 }] },
        { id: 'y', root: 'C:\\y', revision: 1, files: [{ rel: 'data/tex.DDS', size: 2 }] }
      ],
      {}
    )
    expect(plan.entries.size).toBe(1)
    expect(plan.entries.get('data/tex.dds')?.modId).toBe('y')
  })
})

describe.each<DeployStrategy>(['copy', 'hardlink', 'symlink'])('deploy (%s)', (strategy) => {
  it('deploys, backs up originals, redeploys incrementally and purges cleanly', async () => {
    const a = await planMod('a', join(mods, 'a'))
    const b = await planMod('b', join(mods, 'b'))

    const r1 = await applyDeployment(opts(buildPlan([a, b], {}), strategy))
    expect(r1.errors).toEqual([])
    expect(r1.placed).toBe(3)
    expect(r1.backedUp).toBe(1)
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('FROM A')
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('B SHARED')
    expect(await read(join(root, 'backups', 'Data', 'original.txt'))).toBe('ORIGINAL')
    const manifest = await readManifest(join(root, 'manifest.json'))
    expect(manifest?.entries).toHaveLength(3)
    expect(Object.values(r1.methods).reduce((x, y) => x + y, 0)).toBe(3)
    // Without symlink rights (no Developer Mode / not elevated) the engine must fall back and say so.
    if (strategy === 'symlink' && r1.methods.symlink === 0) {
      expect(r1.fallbacks.join(' ')).toMatch(/Developer Mode|not supported/)
      console.info(`[symlink fallback] ${JSON.stringify(r1.methods)} :: ${r1.fallbacks.join(' | ')}`)
    }

    // Disable B: its files go away, A's shared.txt takes over, nothing else is touched.
    const r2 = await applyDeployment(opts(buildPlan([a], {}), strategy))
    expect(r2.errors).toEqual([])
    expect(r2.unchanged).toBe(1)
    expect(await read(join(game, 'Data', 'new', 'shared.txt'))).toBe('A SHARED')
    await expect(fsp.access(join(game, 'Data', 'new', 'deep'))).rejects.toThrow()

    // Purge: original restored, created folders removed, manifest gone, game files intact.
    const r3 = await applyDeployment(opts(EMPTY_PLAN, strategy))
    expect(r3.errors).toEqual([])
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
    await expect(fsp.access(join(game, 'Data', 'new'))).rejects.toThrow()
    expect(await readManifest(join(root, 'manifest.json'))).toBeUndefined()
    expect(await read(join(game, 'game.exe'))).toBe('exe')
    const left = (await walkFiles(game)).map((f) => f.rel).sort()
    expect(left).toEqual(['Data/original.txt', 'game.exe'])
  })
})

describe('link fallbacks', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code })
  afterEach(() => vi.restoreAllMocks())

  it('falls back to hardlinks when Windows refuses symlinks (no Developer Mode, not elevated)', async () => {
    vi.spyOn(fsp, 'symlink').mockRejectedValue(errno('EPERM'))
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'symlink'))
    expect(r.errors).toEqual([])
    expect(r.methods).toEqual({ symlink: 0, hardlink: 2, copy: 0 })
    expect(r.fallbacks[0]).toMatch(/Developer Mode/)
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('FROM A')
  })

  it('falls back to copies when mod storage is on another drive', async () => {
    vi.spyOn(fsp, 'symlink').mockRejectedValue(errno('EPERM'))
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'))
    const a = await planMod('a', join(mods, 'a'))
    const r = await applyDeployment(opts(buildPlan([a], {}), 'symlink'))
    expect(r.errors).toEqual([])
    expect(r.methods).toEqual({ symlink: 0, hardlink: 0, copy: 2 })
    expect(r.fallbacks.join(' ')).toMatch(/different drive/)
    vi.restoreAllMocks()
    await applyDeployment(opts(EMPTY_PLAN, 'symlink'))
    expect(await read(join(game, 'Data', 'original.txt'))).toBe('ORIGINAL')
  })
})

describe('deploy safety', () => {
  it('never deletes a deployed file that was changed afterwards', async () => {
    const a = await planMod('a', join(mods, 'a'))
    await applyDeployment(opts(buildPlan([a], {}), 'copy'))
    // Simulate the game (or the user) rewriting a deployed file.
    await new Promise((r) => setTimeout(r, 30))
    await fsp.writeFile(join(game, 'Data', 'new', 'shared.txt'), 'EDITED BY GAME, LONGER')
    const r = await applyDeployment(opts(EMPTY_PLAN, 'copy'))
    expect(r.rescued).toBe(1)
    expect(await read(join(root, 'overwrite', 'Data', 'new', 'shared.txt'))).toBe('EDITED BY GAME, LONGER')
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

  it('refuses paths that escape the target folder', async () => {
    const plan = buildPlan([{ id: 'evil', root: join(mods, 'a'), revision: 1, files: [{ rel: '../outside.txt', size: 1 }] }], {})
    const r = await applyDeployment(opts(plan, 'copy'))
    expect(r.placed).toBe(0)
    expect(r.errors[0]).toMatch(/outside the target/)
    await expect(fsp.access(join(root, 'outside.txt'))).rejects.toThrow()
  })
})
