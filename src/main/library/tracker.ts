// Finds a game's processes by where their executable lives. Many games are started through a small launcher
// (PlayGTAV.exe, a .bat, Steam's steam:// links) that exits right away while the real game keeps running;
// following the game folder keeps the "running" state and the play time right in those cases.

import { resolve } from 'node:path'
import { run } from '../util/exec'

/** Helpers that live in game folders but are not the game (they can stay around after it closed). */
const NOT_THE_GAME = /(crash|report|unins|setup|update|redist|vcredist|dxsetup|helper|service|easyanticheat|battleye|be_service|eac_|cefprocess|webhelper)/i

let cached: { at: number; paths: Promise<string[]> } | undefined

/** Executable paths of every running process (one PowerShell call, shared for 3 s). */
export function runningExecutables(): Promise<string[]> {
  if (cached && Date.now() - cached.at < 3000) return cached.paths
  const paths = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Property ExecutablePath).ExecutablePath'], { timeoutMs: 20_000 }).then((r) =>
    r.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
  )
  cached = { at: Date.now(), paths }
  return paths
}

/** Folders too broad to stand for one game (a drive root, "C:\Games"). */
export function trackableDir(dir: string | undefined): boolean {
  if (!dir) return false
  return resolve(dir).split(/[\\/]/).filter(Boolean).length >= 3
}

/** Running game executables inside the folder (helpers like crash reporters don't count). */
export function gameProcessesIn(dir: string, executables: string[]): string[] {
  const root = resolve(dir).toLowerCase().replace(/[\\/]+$/, '') + '\\'
  return executables.filter((p) => p.toLowerCase().startsWith(root) && /\.exe$/i.test(p) && !NOT_THE_GAME.test(p.slice(root.length)))
}

/**
 * Watches a game folder: waits up to `appearWithinMs` for the game to show up, then until it is gone
 * (two checks in a row). Calls `done` with the time it was last seen, or undefined if it never appeared.
 */
export function followGameFolder(dir: string, opts: { appearWithinMs: number; stillWanted(): boolean; done(lastSeen: number | undefined): void }): void {
  const deadline = Date.now() + opts.appearWithinMs
  const giveUp = Date.now() + 16 * 3_600_000
  let lastSeen: number | undefined
  let misses = 0
  const tick = async () => {
    if (!opts.stillWanted()) return
    const alive = gameProcessesIn(dir, await runningExecutables().catch(() => [])).length > 0
    if (alive) {
      lastSeen = Date.now()
      misses = 0
    } else if (lastSeen) misses++
    if ((lastSeen && misses >= 2) || (!lastSeen && Date.now() > deadline) || Date.now() > giveUp) return opts.done(lastSeen)
    setTimeout(() => void tick(), lastSeen ? 15_000 : 4000)
  }
  void tick()
}
