// HTTPS downloads into a file: resumed after a dropped connection (HTTP Range), retried on network errors,
// and checked against the size and SHA-256 the publisher states before the file is handed on.

import { createReadStream, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'

export interface VerifiedDownloadOptions {
  sha256?: string
  size?: number
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
  /** Hosts the download (and every redirect) may come from. */
  allowedHosts?: string[]
  userAgent?: string
  headers?: Record<string, string>
  /** Attempts in total (default 4). */
  attempts?: number
  /** For tests. */
  fetchImpl?: typeof fetch
  backoffMs?: number
}

export class DownloadError extends Error {
  constructor(
    message: string,
    public retryable: boolean
  ) {
    super(message)
  }
}

const RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

function hostAllowed(url: string, allowed?: string[]): boolean {
  if (!allowed?.length) return true
  try {
    const h = new URL(url).hostname.toLowerCase()
    return allowed.some((a) => h === a || h.endsWith(`.${a}`))
  } catch {
    return false
  }
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function sizeOf(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size
  } catch {
    return 0
  }
}

export async function downloadVerified(url: string, dest: string, opts: VerifiedDownloadOptions = {}): Promise<{ sha256: string; size: number }> {
  if (!/^https:\/\//i.test(url)) throw new DownloadError('Only HTTPS downloads are allowed.', false)
  if (!hostAllowed(url, opts.allowedHosts)) throw new DownloadError(`Refusing to download from ${new URL(url).hostname}.`, false)
  const doFetch = opts.fetchImpl ?? fetch
  const part = `${dest}.part`
  const attempts = opts.attempts ?? 4
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new DownloadError('Download cancelled.', false)
    const have = await sizeOf(part)
    try {
      const headers: Record<string, string> = { 'User-Agent': opts.userAgent ?? 'NexusForge', ...opts.headers }
      if (have > 0) headers.Range = `bytes=${have}-`
      const res = await doFetch(url, { headers, redirect: 'follow', signal: opts.signal })
      if (res.url && !hostAllowed(res.url, opts.allowedHosts)) throw new DownloadError(`The download was redirected to ${new URL(res.url).hostname}, which is not allowed.`, false)
      if (res.status === 416 && have > 0 && opts.size && have === opts.size) {
        // Already complete from an earlier run.
      } else {
        if (!res.ok || !res.body) {
          const retryable = res.status >= 500 || res.status === 408 || res.status === 429
          throw new DownloadError(`The server answered ${res.status} ${res.statusText}.`, retryable)
        }
        const resumed = res.status === 206 && have > 0
        const length = Number(res.headers.get('content-length') ?? 0)
        const total = (resumed ? have : 0) + length || opts.size || 0
        let received = resumed ? have : 0
        let last = 0
        // Every chunk is written before the next is read, so a dropped connection leaves all received bytes on disk.
        const fh = await fsp.open(part, resumed ? 'a' : 'w')
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            await fh.write(chunk)
            received += chunk.length
            const now = Date.now()
            if (now - last > 150) {
              last = now
              opts.onProgress?.(received, total)
            }
          }
        } finally {
          await fh.close()
        }
        opts.onProgress?.(received, total)
      }
      const size = await sizeOf(part)
      if (opts.size && size !== opts.size) {
        if (size < opts.size) throw new DownloadError(`The download stopped early (${size} of ${opts.size} bytes).`, true)
        await fsp.rm(part, { force: true })
        throw new DownloadError(`The download has the wrong size (${size} bytes, expected ${opts.size}).`, true)
      }
      const sha256 = await sha256File(part)
      if (opts.sha256 && sha256 !== opts.sha256.toLowerCase()) {
        await fsp.rm(part, { force: true })
        throw new DownloadError('The download does not match the SHA-256 checksum the publisher states; it was deleted. Try again later.', attempt < 1)
      }
      await fsp.rm(dest, { force: true })
      await fsp.rename(part, dest)
      return { sha256, size }
    } catch (err) {
      lastErr = err
      if (opts.signal?.aborted) throw new DownloadError('Download cancelled.', false)
      const code = (err as NodeJS.ErrnoException).code ?? ((err as { cause?: NodeJS.ErrnoException }).cause?.code as string | undefined)
      const retryable = err instanceof DownloadError ? err.retryable : Boolean(code && RETRY_CODES.has(code)) || (err as Error).name === 'TypeError'
      if (!retryable || attempt === attempts - 1) break
      await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 1000) * (attempt + 1)))
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw lastErr instanceof DownloadError ? lastErr : new DownloadError(`Download failed: ${msg}`, false)
}
