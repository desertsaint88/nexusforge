import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadVerified, DownloadError } from '../src/main/util/download'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-dl-'))
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

const data = Buffer.from('x'.repeat(10_000) + 'END')
const sha = createHash('sha256').update(data).digest('hex')

/** A server that drops the connection after `cut` bytes on the first request and honours Range afterwards. */
function flakyServer(cut: number) {
  const calls: Array<string | undefined> = []
  const impl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range
    calls.push(range)
    const start = range ? Number(range.match(/bytes=(\d+)-/)![1]) : 0
    const body = data.subarray(start)
    const first = calls.length === 1
    // The first response delivers `cut` bytes, then the connection drops on the next read (erroring in start()
    // would discard the queued bytes before anyone read them).
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!first) {
          c.enqueue(new Uint8Array(body))
          c.close()
        } else if (!sent) {
          sent = true
          c.enqueue(new Uint8Array(body.subarray(0, cut)))
        } else {
          c.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
        }
      }
    })
    return new Response(stream, { status: range ? 206 : 200, headers: { 'content-length': String(body.length) } })
  }) as typeof fetch
  return { impl, calls }
}

describe('verified downloads', () => {
  it('resumes a dropped connection with a Range request and checks the SHA-256', async () => {
    const s = flakyServer(4000)
    const dest = join(root, 'file.zip')
    const r = await downloadVerified('https://github.com/x/file.zip', dest, { sha256: sha, size: data.length, fetchImpl: s.impl, backoffMs: 1, allowedHosts: ['github.com'] })
    expect(r.sha256).toBe(sha)
    expect(s.calls).toEqual([undefined, 'bytes=4000-'])
    expect((await fsp.readFile(dest)).equals(data)).toBe(true)
  })

  it('deletes a file that does not match the published checksum', async () => {
    const dest = join(root, 'bad.zip')
    const impl = (async () => new Response(new Uint8Array(Buffer.from('tampered')), { status: 200 })) as typeof fetch
    await expect(downloadVerified('https://github.com/x/bad.zip', dest, { sha256: sha, fetchImpl: impl, backoffMs: 1, attempts: 2 })).rejects.toThrow(/SHA-256/)
    await expect(fsp.access(dest)).rejects.toThrow()
    await expect(fsp.access(`${dest}.part`)).rejects.toThrow()
  })

  it('refuses plain HTTP and hosts that are not allowed (also after redirects)', async () => {
    await expect(downloadVerified('http://github.com/x', join(root, 'a'))).rejects.toBeInstanceOf(DownloadError)
    await expect(downloadVerified('https://evil.example/x', join(root, 'a'), { allowedHosts: ['github.com'] })).rejects.toThrow(/Refusing/)
    const impl = (async () => {
      const r = new Response(new Uint8Array(data), { status: 200 })
      Object.defineProperty(r, 'url', { value: 'https://evil.example/x' })
      return r
    }) as typeof fetch
    await expect(downloadVerified('https://github.com/x', join(root, 'a'), { allowedHosts: ['github.com'], fetchImpl: impl })).rejects.toThrow(/redirected/)
  })

  it('gives up with a clear message on a 404', async () => {
    const impl = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch
    await expect(downloadVerified('https://github.com/x', join(root, 'a'), { fetchImpl: impl, backoffMs: 1 })).rejects.toThrow(/404/)
  })
})
