import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { exists, moveFile, readJson, safeReaddir, walkFiles } from '../util/fs'

const DOC_FILE = /\.(txt|md|rtf|pdf|html?|url|nfo|docx?)$/i
const METADATA = new Set(['manifest.json', 'icon.png', 'readme.md', 'changelog.md', 'license', 'license.txt', 'license.md'])

// Folder names that belong *inside* a game folder, so an archive whose only entry is one of these is
// already laid out correctly and must not be unwrapped.
const GAME_DIRS = new Set([
  'data', 'bin', 'binaries', 'content', 'bepinex', 'plugins', 'r6', 'red4ext', 'archive', 'mods', 'x64', 'engine', 'scripts',
  'textures', 'meshes', 'sound', 'music', 'interface', 'lua', 'materials', 'models', 'maps', 'skse', 'f4se', 'nativepc', 'paks',
  'game', 'resources', 'dlc', 'audio', 'shaders', 'ui', 'config', 'gamedata', 'melonloader', 'userlibs', 'userdata', 'addons',
    'garrysmod', 'root', 'pak', 'movies', 'video', 'fonts', 'strings', 'seq', 'grass', 'lodsettings', 'shadersfx'
])

/**
 * Picks the folder inside an extracted mod that maps onto the game's deploy target:
 * strips wrapper folders ("ModName v1.2/...") and descends into a folder named like the target ("Data/...").
 */
export async function detectRoot(dir: string, targetBase: string, keepWrapper = false): Promise<string> {
  const parts: string[] = []
  const target = targetBase.toLowerCase()
  for (let depth = 0; depth < 4; depth++) {
    const entries = (await safeReaddir(join(dir, ...parts))).filter((e) => !(e.isFile() && DOC_FILE.test(e.name)))
    const dirs = entries.filter((e) => e.isDirectory())
    const files = entries.filter((e) => !e.isDirectory())
    const targetDir = dirs.find((d) => d.name.toLowerCase() === target)
    // "Data/" next to nothing but docs: that's the target folder itself.
    if (target && targetDir && files.length === 0 && dirs.length === 1) {
      parts.push(targetDir.name)
      break
    }
    if (files.length || dirs.length !== 1) break
    const only = dirs[0].name
    if (keepWrapper && depth === 0) break
    if (GAME_DIRS.has(only.toLowerCase())) break
    parts.push(only)
  }
  return parts.join('/')
}

interface ThunderstoreManifest {
  name?: string
  version_number?: string
  website_url?: string
  description?: string
  dependencies?: string[]
}

export async function readThunderstoreManifest(dir: string): Promise<ThunderstoreManifest | undefined> {
  const m = await readJson<ThunderstoreManifest>(join(dir, 'manifest.json'))
  return m && typeof m.name === 'string' && typeof m.version_number === 'string' ? m : undefined
}

/**
 * Rearranges a Thunderstore package into a BepInEx layout under `<dir>/__deploy` (r2modman's default rules)
 * and returns the root path to deploy from.
 */
export async function applyThunderstoreLayout(dir: string, fullName: string): Promise<string> {
  const manifest = await readThunderstoreManifest(dir)
  const entries = await safeReaddir(dir)
  if (/^bepinexpack/i.test(manifest?.name ?? '') || entries.some((e) => e.isDirectory() && /^bepinexpack/i.test(e.name))) {
    const pack = entries.find((e) => e.isDirectory() && /^bepinexpack/i.test(e.name))
    if (pack) return pack.name
  }
  const out = join(dir, '__deploy')
  const pluginDir = join(out, 'BepInEx', 'plugins', fullName)
  await fsp.mkdir(pluginDir, { recursive: true })
  const moveDirContents = async (from: string, to: string) => {
    for (const f of await walkFiles(from)) await moveFile(f.abs, join(to, ...f.rel.split('/')))
  }
  for (const e of entries) {
    const from = join(dir, e.name)
    const lower = e.name.toLowerCase()
    if (lower === '__deploy') continue
    if (e.isFile() && METADATA.has(lower)) continue
    if (e.isDirectory()) {
      if (lower === 'bepinex') await moveDirContents(from, join(out, 'BepInEx'))
      else if (lower === 'plugins') await moveDirContents(from, pluginDir)
      else if (lower === 'patchers') await moveDirContents(from, join(out, 'BepInEx', 'patchers', fullName))
      else if (lower === 'config') await moveDirContents(from, join(out, 'BepInEx', 'config'))
      else if (lower === 'core') await moveDirContents(from, join(out, 'BepInEx', 'core'))
      else await moveDirContents(from, join(pluginDir, e.name))
    } else {
      await moveFile(from, join(pluginDir, e.name))
    }
  }
  // Remove the now empty source folders.
  for (const e of entries) {
    if (e.isDirectory() && e.name !== '__deploy' && (await exists(join(dir, e.name)))) {
      await fsp.rm(join(dir, e.name), { recursive: true, force: true })
    }
  }
  return '__deploy'
}
