// The bug report itself: what goes into a GitHub issue and into the saved report folder. Pure functions (no
// Electron), so they are tested directly.
//
// Issues on a public repository are public. Everything here passes through redact() (user folder, user name,
// e-mail addresses, tokens); the user sees exactly this text before anything is sent.

import { promises as fsp } from 'node:fs'
import type { BugReportInput, DiagnosticReport, RecordedError } from '@shared/types'
import { redact, type RedactOptions } from '../diagnostics/report'

export interface ReportContext {
  appVersion: string
  /** 'installed', 'folder copy', 'portable', 'development'. */
  installKind: string
  versions: { electron: string; chrome: string; node: string }
  os: { release: string; version: string; arch: string; locale: string; memoryGb: number; freeMemoryGb: number }
  uptimeMinutes: number
  game?: { name: string; integration?: string; version?: string; distribution?: string; platform?: string }
  errors: RecordedError[]
  logTail: string[]
  diagnostics?: DiagnosticReport
  lastSessionCrash?: { startedAt: number; lastSeen: number; version: string; lastErrors: string[] }
  reportId: string
}

export interface BuiltReport {
  title: string
  /** Full Markdown (saved as report.md). */
  full: string
  /** Text for the issue form (fits GitHub's link). */
  body: string
  shortened: string[]
}

/** GitHub's new-issue link carries the text in the URL; longer links fail. */
export const MAX_ISSUE_URL = 7800

const fence = (s: string) => '```text\n' + s.replace(/```/g, "'''") + '\n```'
const time = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19)

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `### ${title}\n\n${body.trim()}\n` : ''
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>\n`
}

interface Limits {
  logLines: number
  errors: number
  findings: number
  detailChars: number
}

function render(input: BugReportInput, ctx: ReportContext, lim: Limits): string {
  const parts: string[] = []
  parts.push(section('What happened', input.description || '_No description._'))
  parts.push(section('Steps to reproduce', input.steps))
  parts.push(section('Expected', input.expected))
  if (input.error) {
    const detail = input.error.detail ? `\n\n${input.error.detail.slice(0, lim.detailChars)}` : ''
    parts.push(section('Error', fence(`${input.error.message}${detail}`)))
  }
  if (ctx.lastSessionCrash && input.origin === 'crash') {
    const c = ctx.lastSessionCrash
    const lines = [`NexusForge ${c.version} did not close properly: started ${time(c.startedAt)}, last seen ${time(c.lastSeen)} (UTC).`]
    if (c.lastErrors.length) lines.push('', fence(c.lastErrors.slice(-lim.errors).join('\n')))
    parts.push(section('Last session', lines.join('\n')))
  }
  const where: string[] = []
  if (input.page) where.push(`- Page: ${input.page}`)
  if (ctx.game) {
    const g = ctx.game
    where.push(`- Game: ${g.name}${g.integration ? ` (integration: ${g.integration})` : ''}${g.version ? `, version ${g.version}` : ''}${g.distribution ? `, ${g.distribution}` : ''}${g.platform ? `, ${g.platform}` : ''}`)
  }
  if (input.origin) where.push(`- Reported from: ${input.origin}`)
  parts.push(section('Where', where.join('\n')))

  if (input.include.system) {
    const o = ctx.os
    parts.push(
      section(
        'System',
        [
          `- NexusForge ${ctx.appVersion} (${ctx.installKind})`,
          `- Electron ${ctx.versions.electron}, Chromium ${ctx.versions.chrome}, Node ${ctx.versions.node}`,
          `- ${o.version} (${o.release}), ${o.arch}, locale ${o.locale}`,
          `- Memory: ${o.memoryGb} GB (${o.freeMemoryGb} GB free); running for ${ctx.uptimeMinutes} min`
        ].join('\n')
      )
    )
  }
  if (input.include.errors && ctx.errors.length && lim.errors > 0) {
    const list = ctx.errors.slice(-lim.errors).map((e) => `[${time(e.at)}] [${e.source}${e.scope ? `/${e.scope}` : ''}] ${e.message}`)
    parts.push(details(`Recent errors (${Math.min(lim.errors, ctx.errors.length)} of ${ctx.errors.length})`, fence(list.join('\n'))))
  }
  if (input.include.diagnostics && ctx.diagnostics && lim.findings > 0) {
    const d = ctx.diagnostics
    const lines = [`${d.gameName}: ${d.summary.errors} error(s), ${d.summary.warnings} warning(s), integration ${d.integration.name}`, '']
    for (const f of d.findings.slice(0, lim.findings)) lines.push(`- **${f.code}** ${f.severity} (${f.confidence}): ${f.title}`)
    if (d.findings.length > lim.findings) lines.push(`- … ${d.findings.length - lim.findings} more in the saved report`)
    parts.push(details('Diagnose', lines.join('\n')))
  }
  if (input.include.log && ctx.logTail.length && lim.logLines > 0) {
    parts.push(details(`Log (last ${Math.min(lim.logLines, ctx.logTail.length)} lines)`, fence(ctx.logTail.slice(-lim.logLines).join('\n'))))
  }
  parts.push(`---\n_Sent from NexusForge ${ctx.appVersion} · report ${ctx.reportId}_`)
  return parts.filter(Boolean).join('\n')
}

export function issueUrl(repoUrl: string, title: string, body: string): string {
  return `${repoUrl}/issues/new?${new URLSearchParams({ title, body, labels: 'bug' }).toString()}`
}

/** Builds the report: the full text, and the text for the issue link (shortened step by step until it fits). */
export function buildReport(input: BugReportInput, ctx: ReportContext, redactOpts: RedactOptions, repoUrl: string): BuiltReport {
  const title = redact((input.title || input.error?.message || 'Bug report').trim().slice(0, 140), redactOpts)
  const full = redact(render(input, ctx, { logLines: 400, errors: 60, findings: 200, detailChars: 20_000 }), redactOpts)
  const lim: Limits = { logLines: 60, errors: 15, findings: 25, detailChars: 3000 }
  const shortened = new Set<string>()
  const fits = (b: string) => issueUrl(repoUrl, title, b).length <= MAX_ISSUE_URL
  let body = redact(render(input, ctx, lim), redactOpts)
  const steps: Array<[keyof Limits, number, string]> = [
    ['logLines', 30, 'log'],
    ['logLines', 12, 'log'],
    ['findings', 10, 'diagnose'],
    ['errors', 6, 'recent errors'],
    ['detailChars', 1200, 'error details'],
    ['logLines', 0, 'log'],
    ['findings', 0, 'diagnose'],
    ['errors', 0, 'recent errors'],
    ['detailChars', 300, 'error details']
  ]
  for (const [key, value, label] of steps) {
    if (fits(body)) break
    lim[key] = value
    shortened.add(label)
    body = redact(render(input, ctx, lim), redactOpts)
  }
  // Still too long (a very long description): cut the text itself.
  while (!fits(body) && body.length > 200) {
    body = body.slice(0, Math.floor(body.length * 0.85)) + '\n\n… (shortened; the full report is saved on the reporter\'s PC)'
    shortened.add('description')
  }
  return { title, full, body, shortened: [...shortened] }
}

/** The last lines of a text file (the log), read from its end. */
export async function readTail(file: string, maxLines: number, maxBytes = 512 * 1024): Promise<string[]> {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.length)
    if (length < size) lines.shift() // first line is cut
    return lines.slice(-maxLines)
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}

/** Plain text from release notes or other HTML (no markup reaches the UI). */
export function plainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
