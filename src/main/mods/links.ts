import { promises as fsp } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LinkCapabilities } from '@shared/types'

const drive = (p: string) => parse(resolve(p)).root.replace(/[\\/]+$/, '')

/**
 * Checks which ways of placing files work from `sourceDir` (mod storage) into `targetDir` (game).
 * Hardlinks need both folders on one drive (NTFS); symlinks need the Windows right "Create symbolic links",
 * which only administrators and PCs with Developer Mode have. Copies always work. NexusForge never needs
 * symlinks: 'auto' hardlinks on the same drive and copies otherwise.
 */
export async function probeLinks(sourceDir: string, targetDir: string): Promise<LinkCapabilities> {
  const tag = randomBytes(4).toString('hex')
  const src = join(sourceDir, `.nf-probe-${tag}.tmp`)
  const sym = join(targetDir, `.nf-probe-${tag}.sym`)
  const hard = join(targetDir, `.nf-probe-${tag}.hard`)
  const result: LinkCapabilities = { symlink: false, hardlink: false }
  try {
    await fsp.mkdir(sourceDir, { recursive: true })
    await fsp.writeFile(src, 'probe')
  } catch (err) {
    return { symlink: false, hardlink: false, symlinkReason: `Mod storage is not writable: ${(err as Error).message}`, hardlinkReason: 'Mod storage is not writable', autoMethod: 'Mod storage is not writable.' }
  }
  try {
    await fsp.symlink(src, sym, 'file')
    result.symlink = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    result.symlinkReason =
      code === 'EPERM'
        ? 'Not available: Windows only lets administrators (or PCs with Developer Mode) create symlinks. Not needed: hardlinks and copies give the game the same files.'
        : code === 'EACCES' || code === 'ENOENT'
          ? 'The game folder is not writable.'
          : `Symlinks failed (${code ?? 'unknown'}).`
  }
  try {
    await fsp.link(src, hard)
    result.hardlink = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    result.hardlinkReason =
      code === 'EXDEV'
        ? `Mod storage (${drive(sourceDir)}) and the game (${drive(targetDir)}) are on different drives, so files are copied. Move mod storage to ${drive(targetDir)} to link instead.`
        : code === 'EACCES' || code === 'ENOENT'
          ? 'The game folder is not writable.'
          : `Hardlinks failed (${code ?? 'unknown'}), for example on FAT32/exFAT drives. Files are copied instead.`
  }
  await Promise.allSettled([fsp.unlink(sym), fsp.unlink(hard), fsp.unlink(src)])
  result.autoMethod = result.hardlink
    ? 'Automatic hardlinks the files: no extra disk space, no special rights.'
    : 'Automatic copies the files (mod storage is on another drive or the drive does not support links).'
  return result
}
