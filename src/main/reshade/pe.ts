// What a Windows executable is built for (32/64-bit) and which DLLs it imports, read straight from its PE headers
// without loading the file. ReShade's own setup decides the graphics API the same way (PEInfo.Modules).

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export type PeMachine = 'x86' | 'x64' | 'arm64' | 'unknown'

export interface PeInfo {
  machine: PeMachine
  /** Imported and delay-loaded DLL names, lower case. */
  imports: string[]
  /** Size of the stack the main thread reserves (ReShade warns below 1 MB). */
  stackReserve?: number
  /** The file carries an Authenticode signature (ReShade's standard build does, the add-on build doesn't). */
  signed: boolean
}

interface Section {
  va: number
  vsize: number
  raw: number
  rawSize: number
}

async function read(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, len))
  const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
  return buf.subarray(0, bytesRead)
}

function fileOffset(secs: Section[], rva: number): number | undefined {
  for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va)
  return undefined
}

async function cString(fh: FileHandle, secs: Section[], rva: number): Promise<string | undefined> {
  const off = fileOffset(secs, rva)
  if (off === undefined) return undefined
  const buf = await read(fh, off, 260)
  const end = buf.indexOf(0)
  const s = buf.toString('latin1', 0, end < 0 ? buf.length : end)
  return /^[\x20-\x7e]+$/.test(s) ? s : undefined
}

const MACHINES: Record<number, PeMachine> = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' }

/** Reads the machine type and imported DLLs of an .exe or .dll; undefined when it is not a PE file. */
export async function readPe(file: string): Promise<PeInfo | undefined> {
  let fh: FileHandle
  try {
    fh = await fsp.open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const dos = await read(fh, 0, 64)
    if (dos.length < 64 || dos.toString('ascii', 0, 2) !== 'MZ') return undefined
    const peOff = dos.readUInt32LE(0x3c)
    const coff = await read(fh, peOff, 24)
    if (coff.length < 24 || coff.toString('ascii', 0, 4) !== 'PE\0\0') return undefined
    const machine = MACHINES[coff.readUInt16LE(4)] ?? 'unknown'
    const sections = coff.readUInt16LE(6)
    const optSize = coff.readUInt16LE(20)
    const opt = await read(fh, peOff + 24, optSize)
    if (opt.length < 2) return { machine, imports: [], signed: false }
    const pe32plus = opt.readUInt16LE(0) === 0x20b
    const stackReserve = pe32plus ? (opt.length >= 80 ? Number(opt.readBigUInt64LE(72)) : undefined) : opt.length >= 76 ? opt.readUInt32LE(72) : undefined
    const dirOff = pe32plus ? 112 : 96
    const dir = (i: number) => (opt.length >= dirOff + i * 8 + 8 ? { rva: opt.readUInt32LE(dirOff + i * 8), size: opt.readUInt32LE(dirOff + i * 8 + 4) } : { rva: 0, size: 0 })
    const table = await read(fh, peOff + 24 + optSize, sections * 40)
    const secs: Section[] = []
    for (let i = 0; i < sections && (i + 1) * 40 <= table.length; i++) {
      const o = i * 40
      secs.push({ vsize: table.readUInt32LE(o + 8), va: table.readUInt32LE(o + 12), rawSize: table.readUInt32LE(o + 16), raw: table.readUInt32LE(o + 20) })
    }
    const names = new Set<string>()
    // Import directory (index 1): 20-byte descriptors, name RVA at +12, ends with an all-zero descriptor.
    // Delay-load directory (index 13): 32-byte descriptors, name RVA at +4.
    for (const [index, stride, nameAt] of [
      [1, 20, 12],
      [13, 32, 4]
    ] as const) {
      const d = dir(index)
      const off = d.rva ? fileOffset(secs, d.rva) : undefined
      if (off === undefined) continue
      const raw = await read(fh, off, Math.min(Math.max(d.size, stride * 64), stride * 512))
      for (let p = 0; p + stride <= raw.length; p += stride) {
        const nameRva = raw.readUInt32LE(p + nameAt)
        if (!nameRva) break
        const name = await cString(fh, secs, nameRva)
        if (name) names.add(name.toLowerCase())
      }
    }
    // Security directory (index 4): file offset and size of the certificate table.
    return { machine, imports: [...names], stackReserve, signed: dir(4).size > 0 }
  } catch {
    return undefined
  } finally {
    await fh.close()
  }
}
