// The exportable diagnostic report (Markdown). Personal details are taken out: the user folder and user name become
// placeholders, e-mail addresses and anything that looks like a key or token are removed. NexusForge never puts API
// keys into a report in the first place; this is the second line of defence for paths and log lines.

import type { DiagnosticReport, IntegrationCapabilities } from '@shared/types'

export interface RedactOptions {
  home: string
  user: string
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function redact(text: string, o: RedactOptions): string {
  // E-mail addresses first: one containing the user name would otherwise keep its domain.
  let t = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-mail>')
  if (o.home) t = t.replace(new RegExp(esc(o.home), 'gi'), '%USERPROFILE%').replace(new RegExp(esc(o.home.replace(/\\/g, '/')), 'gi'), '%USERPROFILE%')
  if (o.user && o.user.length >= 3) t = t.replace(new RegExp(`(?<![A-Za-z0-9])${esc(o.user)}(?![A-Za-z0-9])`, 'gi'), '<user>')
  // Long opaque tokens (API keys, session ids): 32+ characters mixing upper case, lower case and digits. Lower-case
  // hex (checksums) and paths stay readable.
  t = t.replace(/(?<![A-Za-z0-9\\/._-])[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9\\/._-])/g, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? '<redacted>' : m))
  return t
}

const CAP_LABEL: Record<keyof IntegrationCapabilities, string> = {
  detect: 'Game detection',
  version: 'Version detection',
  classify: 'Mod classification for this game',
  loaders: 'Mod loader installs',
  configure: 'Loader configuration',
  verifyFiles: 'File verification',
  verifyLoad: 'Load verification (loader present and enabled)',
  runtimeLog: 'Runtime evidence (loader log after a start)',
  launch: 'Launch with / without mods',
  saves: 'Save-game placement',
  diagnose: 'Game-specific diagnostics',
  uninstall: 'Clean removal (replaced files restored)'
}

export function reportMarkdown(r: DiagnosticReport, o: RedactOptions, appVersion: string): string {
  const L: string[] = []
  const d = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-')
  L.push(`# NexusForge diagnostic report: ${r.gameName}`, '')
  L.push(`Created ${d(r.at)} UTC by NexusForge ${appVersion}. Checks took ${r.durationMs} ms. Nothing was changed by running them.`, '')
  L.push(`**Summary:** ${r.summary.errors} error(s), ${r.summary.warnings} warning(s), ${r.summary.infos} note(s); ${r.summary.fixable} can be repaired by NexusForge.`, '')
  L.push('## Installation', '')
  L.push(`- Integration: ${r.integration.name} (${r.integration.id}, support: ${r.integration.support})`)
  L.push(`- Distribution: ${r.installation.distribution}${r.installation.version ? ` · version ${r.installation.version}` : ''}`)
  L.push(`- Install folder: ${r.installation.installDir}`)
  L.push(`- Executable: ${r.installation.exePath ?? '-'}`)
  L.push(`- Deploy folder: ${r.installation.deployDir}`)
  L.push(`- Valid: ${r.installation.valid ? 'yes' : `no (${r.installation.problems.join('; ')})`}`)
  for (const t of r.targets) L.push(`- Target \`${t.id}\` (${t.label}): ${t.dir}${t.userData ? ' (user data: copied, never linked)' : ''}`)
  L.push('', '## What this integration implements', '')
  for (const [k, label] of Object.entries(CAP_LABEL)) L.push(`- ${r.integration.supports[k as keyof IntegrationCapabilities] ? '[x]' : '[ ] unsupported:'} ${label}`)
  L.push('', '## Mod loaders', '')
  if (!r.loaders.length) L.push('- none for this game')
  for (const l of r.loaders) L.push(`- ${l.name}: ${l.state}${l.version ? ` ${l.version}` : ''}${l.latest ? ` (newest ${l.latest})` : ''}${l.required ? ', needed by a mod' : ''}${l.blocked ? ` · blocked: ${l.blocked}` : ''}`)
  L.push('', '## Deployment', '')
  L.push(`- Deployed: ${r.deployment.deployed ? `yes, ${r.deployment.fileCount} file(s), ${d(r.deployment.deployedAt)} UTC` : 'no'}; in sync with the enabled mods: ${r.deployment.inSync ? 'yes' : 'no'}${r.deployment.interrupted ? '; an interrupted deployment is pending recovery' : ''}`)
  if (r.deployment.last) L.push(`- Last run: ${r.deployment.last.outcome}, ${r.deployment.last.title} (${d(r.deployment.last.at)} UTC)`)
  L.push('', '## Last start (loader log)', '')
  if (!r.lastLaunch?.ran) L.push('- No loader log found (the game was not started with mods yet, or this game has no loader log).')
  else {
    L.push(`- ${r.lastLaunch.loader ?? 'loader'} log: ${r.lastLaunch.logFile ?? '-'} (${d(r.lastLaunch.at)} UTC)`)
    for (const f of r.lastLaunch.files ?? []) L.push(`  - ${f.file}: ${f.ok ? 'loaded' : 'FAILED'}${f.needs ? ` (needs ${f.needs.loaderId} ${f.needs.version})` : ''}`)
  }
  L.push('', '## Mods', '', '| Mod | Version | Kind | Enabled | State | Runtime | Needs |', '|---|---|---|---|---|---|---|')
  for (const m of r.mods) L.push(`| ${m.name.replace(/\|/g, '/')} | ${m.version ?? ''} | ${m.kind ?? 'files'} | ${m.enabled ? 'yes' : 'no'} | ${m.state} | ${m.runtime.state} | ${m.needs.join(', ')} |`)
  L.push('', '## Findings', '')
  if (!r.findings.length) L.push('No problems found.')
  for (const f of r.findings) {
    L.push(`### [${f.severity.toUpperCase()}] ${f.code}: ${f.title}`, '')
    L.push(`${f.detail}`, '')
    L.push(`- Category: ${f.category} · confidence: ${f.confidence}`)
    if (f.userAction) L.push(`- What you can do: ${f.userAction}`)
    for (const x of f.fixes) L.push(`- NexusForge can: ${x.label}. ${x.description}`)
    if (f.evidence.length) {
      L.push('- Evidence:', '', '```')
      for (const e of f.evidence) L.push(e)
      L.push('```')
    }
    L.push('')
  }
  return redact(L.join('\n'), o)
}
