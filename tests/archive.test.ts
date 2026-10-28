import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { ArchiveError, extractArchive, inspectArchive, unsafeEntryName, validateExtracted } from '../src/main/mods/archive'

/** A stored (uncompressed) zip with exactly the given entry names, so malicious names can be tested. */
function zip(entries: Array<{ name: string; data?: string; symlink?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data ?? '', 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.symlink ? 0x031e : 0x0014, 4) // made by: unix (3) for links
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

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-archive-'))
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('archive safety', () => {
  it('names entries that would escape or misbehave', () => {
    expect(unsafeEntryName('../evil.txt')).toMatch(/leaves/)
    expect(unsafeEntryName('a/../../evil.txt')).toMatch(/leaves/)
    expect(unsafeEntryName('C:/Windows/evil.dll')).toMatch(/absolute/)
    expect(unsafeEntryName('/etc/passwd')).toMatch(/absolute/)
    expect(unsafeEntryName('file.txt:hidden')).toMatch(/invalid/)
    expect(unsafeEntryName('mods/CON.txt')).toMatch(/reserved/)
    expect(unsafeEntryName('BepInEx/plugins/Mod.dll')).toBeUndefined()
  })

  it('extracts a normal archive', async () => {
    const file = join(root, 'ok.zip')
    await fsp.writeFile(file, zip([{ name: 'Mod/plugin.dll', data: 'DLL' }, { name: 'Mod/readme.txt', data: 'hi' }]))
    await extractArchive(file, join(root, 'out'))
    expect(await fsp.readFile(join(root, 'out', 'Mod', 'plugin.dll'), 'utf8')).toBe('DLL')
  })

  it('refuses path traversal before writing anything', async () => {
    const file = join(root, 'evil.zip')
    await fsp.writeFile(file, zip([{ name: 'ok.txt', data: 'fine' }, { name: '../escaped.txt', data: 'EVIL' }]))
    await expect(extractArchive(file, join(root, 'out'))).rejects.toMatchObject({ reason: 'unsafe' })
    await expect(fsp.access(join(root, 'escaped.txt'))).rejects.toThrow()
    await expect(fsp.access(join(root, 'out', 'ok.txt'))).rejects.toThrow()
  })

  it('refuses absolute paths', async () => {
    const file = join(root, 'abs.zip')
    await fsp.writeFile(file, zip([{ name: 'C:/nexusforge-test-abs.txt', data: 'EVIL' }]))
    await expect(inspectArchive(file)).rejects.toBeInstanceOf(ArchiveError)
  })

  it('refuses archives with links', async () => {
    const file = join(root, 'link.zip')
    await fsp.writeFile(file, zip([{ name: 'link', data: '../../../Windows', symlink: true }]))
    await expect(inspectArchive(file)).rejects.toMatchObject({ reason: 'unsafe' })
  })

  it('reports a damaged or cut-off download plainly', async () => {
    const file = join(root, 'cut.zip')
    const full = zip([{ name: 'a.txt', data: 'x'.repeat(5000) }])
    await fsp.writeFile(file, full.subarray(0, 40))
    await expect(extractArchive(file, join(root, 'out'))).rejects.toMatchObject({ reason: 'corrupt' })
    await fsp.writeFile(join(root, 'empty.zip'), '')
    await expect(extractArchive(join(root, 'empty.zip'), join(root, 'out2'))).rejects.toBeInstanceOf(ArchiveError)
  })

  it('refuses an extracted tree that contains a junction', async () => {
    const out = join(root, 'tree')
    await fsp.mkdir(join(out, 'inner'), { recursive: true })
    // Junctions need no special rights on Windows, which is why they are checked for.
    await fsp.symlink(root, join(out, 'inner', 'escape'), 'junction')
    await expect(validateExtracted(out)).rejects.toMatchObject({ reason: 'unsafe' })
  })
})
