import { promises as fsp } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import sevenBin from '7zip-bin'
import { run } from '../util/exec'
import { exists } from '../util/fs'

export const ARCHIVE_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.xz']

export function isArchive(file: string): boolean {
  const lower = file.toLowerCase()
  return ARCHIVE_EXT.some((e) => lower.endsWith(e))
}

/** An archive NexusForge refuses to unpack, or can't read. */
export class ArchiveError extends Error {
  constructor(
    message: string,
    public reason: 'unsafe' | 'corrupt' | 'too_large' | 'unsupported'
  ) {
    super(message)
  }
}

function sevenZipPath(): string {
  // electron-builder unpacks the binary next to app.asar.
  const p = sevenBin.path7za
  return p.includes(`app.asar${sep}`) ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

function tarPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

export interface ArchiveEntry {
  path: string
  dir: boolean
  size: number
  link: boolean
}

/** Why an entry name is unsafe to extract, if it is. */
export function unsafeEntryName(name: string): string | undefined {
  const n = name.replace(/\\/g, '/')
  if (!n) return undefined
  if (/^[a-z]:/i.test(n) || n.startsWith('/') || n.startsWith('//')) return `absolute path "${name}"`
  if (n.split('/').includes('..')) return `path leaves the archive ("${name}")`
  // Alternate data streams and device names would write somewhere other than a plain file.
  if (n.split('/').some((p) => p.includes(':'))) return `invalid file name "${name}"`
  if (n.split('/').some((p) => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p))) return `reserved Windows name "${name}"`
  return undefined
}

/** Lists an archive with 7-Zip (zip, 7z, tar, gz, xz) or Windows' tar (rar). */
export async function listArchive(file: string): Promise<ArchiveEntry[]> {
  const ext = extname(file).toLowerCase()
  if (ext === '.rar') {
    const tar = tarPath()
    if (!(await exists(tar))) throw new ArchiveError('tar.exe is not available on this system to read .rar files', 'unsupported')
    const { code, stdout, stderr } = await run(tar, ['-tvf', file], { timeoutMs: 10 * 60_000 })
    if (code !== 0) throw new ArchiveError(`Could not read ${basename(file)}: ${(stderr || stdout).trim().split(/\r?\n/).pop() || 'damaged or incomplete archive'}`, 'corrupt')
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        // "-rw-r--r--  0 0      0     1234 Jan 01  2024 dir/file"
        const m = line.match(/^(\S)\S*\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.*)$/)
        const path = (m?.[3] ?? line).replace(/ -> .*$/, '')
        return { path, dir: m?.[1] === 'd', size: Number(m?.[2] ?? 0), link: m?.[1] === 'l' || m?.[1] === 'h' }
      })
  }
  const { code, stdout, stderr } = await run(sevenZipPath(), ['l', '-slt', '-ba', '-sccUTF-8', file], { timeoutMs: 10 * 60_000 })
  if (code !== 0) {
    const msg = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    throw new ArchiveError(`Could not read ${basename(file)}: ${msg || 'the archive is damaged or the download is incomplete'}`, 'corrupt')
  }
  const out: ArchiveEntry[] = []
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const field = (k: string) => block.match(new RegExp(`^${k} = (.*)$`, 'm'))?.[1]?.trim()
    const path = field('Path')
    if (!path) continue
    const attrs = field('Attributes') ?? ''
    out.push({
      path,
      dir: field('Folder') === '+' || /^D/.test(attrs),
      size: Number(field('Size') ?? 0) || 0,
      link: Boolean(field('Symbolic Link') || field('Hard Link')) || /\bl[r-][w-][x-]/.test(attrs)
    })
  }
  return out
}

const MAX_ENTRIES = 300_000
const MAX_BYTES = 120 * 1024 ** 3

/** Refuses archives with paths that leave the extraction folder, links, or a size that can't be real. */
export async function inspectArchive(file: string): Promise<ArchiveEntry[]> {
  const entries = await listArchive(file)
  if (!entries.length) throw new ArchiveError(`${basename(file)} is empty or not an archive.`, 'corrupt')
  if (entries.length > MAX_ENTRIES) throw new ArchiveError(`${basename(file)} has ${entries.length.toLocaleString()} entries; NexusForge refuses archives this large.`, 'too_large')
  for (const e of entries) {
    const bad = unsafeEntryName(e.path)
    if (bad) throw new ArchiveError(`Refused to unpack ${basename(file)}: it contains an ${bad}. Archives like this can overwrite files elsewhere on your PC.`, 'unsafe')
    if (e.link) throw new ArchiveError(`Refused to unpack ${basename(file)}: it contains a link (${e.path}). Mods never need links, and links can point anywhere on your PC.`, 'unsafe')
  }
  const total = entries.reduce((a, e) => a + e.size, 0)
  const packed = (await fsp.stat(file)).size
  if (total > MAX_BYTES || (total > 2 * 1024 ** 3 && total / Math.max(1, packed) > 400)) {
    throw new ArchiveError(`${basename(file)} would unpack to ${(total / 1024 ** 3).toFixed(1)} GB from ${(packed / 1024 ** 2).toFixed(0)} MB; that looks like a decompression bomb.`, 'too_large')
  }
  return entries
}

/** After extraction: nothing may be a link or junction, and everything must be inside `dest`. */
export async function validateExtracted(dest: string): Promise<void> {
  const root = resolve(dest)
  const realRoot = await fsp.realpath(root)
  const visit = async (dir: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      const st = await fsp.lstat(abs)
      if (st.isSymbolicLink()) {
        await fsp.rm(abs, { force: true, recursive: false }).catch(() => fsp.rmdir(abs).catch(() => {}))
        throw new ArchiveError(`Refused: the archive created a link (${relative(root, abs)}).`, 'unsafe')
      }
      const real = await fsp.realpath(abs)
      if (real.toLowerCase() !== realRoot.toLowerCase() && !real.toLowerCase().startsWith(realRoot.toLowerCase() + sep)) {
        throw new ArchiveError(`Refused: ${relative(root, abs)} ended up outside the extraction folder.`, 'unsafe')
      }
      if (st.isDirectory()) await visit(abs)
    }
  }
  await visit(root)
}

async function extractWithTar(file: string, dest: string): Promise<void> {
  // Windows 11 ships bsdtar (libarchive), which reads zip, 7z, rar and tarballs and refuses ".." paths.
  const tar = tarPath()
  if (!(await exists(tar))) throw new Error('tar.exe is not available on this system')
  const { code, stderr } = await run(tar, ['-xf', file, '-C', dest], { timeoutMs: 30 * 60_000 })
  if (code !== 0) throw new Error(stderr.trim() || `tar exited with code ${code}`)
}

async function extractWith7z(file: string, dest: string): Promise<void> {
  const { code, stderr, stdout } = await run(sevenZipPath(), ['x', file, `-o${dest}`, '-y', '-bd', '-bb0'], { timeoutMs: 30 * 60_000 })
  if (code !== 0) throw new Error((stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ') || `7-Zip exited with code ${code}`)
}

/**
 * Decompresses an LZMA "alone" file (Garry's Mod *_legacy.bin) into `destDir`. These files often lack the
 * end marker, so 7-Zip may report an error even though the data came out complete.
 */
export async function extractLzma(file: string, destDir: string): Promise<string> {
  await fsp.rm(destDir, { recursive: true, force: true })
  await fsp.mkdir(destDir, { recursive: true })
  const { stdout } = await run(sevenZipPath(), ['e', file, '-tlzma', `-o${destDir}`, '-y', '-bd'], { timeoutMs: 10 * 60_000 })
  const [produced] = await fsp.readdir(destDir)
  if (!produced) throw new Error(`Could not decompress ${basename(file)}: ${stdout.trim().split(/\r?\n/).pop()}`)
  const out = join(destDir, 'addon.gma')
  await fsp.rename(join(destDir, produced), out)
  return out
}

/** Packs the contents of `dir` (not the folder itself) into a new .zip. */
export async function zipFolder(dir: string, zipFile: string): Promise<void> {
  const { code, stderr, stdout } = await run(sevenZipPath(), ['a', '-tzip', '-mx=5', '-bd', zipFile, '*'], { cwd: dir, timeoutMs: 30 * 60_000 })
  if (code !== 0) throw new Error((stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ') || `7-Zip exited with code ${code}`)
}

/**
 * Extracts an archive into `dest` (created if needed) after checking its entries, then checks the result.
 * Damaged or incomplete archives and unsafe ones throw an ArchiveError with a plain explanation.
 */
export async function extractArchive(file: string, dest: string): Promise<void> {
  await inspectArchive(file)
  await fsp.mkdir(dest, { recursive: true })
  const ext = extname(file).toLowerCase()
  try {
    if (ext === '.zip') {
      try {
        await extractZip(file, { dir: resolve(dest) })
      } catch (err) {
        // Some zips (zip64, odd encodings) trip up yauzl; libarchive usually copes.
        await extractWithTar(file, dest).catch(() => {
          throw err
        })
      }
    } else if (ext === '.7z') {
      try {
        await extractWith7z(file, dest)
      } catch (err) {
        await extractWithTar(file, dest).catch(() => {
          throw err
        })
      }
    } else if (ext === '.rar') {
      try {
        await extractWithTar(file, dest)
      } catch (err) {
        throw new Error(`${(err as Error).message}. Extract it manually and install the folder instead.`)
      }
    } else {
      await extractWithTar(file, dest)
    }
  } catch (err) {
    if (err instanceof ArchiveError) throw err
    throw new ArchiveError(`Could not extract ${basename(file)}: ${(err as Error).message}. The archive may be damaged or the download incomplete; download it again.`, 'corrupt')
  }
  await validateExtracted(dest)
}
