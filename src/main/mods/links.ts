import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LinkCapabilities } from '@shared/types'

/**
 * Checks whether symlinks and hardlinks can be created from `sourceDir` (mod storage) into `targetDir` (game).
 * File symlinks on Windows need Developer Mode or admin rights; hardlinks need both folders on the same volume.
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
    return { symlink: false, hardlink: false, symlinkReason: `Mod storage is not writable: ${(err as Error).message}`, hardlinkReason: 'Mod storage is not writable' }
  }
  try {
    await fsp.symlink(src, sym, 'file')
    result.symlink = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    result.symlinkReason =
      code === 'EPERM'
        ? 'Windows only allows symlinks with Developer Mode enabled or when running as administrator.'
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
        ? 'Mod storage and the game are on different drives. Move mod storage to the same drive to enable hardlinks.'
        : code === 'EACCES' || code === 'ENOENT'
          ? 'The game folder is not writable.'
          : `Hardlinks failed (${code ?? 'unknown'}).`
  }
  await Promise.allSettled([fsp.unlink(sym), fsp.unlink(hard), fsp.unlink(src)])
  return result
}
