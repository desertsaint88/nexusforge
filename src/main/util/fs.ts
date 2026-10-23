import { promises as fsp, constants as fsc, type Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsc.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Write JSON via temp file + rename so a crash never leaves a half-written file. */
export async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  await fsp.mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tmp, p)
}

export async function safeReaddir(p: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(p, { withFileTypes: true })
  } catch {
    return []
  }
}

export interface WalkEntry {
  /** Path relative to the walk root, forward slashes. */
  rel: string
  abs: string
  size: number
}

/** Recursively list files under root. Symlinked directories are not followed. */
export async function walkFiles(root: string, opts: { maxDepth?: number; limit?: number } = {}): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  const maxDepth = opts.maxDepth ?? 64
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  async function visit(dir: string, depth: number): Promise<void> {
    if (out.length >= limit) return
    const entries = await safeReaddir(dir)
    for (const e of entries) {
      if (out.length >= limit) return
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) await visit(abs, depth + 1)
      } else if (e.isFile() || e.isSymbolicLink()) {
        let size = 0
        try {
          size = (await fsp.stat(abs)).size
        } catch {
          continue
        }
        out.push({ rel: relative(root, abs).split(sep).join('/'), abs, size })
      }
    }
  }
  await visit(root, 0)
  return out
}

export async function dirSize(root: string): Promise<{ bytes: number; files: number }> {
  const files = await walkFiles(root)
  return { bytes: files.reduce((a, f) => a + f.size, 0), files: files.length }
}

/** Move a file, falling back to copy + delete when crossing volumes. */
export async function moveFile(from: string, to: string): Promise<void> {
  await fsp.mkdir(dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw err
    await fsp.copyFile(from, to)
    await fsp.unlink(from)
  }
}

/** Remove now-empty directories from `start` up to (not including) `stopAt`. */
export async function pruneEmptyDirs(start: string, stopAt: string): Promise<void> {
  let dir = start
  const stop = stopAt.toLowerCase()
  while (dir.toLowerCase().startsWith(stop) && dir.toLowerCase() !== stop) {
    try {
      await fsp.rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export function safeName(input: string): string {
  return input.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'item'
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
