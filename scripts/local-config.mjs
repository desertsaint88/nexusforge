// Settings of the PC the live checks and probes run on: which games its library must list, which games to
// screenshot, local game copies. They live in scripts/local.json, which stays out of git (layout:
// scripts/local.example.json); without it the checks that need them are skipped.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const file = join(import.meta.dirname, 'local.json')

/** @type {{ libraryGames?: string[]; probeGames?: Record<string, string[]>; terrariaDir?: string; mcPack?: string }} */
export const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}

/** Games a probe looks at: GAMES ("A|B|C"), else scripts/local.json, else `fallback`. */
export function probeGames(name, fallback = []) {
  if (process.env.GAMES) return process.env.GAMES.split('|')
  return local.probeGames?.[name] ?? fallback
}
