// Bug reports and updates: the parts that decide what leaves the PC (redaction, the issue link and its length),
// crash detection between sessions, and the version / release-file logic the updater relies on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { BugReportInput } from '../src/shared/types'
import { buildReport, issueUrl, MAX_ISSUE_URL, plainText, readTail, type ReportContext } from '../src/main/bugreport/report'
import { compareVersions, parseLatestYml } from '../src/main/updater/versions'

vi.mock('electron', () => ({ app: { getVersion: () => '1.7.0', getPath: () => os.tmpdir(), on: () => {} } }))

const REPO = 'https://github.com/desertsaint88/nexusforge'
const redactOpts = { home: 'C:\\Users\\alex', user: 'alex' }

function ctx(over: Partial<ReportContext> = {}): ReportContext {
  return {
    appVersion: '1.7.0',
    installKind: 'installed',
    versions: { electron: '45.0.0', chrome: '140', node: '24' },
    os: { release: '10.0.26300', version: 'Windows 11 Pro', arch: 'x64', locale: 'de', memoryGb: 32, freeMemoryGb: 12 },
    uptimeMinutes: 5,
    errors: [],
    logTail: [],
    reportId: 'test',
    ...over
  }
}

function input(over: Partial<BugReportInput> = {}): BugReportInput {
  return { title: 'Deploy fails', description: 'It fails.', include: { system: true, errors: true, log: true, diagnostics: true, screenshot: false }, ...over }
}

describe('the bug report text', () => {
  it('takes the user folder, user name, e-mail addresses and keys out of everything it sends', () => {
    const r = buildReport(
      input({ title: 'Crash in C:\\Users\\alex\\Games', description: 'alex here, mail me at alex@example.com', error: { message: 'ENOENT C:\\Users\\alex\\AppData\\Roaming\\NexusForge\\x', detail: 'key=Ab3dEf9hIjKlMn0pQrStUvWxYz123456789ABCD' } }),
      ctx({ logTail: ['[2026-10-28 20:00:00.000] [error] failed C:\\Users\\alex\\AppData\\Local\\Temp\\y'], errors: [{ at: 1, source: 'main', message: 'open C:\\Users\\alex\\file failed' }] }),
      redactOpts,
      REPO
    )
    for (const text of [r.title, r.body, r.full]) {
      expect(text).not.toMatch(/alex/i)
      expect(text).not.toContain('Ab3dEf9hIjKlMn0pQrStUvWxYz123456789ABCD')
    }
    expect(r.full).toContain('%USERPROFILE%\\AppData\\Roaming\\NexusForge\\x')
    expect(r.full).toContain('<e-mail>')
  })

  it('keeps the issue link short enough for GitHub, shortening the log first and saying what it shortened', () => {
    const logTail = Array.from({ length: 400 }, (_, i) => `[2026-10-28 20:00:${String(i % 60).padStart(2, '0')}.000] [info] (deploy) line ${i} ${'x'.repeat(80)}`)
    const errors = Array.from({ length: 40 }, (_, i) => ({ at: i, source: 'main' as const, scope: 'deploy', message: `error ${i} ${'y'.repeat(60)}` }))
    const r = buildReport(input(), ctx({ logTail, errors }), redactOpts, REPO)
    expect(issueUrl(REPO, r.title, r.body).length).toBeLessThanOrEqual(MAX_ISSUE_URL)
    expect(r.shortened).toContain('log')
    // The saved report keeps everything.
    expect(r.full).toContain('line 399')
    expect(r.full).toContain('error 39')
    expect(r.body).toContain('### What happened')
  })

  it('fits even a very long description, and says the full text is saved', () => {
    const r = buildReport(input({ description: 'z'.repeat(20_000) }), ctx(), redactOpts, REPO)
    expect(issueUrl(REPO, r.title, r.body).length).toBeLessThanOrEqual(MAX_ISSUE_URL)
    expect(r.shortened).toContain('description')
    expect(r.full.length).toBeGreaterThan(20_000)
  })

  it('leaves out what the user switched off', () => {
    const r = buildReport(input({ include: { system: false, errors: false, log: false, diagnostics: false, screenshot: false } }), ctx({ logTail: ['secret log line'], errors: [{ at: 1, source: 'main', message: 'some error' }] }), redactOpts, REPO)
    expect(r.full).not.toContain('secret log line')
    expect(r.full).not.toContain('some error')
    expect(r.full).not.toContain('### System')
  })

  it('opens GitHub\'s new-issue form of the NexusForge repository with title, text and the bug label', () => {
    const url = new URL(issueUrl(REPO, 'A & B', 'line 1\nline 2'))
    expect(url.origin + url.pathname).toBe(`${REPO}/issues/new`)
    expect(url.searchParams.get('title')).toBe('A & B')
    expect(url.searchParams.get('body')).toBe('line 1\nline 2')
    expect(url.searchParams.get('labels')).toBe('bug')
  })

  it('reads the end of a log file, also when it is larger than the read window', async () => {
    const dir = await fsp.mkdtemp(join(os.tmpdir(), 'nf-tail-'))
    const file = join(dir, 'main.log')
    await fsp.writeFile(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const tail = await readTail(file, 3, 1024)
    expect(tail).toEqual(['line 4997', 'line 4998', 'line 4999'])
    expect(await readTail(join(dir, 'missing.log'), 3)).toEqual([])
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('turns release notes into plain text (no markup reaches the window)', () => {
    expect(plainText('<h2>New</h2><ul><li>Bug reports</li><li>Updates &amp; more</li></ul><script>x</script>')).toBe('New\n• Bug reports\n• Updates & more\nx')
  })
})

describe('crash detection between sessions', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(os.tmpdir(), 'nf-session-'))
    vi.resetModules()
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('a session that ended cleanly is no crash; one that did not is, with its last errors', async () => {
    const s = await import('../src/main/bugreport/session')
    expect(s.previousCrash(undefined, [])).toBeUndefined()
    expect(s.previousCrash({ startedAt: 1, lastSeen: 2, version: '1.6.0', pid: 1, clean: true }, [])).toBeUndefined()
    const c = s.previousCrash({ startedAt: 1, lastSeen: 2, version: '1.6.0', pid: 1, clean: false }, ['[x] [info] fine', '[x] [error] boom'])
    expect(c).toEqual({ startedAt: 1, lastSeen: 2, version: '1.6.0', lastErrors: ['[x] [error] boom'] })
  })

  it('writes the marker at start and marks it clean at the end; the next start sees no crash', async () => {
    const s = await import('../src/main/bugreport/session')
    s.startSession([], dir)
    const during = JSON.parse(await fsp.readFile(join(dir, 'session.json'), 'utf8'))
    expect(during.clean).toBe(false)
    s.endSession()
    expect(JSON.parse(await fsp.readFile(join(dir, 'session.json'), 'utf8')).clean).toBe(true)
    vi.resetModules()
    const next = await import('../src/main/bugreport/session')
    next.startSession([], dir)
    expect(next.lastSessionCrash()).toBeUndefined()
    next.endSession()
  })

  it('a marker left unclean (killed, crashed, power loss) is reported at the next start', async () => {
    await fsp.writeFile(join(dir, 'session.json'), JSON.stringify({ startedAt: 10, lastSeen: 20, version: '1.6.0', pid: 4, clean: false }))
    const s = await import('../src/main/bugreport/session')
    s.startSession(['[t] [error] Unhandled: x'], dir)
    expect(s.lastSessionCrash()).toMatchObject({ version: '1.6.0', lastSeen: 20, lastErrors: ['[t] [error] Unhandled: x'] })
    s.dismissLastSessionCrash()
    expect(s.lastSessionCrash()).toBeUndefined()
    s.endSession()
  })
})

describe('updater helpers', () => {
  it('compares versions like releases are numbered', () => {
    expect(compareVersions('1.7.0', '1.6.0')).toBe(1)
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.7.0', 'v1.7.0')).toBe(0)
    expect(compareVersions('1.7.0-beta.1', '1.7.0')).toBe(-1)
    expect(compareVersions('1.6.9', '1.7.0')).toBe(-1)
    expect(compareVersions('2.0', '1.99.99')).toBe(1)
  })

  it("reads the installer, its SHA-512 and size from a release's latest.yml", () => {
    const yml = [
      'version: 1.7.0',
      'files:',
      '  - url: NexusForge-Setup-1.7.0.exe',
      '    sha512: q1w2e3r4t5y6u7i8o9p0+/==',
      '    size: 123456789',
      'path: NexusForge-Setup-1.7.0.exe',
      'sha512: q1w2e3r4t5y6u7i8o9p0+/==',
      "releaseDate: '2026-10-28T20:00:00.000Z'"
    ].join('\n')
    expect(parseLatestYml(yml)).toEqual({ version: '1.7.0', file: 'NexusForge-Setup-1.7.0.exe', sha512: 'q1w2e3r4t5y6u7i8o9p0+/==', size: 123456789 })
  })
})
