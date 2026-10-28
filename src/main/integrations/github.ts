// Official release downloads from GitHub (tModLoader, BepInEx). GitHub publishes a SHA-256 digest for each
// release asset; downloads are checked against it, and against the size, before anything is unpacked.

import type { IntegrationEnv } from './types'

export interface GhAsset {
  name: string
  size: number
  browser_download_url: string
  /** "sha256:<hex>" (GitHub adds it to every asset uploaded since 2025). */
  digest?: string | null
}

export interface GhRelease {
  tag_name: string
  name: string
  prerelease: boolean
  draft: boolean
  published_at: string
  html_url: string
  assets: GhAsset[]
}

/** Hosts release downloads come from (the download URL redirects to GitHub's asset storage). */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']

const cache = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as T
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

export function releases(env: Pick<IntegrationEnv, 'fetchJson'>, repo: string): Promise<GhRelease[]> {
  return cached(`releases:${repo}`, 30 * 60_000, async () =>
    (await env.fetchJson<GhRelease[]>(`https://api.github.com/repos/${repo}/releases?per_page=30`)).filter((r) => !r.draft)
  )
}

export function latestRelease(env: Pick<IntegrationEnv, 'fetchJson'>, repo: string): Promise<GhRelease> {
  return cached(`latest:${repo}`, 30 * 60_000, () => env.fetchJson<GhRelease>(`https://api.github.com/repos/${repo}/releases/latest`))
}

export function sha256Of(asset: GhAsset): string | undefined {
  const m = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)
  return m?.[1].toLowerCase()
}

/** For tests: forget cached release lists. */
export function clearReleaseCache(): void {
  cache.clear()
}
