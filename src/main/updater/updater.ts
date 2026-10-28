// NexusForge updates itself from its GitHub releases (see @shared/app-repo).
//
// Installed copy (NSIS installer, app-update.yml next to the app): electron-updater checks the release, downloads
// the new installer inside the app (differential download against the cached previous one, SHA-512 checked) and
// runs it silently; the old version is replaced, user data in %APPDATA%\NexusForge stays, and the app restarts.
// Copy run from a folder (unpacked build, portable): the release's installer is downloaded, checked against the
// SHA-512 in latest.yml, and started; afterwards NexusForge runs as an installed copy and updates itself.
// Development runs only check.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import updaterPkg from 'electron-updater'
import type { AppUpdateStatus } from '@shared/types'
import { APP_REPO } from '@shared/app-repo'
import { scoped } from '../logger'
import { emit } from '../events'
import { downloadVerified } from '../util/download'
import { GITHUB_HOSTS, type GhRelease } from '../integrations/github'
import { plainText } from '../bugreport/report'
import { endSession } from '../bugreport/session'
import { compareVersions, parseLatestYml } from './versions'

const log = scoped('updater')
const UA = `NexusForge/${app.getVersion()}`

/** How this copy can update. */
export function updateMode(): AppUpdateStatus['mode'] {
  if (!app.isPackaged) return 'dev'
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'installer'
  return existsSync(join(process.resourcesPath, 'app-update.yml')) ? 'auto' : 'installer'
}

/** For bug reports: how NexusForge was started. */
export function installKind(): string {
  if (!app.isPackaged) return 'development'
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  return updateMode() === 'auto' ? 'installed' : 'folder copy'
}

let status: AppUpdateStatus = { current: app.getVersion(), mode: 'dev', phase: 'idle' }

function set(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
  status = { ...status, ...patch }
  emit('updater:state', status)
  return status
}

export function updateStatus(): AppUpdateStatus {
  return status
}

// --- Installed copies: electron-updater ---------------------------------------------------------------------------

const { autoUpdater } = updaterPkg
let wired = false

function wireAutoUpdater(): void {
  if (wired) return
  wired = true
  autoUpdater.logger = log
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.on('update-available', (info) => {
    const notes = typeof info.releaseNotes === 'string' ? plainText(info.releaseNotes) : Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => plainText(n.note ?? '')).join('\n\n') : undefined
    set({
      phase: 'available',
      version: info.version,
      releaseName: info.releaseName ?? undefined,
      notes,
      releaseDate: info.releaseDate,
      releaseUrl: `https://github.com/${APP_REPO.owner}/${APP_REPO.name}/releases/tag/v${info.version}`,
      checkedAt: Date.now(),
      error: undefined
    })
  })
  autoUpdater.on('update-not-available', () => set({ phase: 'none', version: undefined, checkedAt: Date.now(), error: undefined }))
  autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }))
}

// --- Copies run from a folder: GitHub API + the release's installer ------------------------------------------------

let manualRelease: { release: GhRelease; version: string } | undefined

async function latestRelease(): Promise<GhRelease | undefined> {
  const r = await fetch(`https://api.github.com/repos/${APP_REPO.owner}/${APP_REPO.name}/releases/latest`, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } })
  if (r.status === 404) return undefined
  if (!r.ok) throw new Error(`GitHub answered ${r.status} ${r.statusText}`)
  return (await r.json()) as GhRelease
}

async function sha512Base64(file: string): Promise<string> {
  const h = createHash('sha512')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('base64')
}

// --- Public ---------------------------------------------------------------------------------------------------------

let checking: Promise<AppUpdateStatus> | undefined

export function checkForUpdates(): Promise<AppUpdateStatus> {
  if (status.phase === 'downloading' || status.phase === 'installing') return Promise.resolve(status)
  checking ??= (async () => {
    set({ mode: updateMode(), phase: 'checking', error: undefined })
    try {
      if (status.mode === 'auto') {
        wireAutoUpdater()
        await autoUpdater.checkForUpdates()
        // The events set the result; if none fired (no release yet), say so.
        if (status.phase === 'checking') set({ phase: 'none', checkedAt: Date.now() })
      } else {
        const release = await latestRelease()
        const version = release?.tag_name.replace(/^v/i, '')
        if (release && version && compareVersions(version, app.getVersion()) > 0) {
          manualRelease = { release, version }
          set({ phase: 'available', version, releaseName: release.name, notes: (release as GhRelease & { body?: string }).body?.trim() || undefined, releaseDate: release.published_at, releaseUrl: release.html_url, checkedAt: Date.now() })
        } else {
          manualRelease = undefined
          set({ phase: 'none', version: undefined, checkedAt: Date.now() })
        }
      }
      log.info(`update check: ${status.phase}${status.version ? ` ${status.version}` : ''} (running ${app.getVersion()}, ${status.mode})`)
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      // No release published yet is not an error.
      if (/\b404\b|Cannot find latest\.yml|No published versions|Unable to find latest version/i.test(message)) set({ phase: 'none', checkedAt: Date.now(), error: undefined })
      else {
        log.warn(`update check failed: ${message}`)
        set({ phase: 'error', error: message.split('\n')[0].slice(0, 300), checkedAt: Date.now() })
      }
    }
    return status
  })().finally(() => {
    checking = undefined
  })
  return checking
}

/** Downloads and installs the available version. Resolves when the installer has been started (the app quits). */
export async function installUpdate(): Promise<void> {
  if (status.phase !== 'available' && status.phase !== 'error') throw new Error('No update is waiting.')
  if (!status.version) throw new Error('No update is waiting.')
  if (status.mode === 'dev') throw new Error('This is a development run. Updates install in the installed NexusForge.')
  const version = status.version
  set({ phase: 'downloading', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: undefined })
  try {
    if (status.mode === 'auto') {
      wireAutoUpdater()
      await autoUpdater.downloadUpdate()
      set({ phase: 'installing', percent: 100 })
      log.info(`installing ${version}: quitting for the silent installer`)
      endSession()
      // Silent install, then start the new version.
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 600)
      return
    }
    // A copy run from a folder: download the release's installer and start it.
    const rel = manualRelease?.release
    const yml = rel?.assets.find((a) => a.name === 'latest.yml')
    if (!rel || !yml) throw new Error('The release has no installer information (latest.yml).')
    const ymlRes = await fetch(yml.browser_download_url, { headers: { 'User-Agent': UA } })
    if (!ymlRes.ok) throw new Error(`latest.yml: ${ymlRes.status}`)
    const meta = parseLatestYml(await ymlRes.text())
    const asset = rel.assets.find((a) => a.name === meta.file || a.name.replace(/ /g, '-') === meta.file)
    if (!asset || !meta.sha512) throw new Error('The release has no installer for Windows.')
    const dir = join(app.getPath('temp'), 'nexusforge-update')
    await fsp.mkdir(dir, { recursive: true })
    const dest = join(dir, asset.name)
    const started = Date.now()
    await downloadVerified(asset.browser_download_url, dest, {
      size: asset.size,
      allowedHosts: GITHUB_HOSTS,
      userAgent: UA,
      onProgress: (received, total) => {
        const secs = Math.max(0.5, (Date.now() - started) / 1000)
        set({ phase: 'downloading', percent: total ? (received / total) * 100 : 0, transferred: received, total, bytesPerSecond: received / secs })
      }
    })
    if ((await sha512Base64(dest)) !== meta.sha512) {
      await fsp.rm(dest, { force: true })
      throw new Error('The downloaded installer does not match the checksum in the release (latest.yml). It was deleted.')
    }
    set({ phase: 'installing', percent: 100 })
    log.info(`starting the ${version} installer (${dest})`)
    spawn(dest, [], { detached: true, stdio: 'ignore' }).unref()
    endSession()
    setTimeout(() => app.quit(), 800)
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    log.error(`update to ${version} failed: ${message}`)
    set({ phase: 'error', version, error: message.split('\n')[0].slice(0, 300) })
    throw err
  }
}

let interval: NodeJS.Timeout | undefined

/** At start (when the setting is on) and every 4 hours while NexusForge runs. */
export function startUpdateChecks(enabled: () => boolean): void {
  status = { ...status, mode: updateMode() }
  const run = () => {
    if (!enabled()) return
    void checkForUpdates().then((s) => {
      if (s.phase === 'available' && s.version && s.version !== announced) {
        announced = s.version
        emit('toast', {
          kind: 'info',
          title: `NexusForge ${s.version} is available`,
          message: s.mode === 'auto' ? 'It installs inside the app and restarts; your library, mods and settings stay.' : 'NexusForge downloads its installer and starts it.',
          sticky: true,
          action: { id: 'update', label: 'Update now' }
        })
      }
    })
  }
  setTimeout(run, 4000)
  interval = setInterval(run, 4 * 60 * 60_000)
  interval.unref()
}

let announced: string | undefined
