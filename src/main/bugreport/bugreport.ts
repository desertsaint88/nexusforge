// Bug reports: collect what is known (system, recent errors, log, the game's Diagnose report, a screenshot), save it
// as a folder, and open GitHub's new-issue form with the text filled in: inside NexusForge (site panel, signed in
// once) or in the user's browser. Nothing is sent without the user pressing GitHub's own Create button.

import { app, BrowserWindow, session, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { isAbsolute, join, resolve, relative } from 'node:path'
import type { BugReportInput, BugReportPreview, BugReportResult, BugReportState } from '@shared/types'
import { APP_REPO_URL } from '@shared/app-repo'
import { scoped, logFilePath } from '../logger'
import { emit } from '../events'
import { paths } from '../paths'
import { getGame } from '../library/library'
import { addPanelEntry, isPanelEntry, removePanelEntry, setPanelHint, showPanelEntry } from '../web/panel'
import { siteView } from '../web/browser'
import { reportMarkdown } from '../diagnostics/report'
import { recentErrors, onErrorsChanged, recordError } from './errors'
import { dismissLastSessionCrash, lastSessionCrash } from './session'
import { buildReport, issueUrl, readTail, type ReportContext } from './report'
import { installKind } from '../updater/updater'

const log = scoped('bugreport')
export const GITHUB_PARTITION = 'persist:github'
const PANEL_ID = 'bugreport:github'

const redactOpts = () => ({ home: os.homedir(), user: os.userInfo().username })

export function reportsDir(): string {
  return join(paths.userData(), 'bug-reports')
}

async function githubUser(): Promise<{ signedIn: boolean; user?: string }> {
  try {
    const cookies = await session.fromPartition(GITHUB_PARTITION).cookies.get({ url: 'https://github.com' })
    const signedIn = cookies.some((c) => c.name === 'logged_in' && c.value === 'yes')
    const user = cookies.find((c) => c.name === 'dotcom_user')?.value
    return { signedIn, user: signedIn ? user : undefined }
  } catch {
    return { signedIn: false }
  }
}

export async function bugReportState(): Promise<BugReportState> {
  const gh = await githubUser()
  return { recentErrors: recentErrors(), lastSessionCrash: lastSessionCrash(), githubSignedIn: gh.signedIn, githubUser: gh.user, reportsDir: reportsDir(), repoUrl: APP_REPO_URL }
}

let publishTimer: NodeJS.Timeout | undefined
function publishSoon(): void {
  if (publishTimer) return
  publishTimer = setTimeout(() => {
    publishTimer = undefined
    void bugReportState().then((s) => emit('bugreport:changed', s))
  }, 400)
}

export function initBugReports(): void {
  onErrorsChanged(publishSoon)
}

// --- Screenshot ----------------------------------------------------------------------------------------------------

let shot: { at: number; png: Buffer } | undefined

/** Takes a picture of the window before the report dialog covers it. */
export async function captureWindow(win?: BrowserWindow | null): Promise<boolean> {
  const w = win ?? BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
  if (!w) return false
  try {
    const img = await w.webContents.capturePage()
    shot = { at: Date.now(), png: img.toPNG() }
    return true
  } catch (err) {
    log.warn('screenshot failed', err)
    return false
  }
}

// --- Report ------------------------------------------------------------------------------------------------------

function cleanInput(input: BugReportInput): BugReportInput {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const inc = (input?.include ?? {}) as Partial<BugReportInput['include']>
  return {
    title: s(input?.title, 200) ?? '',
    description: s(input?.description, 20_000) ?? '',
    steps: s(input?.steps, 10_000),
    expected: s(input?.expected, 5000),
    origin: s(input?.origin, 40),
    gameId: s(input?.gameId, 300),
    page: s(input?.page, 300),
    error: input?.error && typeof input.error.message === 'string' ? { message: input.error.message.slice(0, 4000), detail: s(input.error.detail, 20_000) } : undefined,
    include: { system: inc.system !== false, errors: inc.errors !== false, log: inc.log !== false, diagnostics: inc.diagnostics !== false, screenshot: inc.screenshot !== false }
  }
}

async function context(input: BugReportInput, reportId: string): Promise<ReportContext> {
  const game = input.gameId ? getGame(input.gameId) : undefined
  let diagnostics: ReportContext['diagnostics']
  if (game && input.include.diagnostics) {
    try {
      const { runDiagnostics } = await import('../diagnostics/diagnostics')
      diagnostics = await runDiagnostics(game.id)
    } catch (err) {
      log.warn(`diagnostics for the report failed: ${(err as Error).message}`)
    }
  }
  const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10
  return {
    appVersion: app.getVersion(),
    installKind: installKind(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    os: { release: os.release(), version: os.version(), arch: os.arch(), locale: app.getLocale(), memoryGb: gb(os.totalmem()), freeMemoryGb: gb(os.freemem()) },
    uptimeMinutes: Math.round(process.uptime() / 60),
    game: game
      ? { name: game.name, integration: diagnostics?.integration.name, version: diagnostics?.installation.version ?? game.version, distribution: diagnostics?.installation.distribution, platform: game.platform }
      : undefined,
    errors: input.include.errors ? recentErrors() : [],
    logTail: input.include.log ? await readTail(logFilePath(), 400) : [],
    diagnostics,
    lastSessionCrash: lastSessionCrash(),
    reportId
  }
}

const newId = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

export async function previewReport(raw: BugReportInput): Promise<BugReportPreview> {
  const input = cleanInput(raw)
  const built = buildReport(input, await context(input, 'preview'), redactOpts(), APP_REPO_URL)
  return { title: built.title, body: built.body, shortened: built.shortened }
}

/** Saves the report folder and opens the issue form where the user chose. */
export async function submitReport(raw: BugReportInput, target: 'panel' | 'browser' | 'save'): Promise<BugReportResult> {
  const input = cleanInput(raw)
  const id = newId()
  const ctx = await context(input, id)
  const built = buildReport(input, ctx, redactOpts(), APP_REPO_URL)
  const dir = join(reportsDir(), id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'report.md'), `# ${built.title}\n\n${built.full}\n`, 'utf8')
  if (input.include.log) {
    const { redact } = await import('../diagnostics/report')
    await fsp.writeFile(join(dir, 'log.txt'), redact((await readTail(logFilePath(), 3000, 4 * 1024 * 1024)).join('\n'), redactOpts()), 'utf8')
  }
  if (ctx.diagnostics) await fsp.writeFile(join(dir, 'diagnostics.md'), reportMarkdown(ctx.diagnostics, redactOpts(), app.getVersion()), 'utf8')
  if (input.include.screenshot && shot && Date.now() - shot.at < 30 * 60_000) await fsp.writeFile(join(dir, 'screenshot.png'), shot.png)
  log.info(`bug report ${id} saved (${target})${built.shortened.length ? `, issue text shortened: ${built.shortened.join(', ')}` : ''}`)

  const url = issueUrl(APP_REPO_URL, built.title, built.body)
  if (target === 'browser') {
    await shell.openExternal(url)
    return { dir, opened: 'browser' }
  }
  if (target === 'panel') {
    openIssuePanel(url, dir)
    return { dir, opened: 'panel' }
  }
  return { dir, opened: 'none' }
}

const ISSUE_CREATED = new RegExp(`^${APP_REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/(\\d+)(?:[?#].*)?$`, 'i')

function openIssuePanel(url: string, dir: string): void {
  if (isPanelEntry(PANEL_ID)) removePanelEntry(PANEL_ID)
  const view = siteView(GITHUB_PARTITION, PANEL_ID)
  const wc = view.webContents
  const hintFor = (u: string) =>
    /github\.com\/(login|session|sessions\/two-factor)/i.test(u)
      ? 'Sign in to GitHub (once: NexusForge remembers it). Then the report opens, filled in.'
      : 'Check the text, then press "Create" at the bottom. To add the screenshot or the full log, drag them from the report folder (Settings › About › Open bug reports) into the text box.'
  let done = false
  const onNav = (_e: unknown, u: string) => {
    setPanelHint(PANEL_ID, hintFor(u))
    const m = u.match(ISSUE_CREATED)
    if (m && !done) {
      done = true
      log.info(`bug report filed as issue #${m[1]}`)
      void fsp.writeFile(join(dir, 'issue.txt'), `${u}\n`, 'utf8').catch(() => {})
      emit('toast', { kind: 'success', title: `Bug report #${m[1]} sent`, message: 'Thanks! You can follow it on GitHub.' })
      setTimeout(() => removePanelEntry(PANEL_ID), 2500)
      publishSoon()
    }
  }
  wc.on('did-navigate', onNav)
  wc.on('did-navigate-in-page', onNav)
  addPanelEntry({ id: PANEL_ID, title: 'Report a bug on GitHub', hint: hintFor(url), view, show: true })
  void wc.loadURL(url)
}

/** Opens github.com's sign-in in the panel; closes it once signed in. */
export function githubSignIn(): void {
  const id = 'bugreport:github-signin'
  if (isPanelEntry(id)) {
    showPanelEntry(id)
    return
  }
  const view = siteView(GITHUB_PARTITION, id)
  const wc = view.webContents
  const check = async () => {
    const gh = await githubUser()
    if (gh.signedIn && isPanelEntry(id)) {
      emit('toast', { kind: 'success', title: 'Signed in to GitHub', message: gh.user ? `As ${gh.user}. Bug reports open ready to send.` : undefined })
      removePanelEntry(id)
      publishSoon()
    }
  }
  wc.on('did-navigate', () => void check())
  wc.on('did-navigate-in-page', () => void check())
  addPanelEntry({ id, title: 'Sign in to GitHub', hint: 'Sign in once; NexusForge keeps the GitHub session for bug reports (like a browser does).', view, show: true })
  void wc.loadURL('https://github.com/login')
}

export function rendererError(e: { message: string; detail?: string; page?: string }): void {
  if (!e || typeof e.message !== 'string') return
  const message = e.message.slice(0, 2000)
  // Logged as a warning so the logger hook doesn't record it a second time as a main-process error.
  log.warn(`renderer error: ${message}${e.page ? ` (page ${String(e.page).slice(0, 200)})` : ''}`)
  recordError({ source: 'renderer', scope: typeof e.page === 'string' ? e.page.slice(0, 80) : undefined, message, detail: e.detail ? String(e.detail).slice(0, 6000) : undefined })
}

export async function openReportsFolder(dir?: string): Promise<void> {
  const base = reportsDir()
  await fsp.mkdir(base, { recursive: true })
  const target = dir ? resolve(dir) : base
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Not a bug report folder')
  const err = await shell.openPath(target)
  if (err) throw new Error(err)
}

export function dismissCrash(): void {
  dismissLastSessionCrash()
  publishSoon()
}
