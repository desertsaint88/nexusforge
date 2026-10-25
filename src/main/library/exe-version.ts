// Reads the version resource of a Windows executable without loading the whole file.
import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exists } from '../util/fs'

async function read(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return buf.subarray(0, bytesRead)
}

interface Section {
  va: number
  vsize: number
  raw: number
  rawSize: number
}

/** Raw bytes of the RT_VERSION resource, or undefined. */
async function versionResource(file: string): Promise<Buffer | undefined> {
  const fh = await fsp.open(file, 'r')
  try {
    const dos = await read(fh, 0, 64)
    if (dos.length < 64 || dos.toString('ascii', 0, 2) !== 'MZ') return undefined
    const peOff = dos.readUInt32LE(0x3c)
    const head = await read(fh, peOff, 24 + 240)
    if (head.toString('ascii', 0, 4) !== 'PE\0\0') return undefined
    const sections = head.readUInt16LE(6)
    const optSize = head.readUInt16LE(20)
    const opt = await read(fh, peOff + 24, optSize)
    const magic = opt.readUInt16LE(0)
    const dirOff = magic === 0x20b ? 112 : 96
    if (opt.length < dirOff + 24) return undefined
    const rsrcRva = opt.readUInt32LE(dirOff + 2 * 8)
    if (!rsrcRva) return undefined
    const table = await read(fh, peOff + 24 + optSize, sections * 40)
    const secs: Section[] = []
    for (let i = 0; i < sections; i++) {
      const o = i * 40
      secs.push({ vsize: table.readUInt32LE(o + 8), va: table.readUInt32LE(o + 12), rawSize: table.readUInt32LE(o + 16), raw: table.readUInt32LE(o + 20) })
    }
    const toOffset = (rva: number) => {
      const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize))
      return s ? rva - s.va + s.raw : undefined
    }
    const base = toOffset(rsrcRva)
    if (base === undefined) return undefined

    // Resource tree: type -> name -> language -> data entry.
    const dirEntries = async (off: number) => {
      const hdr = await read(fh, base + off, 16)
      const count = hdr.readUInt16LE(12) + hdr.readUInt16LE(14)
      const raw = await read(fh, base + off + 16, count * 8)
      const out: Array<{ id: number; target: number; isDir: boolean }> = []
      for (let i = 0; i < count; i++) {
        const target = raw.readUInt32LE(i * 8 + 4)
        out.push({ id: raw.readUInt32LE(i * 8), target: target & 0x7fffffff, isDir: (target & 0x80000000) !== 0 })
      }
      return out
    }
    const type = (await dirEntries(0)).find((e) => e.id === 16 && e.isDir)
    if (!type) return undefined
    const name = (await dirEntries(type.target)).find((e) => e.isDir)
    if (!name) return undefined
    const lang = (await dirEntries(name.target))[0]
    if (!lang || lang.isDir) return undefined
    const entry = await read(fh, base + lang.target, 8)
    const dataOff = toOffset(entry.readUInt32LE(0))
    const size = Math.min(entry.readUInt32LE(4), 64 * 1024)
    return dataOff === undefined ? undefined : read(fh, dataOff, size)
  } finally {
    await fh.close()
  }
}

function stringValue(block: Buffer, key: string): string | undefined {
  const needle = Buffer.from(`${key}\0`, 'utf16le')
  const at = block.indexOf(needle)
  if (at < 0) return undefined
  let p = at + needle.length
  while (p % 4 !== 0) p++ // values are 32-bit aligned
  let end = p
  while (end + 1 < block.length && !(block[end] === 0 && block[end + 1] === 0)) end += 2
  return block.toString('utf16le', p, end).trim() || undefined
}

function fixedVersion(block: Buffer): string | undefined {
  const sig = block.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]))
  if (sig < 0 || sig + 24 > block.length) return undefined
  const ms = block.readUInt32LE(sig + 16) // product version
  const ls = block.readUInt32LE(sig + 20)
  const parts = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff]
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop()
  return parts.every((p) => p === 0) ? undefined : parts.join('.')
}

export interface VersionStrings {
  productName?: string
  fileDescription?: string
  companyName?: string
  version?: string
}

/** Name/description/version strings of an .exe or .dll (mod DLLs carry their name here too). */
export async function readVersionStrings(file: string): Promise<VersionStrings | undefined> {
  try {
    const block = await versionResource(file)
    if (!block) return undefined
    return {
      productName: stringValue(block, 'ProductName'),
      fileDescription: stringValue(block, 'FileDescription'),
      companyName: stringValue(block, 'CompanyName'),
      version: stringValue(block, 'ProductVersion') ?? stringValue(block, 'FileVersion') ?? fixedVersion(block)
    }
  } catch {
    return undefined
  }
}

/**
 * The game's own version from its executable. Engine executables that only carry the engine version
 * (Unity, Unreal) return undefined, because that number says nothing about the game build.
 */
export async function readExeVersion(exe: string): Promise<string | undefined> {
  try {
    if (await exists(join(dirname(exe), 'UnityPlayer.dll'))) return undefined
    const block = await versionResource(exe)
    if (!block) return undefined
    const product = stringValue(block, 'ProductVersion')
    const file = stringValue(block, 'FileVersion')
    const v = product ?? file ?? fixedVersion(block)
    if (!v) return undefined
    if (/\+\+UE[45]|release-[45]\.\d/i.test(v)) return undefined
    const parts = v.replace(/,\s*/g, '.').trim().split('.')
    while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop()
    return parts.join('.').slice(0, 40)
  } catch {
    return undefined
  }
}
