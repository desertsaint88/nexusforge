// The Electron side of the integrations: real folders, network, Steam, and the remembered state.

import { app, shell } from 'electron'
import { join } from 'node:path'
import type { IntegrationEnv, IntegrationState } from './types'
import { createSteamEnv } from './steam-apps'
import { GITHUB_HOSTS } from './github'
import { db } from '../store'
import { scoped } from '../logger'
import { httpJson, USER_AGENT, HttpError } from '../sources/http'
import { readExeVersion } from '../library/exe-version'
import { extractArchive } from '../mods/archive'
import { downloadVerified } from '../util/download'

let env: IntegrationEnv | undefined

export function integrationEnv(): IntegrationEnv {
  if (env) return env
  env = {
    documents: app.getPath('documents'),
    publicDocuments: join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Documents'),
    workDir: join(app.getPath('userData'), 'integrations'),
    steam: createSteamEnv(),
    log: scoped('integrations'),
    fetchJson: <T>(url: string) => httpJson<T>(url, { headers: url.includes('api.github.com') ? { Accept: 'application/vnd.github+json' } : {} }),
    async fetchText(url: string) {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status)
      return res.text()
    },
    download: (url, dest, opts) => downloadVerified(url, dest, { ...opts, allowedHosts: opts?.allowedHosts ?? GITHUB_HOSTS, userAgent: USER_AGENT }),
    async openUrl(url) {
      // Only Steam's own install/uninstall links; everything else stays inside NexusForge.
      if (!/^steam:\/\/(install|uninstall|rungameid|run)\/\d+/.test(url)) throw new Error(`Refusing to open ${url}`)
      await shell.openExternal(url)
    },
    fileVersion: readExeVersion,
    extract: (archive, dest) => extractArchive(archive, dest)
  }
  return env
}

export function integrationState(gameId: string): IntegrationState {
  const s = db().get('integrations')?.[gameId]
  return s ? { ...s, loaders: { ...(s.loaders ?? {}) } } : { loaders: {} }
}

export function saveIntegrationState(gameId: string, state: IntegrationState): void {
  db().set('integrations', { ...(db().get('integrations') ?? {}), [gameId]: state })
}
