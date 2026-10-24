// Garry's Mod Workshop files: .gma archives, sometimes LZMA-compressed as *_legacy.bin.
import { promises as fsp } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

function readCStr(buf: Buffer, pos: { o: number }): string {
  const end = buf.indexOf(0, pos.o)
  if (end < 0) throw new Error('Corrupt GMA: unterminated string')
  const s = buf.toString('utf8', pos.o, end)
  pos.o = end + 1
  return s
}

export interface GmaInfo {
  name: string
  files: Array<{ path: string; size: number }>
}

/** Extracts every file of a .gma into destDir; returns the addon title and file list. */
export async function extractGma(file: string, destDir: string): Promise<GmaInfo> {
  const buf = await fsp.readFile(file)
  if (buf.toString('ascii', 0, 4) !== 'GMAD') throw new Error('Not a GMA file')
  const version = buf[4]
  const pos = { o: 5 + 16 } // steamid + timestamp
  if (version > 1) while (readCStr(buf, pos)) {} // required content list
  const name = readCStr(buf, pos)
  readCStr(buf, pos) // description
  readCStr(buf, pos) // author
  pos.o += 4 // addon version
  const files: Array<{ path: string; size: number }> = []
  for (;;) {
    const num = buf.readUInt32LE(pos.o)
    pos.o += 4
    if (num === 0) break
    const path = readCStr(buf, pos)
    const size = Number(buf.readBigInt64LE(pos.o))
    pos.o += 8 + 4 // size + crc
    files.push({ path, size })
  }
  let offset = pos.o
  const root = normalize(destDir)
  for (const f of files) {
    const target = normalize(join(destDir, ...f.path.split('/')))
    if (!target.startsWith(root + sep)) throw new Error(`Unsafe path in GMA: ${f.path}`)
    if (offset + f.size > buf.length) throw new Error('Truncated GMA file')
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.writeFile(target, buf.subarray(offset, offset + f.size))
    offset += f.size
  }
  return { name, files }
}

export function addonSlug(title: string, id: string): string {
  const slug = title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  return slug || `workshop_${id}`
}
