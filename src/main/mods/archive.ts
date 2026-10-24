import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import extractZip from 'extract-zip'
import sevenBin from '7zip-bin'
import { run } from '../util/exec'
import { exists } from '../util/fs'

export const ARCHIVE_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.xz']

export function isArchive(file: string): boolean {
  const lower = file.toLowerCase()
  return ARCHIVE_EXT.some((e) => lower.endsWith(e))
}

function sevenZipPath(): string {
  // electron-builder unpacks the binary next to app.asar.
  const p = sevenBin.path7za
  return app.isPackaged ? p.replace(`app.asar${p.includes('\\') ? '\\' : '/'}`, `app.asar.unpacked${p.includes('\\') ? '\\' : '/'}`) : p
}

async function extractWithTar(file: string, dest: string): Promise<void> {
  // Windows 11 ships bsdtar (libarchive), which reads zip, 7z, rar and tarballs and refuses ".." paths.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
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

/** Extracts an archive into `dest` (created if needed). */
export async function extractArchive(file: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const ext = extname(file).toLowerCase()
  if (ext === '.zip') {
    try {
      await extractZip(file, { dir: dest })
      return
    } catch (err) {
      // Some zips (zip64, odd encodings) trip up yauzl; libarchive usually copes.
      await extractWithTar(file, dest).catch(() => {
        throw err
      })
      return
    }
  }
  if (ext === '.7z') {
    try {
      await extractWith7z(file, dest)
    } catch (err) {
      await extractWithTar(file, dest).catch(() => {
        throw err
      })
    }
    return
  }
  if (ext === '.rar') {
    try {
      await extractWithTar(file, dest)
    } catch (err) {
      throw new Error(`Could not extract ${basename(file)}: ${(err as Error).message}. Extract it manually and install the folder instead.`)
    }
    return
  }
  await extractWithTar(file, dest)
}
