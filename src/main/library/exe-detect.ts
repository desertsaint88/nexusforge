import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { safeReaddir } from '../util/fs'

// Executables that are almost never the game itself.
const EXCLUDE = [
  /^unins/i, /uninstall/i, /^setup/i, /^install/i, /redist/i, /vcredist/i, /vc_redist/i, /dxsetup/i, /dxwebsetup/i,
  /directx/i, /crash/i, /^ue4prereq/i, /prereq/i, /^dotnet/i, /^ndp\d/i, /^oalinst/i, /physx/i, /easyanticheat/i,
  /^eac/i, /battleye/i, /^be(service|launcher)/i, /report/i, /^cefsharp/i, /helper/i, /^updater?/i, /^patch/i,
  /^dowser/i, /^touchup/i, /^quicksfv/i, /^activation/i, /^cleanup/i, /^7z/i, /^unitycrashhandler/i, /^zfgamebrowser/i,
  /^steamservice/i, /^steamerrorreporter/i, /^sendrpt/i, /^vrcompositor/i, /^vrserver/i, /config(urator|tool)?\.exe$/i,
  /^launcherpatcher/i, /^epicwebhelper/i, /^dotnetfx/i, /^vulkan/i, /^winrar/i, /^notification_helper/i, /^nwjs/i,
  /^python/i, /^pythonw/i, /^node\.exe$/i, /^java/i, /^ffmpeg/i, /^ffprobe/i, /^blender/i
]

const EXCLUDE_DIRS = /^(_commonredist|redist|redistributables?|directx|dotnet|vcredist|support|__installer|installers?|prereqs?|_redist|commonredist|easyanticheat|battleye|tools|sdk|docs?|manual|soundtrack|ost|artbook|extras)$/i
const PREFER_DIRS = /^(bin|binaries|win64|win32|x64|game|retail|shipping)$/i

export interface ExeCandidate {
  path: string
  size: number
  depth: number
  score: number
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function similarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.8
  // shared prefix ratio
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i >= 3 ? Math.min(0.7, i / Math.max(x.length, y.length) + 0.2) : 0
}

export function isExcludedExe(name: string): boolean {
  return EXCLUDE.some((r) => r.test(name))
}

/** Scores every .exe up to `maxDepth` levels deep; best candidate first. */
export async function findExecutables(root: string, gameName: string, maxDepth = 4): Promise<ExeCandidate[]> {
  const found: ExeCandidate[] = []
  let visitedDirs = 0
  async function visit(dir: string, depth: number, preferred: boolean): Promise<void> {
    if (visitedDirs++ > 400) return
    const entries = await safeReaddir(dir)
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth && !EXCLUDE_DIRS.test(e.name) && !e.name.startsWith('.')) {
          await visit(full, depth + 1, preferred || PREFER_DIRS.test(e.name))
        }
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe') && !isExcludedExe(e.name)) {
        let size = 0
        try {
          size = (await fsp.stat(full)).size
        } catch {
          continue
        }
        const nameScore = Math.max(similarity(e.name.replace(/\.exe$/i, ''), gameName), similarity(e.name.replace(/\.exe$/i, ''), basename(root)))
        let score = nameScore * 50
        score += Math.min(25, Math.log2(Math.max(size, 1)) - 10) // bigger binaries are usually the game
        score -= depth * 6
        if (preferred) score += 6
        if (/launcher/i.test(e.name)) score -= 8
        if (/-win64-shipping|_x64|64\.exe$/i.test(e.name)) score += 4
        if (/(dx11|dx12|vulkan)/i.test(e.name)) score += 2
        if (size < 150 * 1024) score -= 15
        found.push({ path: full, size, depth, score })
      }
    }
  }
  await visit(root, 0, false)
  return found.sort((a, b) => b.score - a.score)
}

export async function findMainExecutable(root: string, gameName: string): Promise<string | undefined> {
  return (await findExecutables(root, gameName))[0]?.path
}
