// Publishes the installer built by `npm run dist` as a GitHub release of desertsaint88/nexusforge:
// NexusForge-Setup-<version>.exe, its .blockmap (differential updates) and latest.yml (what installed copies read).
// Uploads one file at a time with retries and checks each upload against GitHub's SHA-256 digest.
//
// Usage: npm run release [-- --notes notes.md]   (raise "version" in package.json and push first)
// Token: GH_TOKEN, else the GitHub login Git has stored (Git Credential Manager). It is never printed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const OWNER = 'desertsaint88'
const REPO = 'nexusforge'
const version = pkg.version
const tag = `v${version}`
const files = [`NexusForge-Setup-${version}.exe`, `NexusForge-Setup-${version}.exe.blockmap`, 'latest.yml'].map((f) => join(root, 'release', f))

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  const out = execFileSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  const t = out.match(/^password=(.+)$/m)?.[1]
  if (!t) throw new Error('No GitHub token: set GH_TOKEN or sign in with "git credential-manager github login".')
  return t
}

const TOKEN = token()
const headers = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'nexusforge-release', Accept: 'application/vnd.github+json' }

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`)
  return r.status === 204 ? undefined : r.json()
}

for (const f of files) if (!existsSync(f)) throw new Error(`${f} is missing: run "npm run dist" first.`)
const yml = readFileSync(files[2], 'utf8')
if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml)) throw new Error(`release/latest.yml is not for ${version}: run "npm run dist" again.`)

// The commit must be on GitHub before it can be tagged.
const head = git('rev-parse', 'HEAD')
git('fetch', 'origin', '--quiet')
if (!git('branch', '-r', '--contains', head).includes('origin/')) throw new Error(`HEAD (${head.slice(0, 7)}) is not pushed: run "git push" first.`)
if (git('status', '--porcelain', '--untracked-files=no')) console.warn('warning: uncommitted changes; the release is built from the working tree.')

const existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`).catch(() => undefined)
if (existing) throw new Error(`${tag} already exists: ${existing.html_url}`)

const notesArg = process.argv.indexOf('--notes')
let body = notesArg > 0 ? readFileSync(process.argv[notesArg + 1], 'utf8') : ''
if (!body) {
  const prev = (() => {
    try {
      return git('describe', '--tags', '--abbrev=0', 'HEAD^')
    } catch {
      return ''
    }
  })()
  const log = git('log', '--format=- %s', prev ? `${prev}..HEAD` : 'HEAD', '-n', '30')
  body = `${log}\n\nThe installer is not code-signed: if SmartScreen warns, click More info > Run anyway.`
}

// Created as a draft, published once every file is up: installed copies never see a half-uploaded release.
const release = await api(`/repos/${OWNER}/${REPO}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: head, name: version, body, draft: true, prerelease: false }) })
console.log(`draft ${tag} created`)

for (const file of files) {
  const name = file.split(/[\\/]/).pop()
  const data = readFileSync(file)
  const sha256 = createHash('sha256').update(data).digest('hex')
  let done = false
  for (let attempt = 1; attempt <= 4 && !done; attempt++) {
    try {
      const r = await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Content-Length': String(statSync(file).size) },
        body: data
      })
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
      const asset = await r.json()
      if (asset.digest && asset.digest !== `sha256:${sha256}`) throw new Error(`digest mismatch (${asset.digest})`)
      console.log(`uploaded ${name} (${(data.length / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`)
      done = true
    } catch (err) {
      console.warn(`upload ${name}, attempt ${attempt}: ${err.message}`)
      // A failed attempt can leave a broken asset behind; remove it before retrying.
      const assets = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)
      for (const a of assets.filter((x) => x.name === name)) await api(`/repos/${OWNER}/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' })
      await new Promise((r) => setTimeout(r, attempt * 3000))
    }
  }
  if (!done) throw new Error(`could not upload ${name}; the draft stays unpublished: ${release.html_url}`)
}

const published = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) })
console.log(`published ${published.html_url}`)
