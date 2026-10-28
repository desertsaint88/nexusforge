import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { Game, InstalledMod } from '../src/shared/types'
import type { IntegrationEnv, IntegrationState, LoaderInstallHost } from '../src/main/integrations/types'
import { createSteamEnv } from '../src/main/integrations/steam-apps'
import { extractArchive } from '../src/main/mods/archive'

export async function write(path: string, content: string | Buffer = ''): Promise<void> {
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, content)
}

/** A stored (uncompressed) zip with exactly the given entries. */
export function zip(entries: Array<{ name: string; data?: string | Buffer; symlink?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.symlink ? 0x031e : 0x0014, 4)
    central.writeUInt16LE(10, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export const silent = { info() {}, warn() {}, error() {} }

export type FakeEnv = IntegrationEnv & { opened: string[]; versions: Record<string, string> }

/** An environment without network: Steam is a folder (or absent), downloads come from `files`. */
export function fakeEnv(root: string, over: Partial<IntegrationEnv> & { steamRoot?: string } = {}): FakeEnv {
  const opened: string[] = []
  const versions: Record<string, string> = {}
  const env: FakeEnv = {
    documents: join(root, 'Documents'),
    workDir: join(root, 'work'),
    steam: createSteamEnv(over.steamRoot ?? ''),
    log: silent,
    fetchJson: async (url: string) => {
      throw new Error(`offline: ${url}`)
    },
    fetchText: async (url: string) => {
      throw new Error(`offline: ${url}`)
    },
    download: async () => {
      throw new Error('no network in tests')
    },
    openUrl: async (u: string) => {
      opened.push(u)
    },
    fileVersion: async (f: string) => versions[f.toLowerCase()],
    extract: (a: string, d: string) => extractArchive(a, d),
    opened,
    versions,
    ...over
  } as FakeEnv
  return env
}

export function gameOf(p: Partial<Game> & { installDir: string; name: string }): Game {
  return {
    id: p.id ?? 'test:game',
    platform: 'custom',
    launch: { kind: 'exe', exe: p.exePath ?? '' },
    art: { capsule: [], hero: [], header: [], logo: [] },
    playtimeMinutes: 0,
    addedAt: 0,
    modding: { targetDir: p.installDir, strategy: 'auto', sources: {} },
    ...p
  }
}

export function fakeHost(): LoaderInstallHost & { installed: Array<{ file: string; name: string; version?: string }>; states: Record<string, IntegrationState> } {
  const states: Record<string, IntegrationState> = {}
  const installed: Array<{ file: string; name: string; version?: string }> = []
  return {
    states,
    installed,
    async installModFile(_gameId, file, meta) {
      installed.push({ file, name: meta.name, version: meta.version })
      return { id: 'loader', name: meta.name } as InstalledMod
    },
    state: (g) => states[g] ?? { loaders: {} },
    saveState: (g, s) => {
      states[g] = s
    }
  }
}

export async function steamApp(steamRoot: string, appId: string, name: string, installdir: string, extra = ''): Promise<string> {
  const dir = join(steamRoot, 'steamapps', 'common', installdir)
  await fsp.mkdir(dir, { recursive: true })
  await write(
    join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"${installdir}"\n\t"buildid"\t\t"777"\n${extra}}\n`
  )
  return dir
}
