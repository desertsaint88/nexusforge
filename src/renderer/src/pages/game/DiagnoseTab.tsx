// Diagnose: read-only checks of the game's mod setup with their evidence, the repairs NexusForge can make (each
// confirmed first, then checked again), what the game's integration supports, and an exportable report.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, CircleCheck, CircleX, Download, Info, RefreshCw, Stethoscope, TriangleAlert, Wrench } from 'lucide-react'
import type { DiagnosticFinding, DiagnosticFix, DiagnosticReport, Game, IntegrationCapabilities, ModRuntime } from '@shared/types'
import { invoke } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button } from '../../components/ui'
import { confirm, toast } from '../../store/ui'
import { useMods } from '../../store/mods'

const SEVERITY = {
  error: { icon: <CircleX className="size-4 text-rose-300" />, tone: 'danger', box: 'border-rose-400/20 bg-rose-500/[0.05]' },
  warning: { icon: <TriangleAlert className="size-4 text-amber-300" />, tone: 'warning', box: 'border-amber-400/20 bg-amber-500/[0.05]' },
  info: { icon: <Info className="size-4 text-sky-300" />, tone: 'info', box: 'border-white/[0.07] bg-black/20' }
} as const

const CAPS: Array<[keyof IntegrationCapabilities, string]> = [
  ['detect', 'Recognizes the game'],
  ['classify', 'Knows its mod formats'],
  ['loaders', 'Installs mod loaders'],
  ['configure', 'Configures loaders'],
  ['verifyFiles', 'Checks every deployed file'],
  ['verifyLoad', 'Checks the game will load them'],
  ['runtimeLog', 'Reads the loader log after a start'],
  ['saves', 'Places save games'],
  ['launch', 'Starts with / without mods'],
  ['diagnose', 'Game-specific checks'],
  ['uninstall', 'Removes cleanly']
]

export const RUNTIME_LABEL: Record<ModRuntime['state'], { label: string; tone: 'success' | 'danger' | 'neutral'; title: string }> = {
  loaded: { label: 'loaded in game', tone: 'success', title: "The mod loader's log of the last start says it loaded." },
  failed: { label: 'failed in game', tone: 'danger', title: "The mod loader's log of the last start reports an error for it." },
  unknown: { label: 'not confirmed', tone: 'neutral', title: 'No loader log names this mod (yet): it is in place, but NexusForge has no evidence that the game loaded it.' }
}

function FindingCard({ f, busy, onFix }: { f: DiagnosticFinding; busy: boolean; onFix(fix: DiagnosticFix): void }) {
  const [open, setOpen] = useState(f.severity === 'error')
  const s = SEVERITY[f.severity]
  return (
    <div className={cn('rounded-2xl border px-4 py-3', s.box)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{s.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-ink-100">{f.title}</span>
            <Badge tone={s.tone}>{f.severity}</Badge>
            <span className="font-mono text-[11px] text-ink-400" title={`${f.category} · confidence: ${f.confidence}`}>
              {f.code} · {f.confidence}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-200">{f.detail}</p>
          {f.userAction && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-100/90">
              <span className="font-semibold">Needs you: </span>
              {f.userAction}
            </p>
          )}
          {open && f.evidence.length > 0 && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-300">{f.evidence.join('\n')}</pre>
          )}
          {f.fixes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {f.fixes.map((x) => (
                <Button key={`${x.id}-${JSON.stringify(x.params ?? {})}`} size="sm" variant={x.consequential ? 'primary' : 'outline'} icon={<Wrench className="size-3.5" />} disabled={busy} title={x.description} onClick={() => onFix(x)}>
                  {x.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        {f.evidence.length > 0 && (
          <Button size="sm" variant="ghost" icon={<ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />} onClick={() => setOpen(!open)}>
            Evidence
          </Button>
        )}
      </div>
    </div>
  )
}

export function DiagnoseTab({ game }: { game: Game }) {
  const [report, setReport] = useState<DiagnosticReport>()
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState<string>()
  const refreshMods = useMods((s) => s.load)

  const run = useCallback(async () => {
    setRunning(true)
    try {
      setReport(await invoke('diagnostics:run', game.id))
    } catch (err) {
      toast.error('Diagnose failed', (err as Error).message)
    } finally {
      setRunning(false)
    }
  }, [game.id])

  useEffect(() => {
    void run()
  }, [run])

  const fix = async (x: DiagnosticFix) => {
    if (x.consequential && !(await confirm({ title: x.label, message: `${x.description}\n\nNexusForge checks everything again afterwards.`, confirmLabel: x.label }))) return
    setFixing(x.id)
    try {
      const next = await invoke('diagnostics:fix', game.id, x.id, x.params ?? {})
      setReport(next)
      toast.success(`${x.label}: done`, next.summary.errors ? `${next.summary.errors} error(s) left; see the findings.` : 'No errors left.')
      void refreshMods(game.id)
    } catch (err) {
      toast.error(`${x.label} failed`, (err as Error).message)
      void run()
    } finally {
      setFixing(undefined)
    }
  }

  const exportReport = async () => {
    try {
      const path = await invoke('diagnostics:export', game.id)
      if (path) toast.success('Report saved', path)
    } catch (err) {
      toast.error('Export failed', (err as Error).message)
    }
  }

  if (!report) {
    return (
      <div className="flex items-center gap-3 py-10 text-[13px] text-ink-300">
        <RefreshCw className="size-4 animate-spin" /> Checking {game.name}… (nothing is changed)
      </div>
    )
  }

  const { summary } = report
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5">
      <div className="glass flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <Stethoscope className="size-5 text-ink-200" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink-100">
            {summary.errors ? `${summary.errors} problem${summary.errors === 1 ? '' : 's'}` : summary.warnings ? 'No errors' : 'All good'}
            {summary.warnings ? ` · ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : ''}
            {summary.fixable ? ` · ${summary.fixable} NexusForge can repair` : ''}
          </div>
          <div className="text-[12px] text-ink-400">
            {report.integration.name} · checked {relativeTime(report.at)} in {report.durationMs} ms · read-only
          </div>
        </div>
        <Button size="sm" variant="outline" icon={<RefreshCw className={cn('size-3.5', running && 'animate-spin')} />} disabled={running || Boolean(fixing)} onClick={() => void run()}>
          Check again
        </Button>
        <Button size="sm" variant="outline" icon={<Download className="size-3.5" />} onClick={() => void exportReport()}>
          Export report
        </Button>
      </div>

      <div className="space-y-2.5">
        {report.findings.length === 0 && (
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.05] px-4 py-3 text-[13px] text-ink-100">
            <CircleCheck className="size-4 text-emerald-300" /> No problems found.
          </div>
        )}
        {report.findings.map((f, i) => (
          <FindingCard key={`${f.code}-${i}`} f={f} busy={Boolean(fixing) || running} onFix={(x) => void fix(x)} />
        ))}
      </div>

      {report.mods.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">Mods</div>
          <div className="glass divide-y divide-white/[0.05] rounded-2xl">
            {report.mods.map((m) => {
              const rt = RUNTIME_LABEL[m.runtime.state]
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[12.5px]">
                  <span className={cn('min-w-0 flex-1 truncate', m.enabled ? 'text-ink-100' : 'text-ink-400')}>
                    {m.name}
                    {m.version ? <span className="text-ink-400"> {m.version}</span> : null}
                  </span>
                  <Badge>{m.kind ?? 'files'}</Badge>
                  <Badge tone={m.state === 'verified' ? 'success' : m.state === 'deployed' ? 'info' : m.state === 'blocked' || m.state === 'failed' ? 'danger' : m.state === 'needs_loader' ? 'warning' : 'neutral'}>{m.state.replace(/_/g, ' ')}</Badge>
                  {(m.state === 'verified' || m.state === 'deployed') && (
                    <span title={[rt.title, ...m.runtime.evidence].join('\n')}>
                      <Badge tone={rt.tone}>{rt.label}</Badge>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">What NexusForge implements for this game</div>
        <div className="flex flex-wrap gap-1.5">
          {CAPS.map(([k, label]) => (
            <span key={k} className={cn('rounded-md border px-2 py-0.5 text-[11.5px]', report.integration.supports[k] ? 'border-emerald-400/20 text-emerald-200/90' : 'border-white/[0.07] text-ink-400 line-through')} title={report.integration.supports[k] ? 'Implemented' : 'Not supported for this game (reported, not faked)'}>
              {label}
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
