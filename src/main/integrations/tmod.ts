// .tmod files (tModLoader mods), read the way tModLoader's TmodFile.Read does (1.4.4 branch):
//   "TMOD" | string tModLoaderVersion | 20-byte SHA-1 | 256-byte signature | int32 dataLength | data…
//   data = string name | string version | int32 fileCount | fileCount × (string path, int32 length,
//          int32 compressedLength) | the files' bytes in that order (raw deflate when compressedLength differs)
// Strings are .NET BinaryWriter strings (7-bit encoded length, UTF-8). The SHA-1 covers all of `data`, so a
// damaged or cut-off download is detected the same way tModLoader detects it.
// The "Info" file is the mod's build.txt (BuildProperties): tag strings, each followed by its value; list values
// (modReferences) are strings ended by an empty string. Entries look like "CalamityMod" or "CalamityMod@2.0".

import { createReadStream, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

export interface TmodInfo {
  /** tModLoader version the mod was built with ("2024.5.3.0"). */
  builtFor: string
  /** Internal mod name (what enabled.json lists). Undefined for pre-0.11 files. */
  name?: string
  version?: string
  /** The SHA-1 in the header matches the content. */
  hashOk: boolean
  size: number
  /** Mods this one needs to load (modReferences), by internal name, with the minimum version if given. */
  refs?: Array<{ name: string; version?: string }>
  displayName?: string
}

export class TmodError extends Error {}

function read7BitInt(buf: Buffer, pos: { at: number }): number {
  let result = 0
  let shift = 0
  for (let i = 0; i < 5; i++) {
    if (pos.at >= buf.length) throw new TmodError('Unexpected end of header')
    const b = buf[pos.at++]
    result |= (b & 0x7f) << shift
    if (!(b & 0x80)) return result
    shift += 7
  }
  throw new TmodError('Bad string length')
}

function readString(buf: Buffer, pos: { at: number }): string {
  const len = read7BitInt(buf, pos)
  if (len < 0 || len > 4096 || pos.at + len > buf.length) throw new TmodError('Bad string')
  const s = buf.toString('utf8', pos.at, pos.at + len)
  pos.at += len
  return s
}

/** Writes a .NET BinaryWriter string (for tests that build .tmod files). */
export function dotnetString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  const len: number[] = []
  let n = bytes.length
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    len.push(b)
  } while (n)
  return Buffer.concat([Buffer.from(len), bytes])
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}

/** Builds a valid .tmod (tests and fixtures); `refs` become the Info file's modReferences. */
export function buildTmod(name: string, version: string, builtFor: string, payload = Buffer.from('payload'), opts: { refs?: string[]; displayName?: string } = {}): Buffer {
  let table = Buffer.alloc(0)
  let blobs = Buffer.alloc(0)
  let count = 0
  if (opts.refs || opts.displayName) {
    const tags: Buffer[] = []
    if (opts.refs?.length) tags.push(dotnetString('modReferences'), ...opts.refs.map(dotnetString), dotnetString(''))
    tags.push(dotnetString('version'), dotnetString(version))
    if (opts.displayName) tags.push(dotnetString('displayName'), dotnetString(opts.displayName))
    tags.push(dotnetString('side'), Buffer.from([0]), dotnetString(''))
    const info = Buffer.concat(tags)
    table = Buffer.concat([dotnetString('Info'), int32(info.length), int32(info.length)])
    blobs = info
    count = 1
  }
  const data = Buffer.concat([dotnetString(name), dotnetString(version), int32(count), table, blobs, payload])
  const hash = createHash('sha1').update(data).digest()
  return Buffer.concat([Buffer.from('TMOD', 'ascii'), dotnetString(builtFor), hash, Buffer.alloc(256), int32(data.length), data])
}

/** Reads a list value after `tag` in a BuildProperties blob ("modReferences" → names), if the tag is there. */
function listAfterTag(info: Buffer, tag: string): string[] | undefined {
  const needle = dotnetString(tag)
  for (let at = info.indexOf(needle); at >= 0; at = info.indexOf(needle, at + 1)) {
    // A tag starts the blob or follows the end of a previous value; checking that the list parses is enough.
    const pos = { at: at + needle.length }
    const out: string[] = []
    try {
      for (let i = 0; i < 512; i++) {
        const s = readString(info, pos)
        if (!s) return out
        out.push(s)
      }
    } catch {
      // not this occurrence
    }
  }
  return undefined
}

function stringAfterTag(info: Buffer, tag: string): string | undefined {
  const needle = dotnetString(tag)
  const at = info.indexOf(needle)
  if (at < 0) return undefined
  try {
    return readString(info, { at: at + needle.length }) || undefined
  } catch {
    return undefined
  }
}

/**
 * The Info file of a .tmod (its build properties). `tableAt` is the absolute offset of the file count. File data
 * starts right after the whole table, so the table is read completely (up to 8 MB, enough for any real mod).
 */
async function readInfoFile(file: string, tableAt: number, total: number): Promise<Buffer | undefined> {
  const fh = await fsp.open(file, 'r')
  try {
    const table = Buffer.alloc(Math.min(total - tableAt, 8 * 1024 * 1024))
    await fh.read(table, 0, table.length, tableAt)
    const pos = { at: 0 }
    const count = table.readInt32LE(0)
    pos.at = 4
    if (count < 0 || count > 200_000) return undefined
    let offset = 0
    let info: { offset: number; length: number; compressed: number } | undefined
    for (let i = 0; i < count; i++) {
      const path = readString(table, pos)
      if (pos.at + 8 > table.length) return undefined
      const length = table.readInt32LE(pos.at)
      const compressed = table.readInt32LE(pos.at + 4)
      pos.at += 8
      if (path === 'Info') info = { offset, length, compressed }
      offset += compressed
    }
    if (!info) return undefined
    const start = tableAt + pos.at + info.offset
    if (start + info.compressed > total || info.compressed > 1024 * 1024) return undefined
    const buf = Buffer.alloc(info.compressed)
    await fh.read(buf, 0, buf.length, start)
    return info.compressed === info.length ? buf : inflateRawSync(buf)
  } catch {
    return undefined
  } finally {
    await fh.close()
  }
}

export async function readTmod(file: string, verifyHash = true): Promise<TmodInfo> {
  const st = await fsp.stat(file)
  const fh = await fsp.open(file, 'r')
  let head: Buffer
  try {
    head = Buffer.alloc(Math.min(st.size, 64 * 1024))
    await fh.read(head, 0, head.length, 0)
  } finally {
    await fh.close()
  }
  if (head.toString('ascii', 0, 4) !== 'TMOD') throw new TmodError('Not a tModLoader mod (no TMOD header)')
  const pos = { at: 4 }
  const builtFor = readString(head, pos)
  const hash = head.subarray(pos.at, pos.at + 20)
  pos.at += 20 + 256
  if (pos.at + 4 > head.length) throw new TmodError('The file is cut off')
  const dataLen = head.readInt32LE(pos.at)
  pos.at += 4
  const dataStart = pos.at
  if (dataLen !== st.size - dataStart) throw new TmodError('The file is damaged or incomplete (its length does not match its header)')
  let name: string | undefined
  let version: string | undefined
  let refs: TmodInfo['refs']
  let displayName: string | undefined
  const major = Number(builtFor.split('.')[0])
  if (!(major === 0 && Number(builtFor.split('.')[1]) < 11)) {
    name = readString(head, pos)
    version = readString(head, pos)
    const info = await readInfoFile(file, pos.at, st.size)
    if (info) {
      refs = (listAfterTag(info, 'modReferences') ?? []).map((r) => {
        const [n, v] = r.split('@')
        return { name: n.trim(), version: v?.trim() || undefined }
      }).filter((r) => r.name)
      displayName = stringAfterTag(info, 'displayName')
    }
  }
  let hashOk = true
  if (verifyHash) {
    const h = createHash('sha1')
    for await (const chunk of createReadStream(file, { start: dataStart })) h.update(chunk as Buffer)
    hashOk = h.digest().equals(hash)
  }
  return { builtFor, name, version, hashOk, size: st.size, refs, displayName }
}

export type TmlFamily = '1.3' | '1.4.3' | '1.4.4'

/** Which Terraria line a tModLoader version belongs to (0.11.x = 1.3, 2020-2022 = 1.4.3, 2023+ = 1.4.4 and later). */
export function tmlFamily(version: string): TmlFamily {
  const major = Number.parseInt(version.replace(/^v/i, '').split('.')[0], 10) || 0
  if (major < 2000) return '1.3'
  if (major < 2023) return '1.4.3'
  return '1.4.4'
}

/** "2024.5.3.0" -> [2024, 5]: tModLoader versions are year.month.(patch).(build). */
export function tmlMonth(version: string): [number, number] {
  const p = version.replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0)
  return [p[0] ?? 0, p[1] ?? 0]
}

export function tmlNewer(a: string, b: string): boolean {
  const [ay, am] = tmlMonth(a)
  const [by, bm] = tmlMonth(b)
  return ay > by || (ay === by && am > bm)
}
