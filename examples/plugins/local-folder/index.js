// Example NexusForge plugin: turns a folder of mod archives into a searchable mod source.
//
// Install: copy this folder to %APPDATA%\NexusForge\plugins\local-folder, edit config.json,
// then trust it in Settings > Sources & plugins.

const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, extname, basename } = require('node:path')
const { pathToFileURL } = require('node:url')

const ARCHIVES = new Set(['.zip', '.7z', '.rar'])

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'))
  } catch {
    return { folder: '' }
  }
}

function listArchives() {
  const { folder } = loadConfig()
  if (!folder) return []
  return readdirSync(folder)
    .filter((f) => ARCHIVES.has(extname(f).toLowerCase()))
    .map((f) => {
      const full = join(folder, f)
      const st = statSync(full)
      return { id: f, name: basename(f, extname(f)).replace(/[_-]+/g, ' '), path: full, size: st.size, date: st.mtime.toISOString() }
    })
}

exports.createAdapter = (ctx) => ({
  id: 'local-folder',
  name: 'My archive folder',
  description: 'Mod archives from a folder on this PC (set it in the plugin\'s config.json).',

  async search(query) {
    const q = query.trim().toLowerCase()
    return listArchives()
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((a) => ({ id: a.id, sourceId: 'local-folder', name: a.name, summary: a.path, updatedAt: a.date }))
  },

  async getModDetails(modId) {
    const a = listArchives().find((x) => x.id === modId)
    if (!a) throw new Error('Archive not found')
    ctx.log.info(`details for ${a.path}`)
    return {
      id: a.id,
      sourceId: 'local-folder',
      name: a.name,
      summary: a.path,
      description: `Local archive:\n${a.path}`,
      images: [],
      versions: [{ id: 'file', name: basename(a.path), sizeBytes: a.size, date: a.date, primary: true }]
    }
  },

  async getDownloadUrl(modId) {
    const a = listArchives().find((x) => x.id === modId)
    if (!a) throw new Error('Archive not found')
    return pathToFileURL(a.path).toString()
  }
})
