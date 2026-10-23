import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** `.GamingRoot` = "RGBX" + uint32 count + UTF-16LE null-terminated folder paths relative to the drive root. */
export function parseGamingRoot(buf: Buffer, drive: string): string[] {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'RGBX') return []
  const count = buf.readUInt32LE(4)
  const out: string[] = []
  let offset = 8
  for (let i = 0; i < count && offset < buf.length; i++) {
    let end = offset
    while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2
    const rel = buf.toString('utf16le', offset, end)
    if (rel) out.push(/^[a-z]:/i.test(rel) ? rel : join(drive, rel))
    offset = end + 2
  }
  return out
}

/** Windows package publisher id: Crockford base32 of the first 8 bytes of sha256(UTF-16LE publisher). */
export function publisherId(publisher: string): string {
  const hash = createHash('sha256').update(Buffer.from(publisher, 'utf16le')).digest()
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  let bits = ''
  for (let i = 0; i < 8; i++) bits += hash[i].toString(2).padStart(8, '0')
  bits += '0'
  let out = ''
  for (let i = 0; i < 65; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)]
  return out
}
