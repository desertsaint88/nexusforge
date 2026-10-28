// What the last deployment did: verified, rolled back or failed, why, what to do about it, and every check.
// Success is only shown when the checks after placing the files passed.

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Bug, ChevronDown, CircleCheck, CircleX, FileText, Info, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { reportBug } from '../../store/bugreport'
import type { DeployOutcomeSummary, DeployReport, VerifyCheck } from '@shared/types'
import { invoke } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button, IconButton } from '../../components/ui'
import { STAGE_LABEL } from '../../store/mods'

const OUTCOME = {
  verified: { label: 'Verified', tone: 'success', box: 'border-emerald-400/15 bg-emerald-500/[0.05]', icon: <CircleCheck className="size-4.5 text-emerald-300" /> },
  deployed: { label: 'Deployed', tone: 'info', box: 'border-sky-400/15 bg-sky-500/[0.04]', icon: <CircleCheck className="size-4.5 text-sky-300" /> },
  nothing: { label: 'Nothing to do', tone: 'neutral', box: 'border-white/[0.06] bg-black/20', icon: <Info className="size-4.5 text-ink-300" /> },
  rolled_back: { label: 'Rolled back', tone: 'warning', box: 'border-amber-400/20 bg-amber-500/[0.06]', icon: <RotateCcw className="size-4.5 text-amber-300" /> },
  failed: { label: 'Failed', tone: 'danger', box: 'border-rose-400/20 bg-rose-500/[0.06]', icon: <CircleX className="size-4.5 text-rose-300" /> }
} as const

function CheckLine({ c }: { c: VerifyCheck }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px] leading-relaxed">
      {c.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-300" /> : c.level === 'error' ? <CircleX className="mt-0.5 size-3.5 shrink-0 text-rose-300" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />}
      <span className={cn(c.ok ? 'text-ink-300' : 'text-ink-100')}>
        {c.label}
        {c.detail && <span className="text-ink-400"> · {c.detail}</span>}
      </span>
    </div>
  )
}

/** The report of a deployment run in this session, or the stored summary of the last one. */
export function DeployResult({ report, last, onDismiss }: { report?: DeployReport; last?: DeployOutcomeSummary; onDismiss?(): void }) {
  const [details, setDetails] = useState(false)
  const outcome = report?.outcome ?? last?.outcome
  if (!outcome) return null
  // A stored success needs no card; failures stay visible until the next deployment.
  if (!report && (outcome === 'verified' || outcome === 'deployed' || outcome === 'nothing')) return null
  // Files in place but no rules for how the game loads them: "Deployed", not "Verified".
  const o = OUTCOME[outcome]
  const success = outcome === 'verified' || outcome === 'deployed'
  const problem = report?.problem ?? last?.problem
  const checks = report?.verification?.checks ?? []
  const failedChecks = checks.filter((c) => !c.ok)
  const skippedMods = (report?.notes ?? []).filter((n) => n.includes('was not deployed'))
  const otherNotes = (report?.notes ?? []).filter((n) => !n.includes('was not deployed'))
  const live = report ? report.methods.symlink + report.methods.hardlink + report.methods.copy : 0

  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className={cn('mb-4 rounded-2xl border px-4 py-3', o.box)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{o.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={o.tone}>{o.label}</Badge>
            <span className="text-[13.5px] font-semibold text-ink-100">{report?.title ?? last?.title}</span>
            {!report && last && <span className="text-[11.5px] text-ink-400">{relativeTime(last.at)}</span>}
          </div>

          {problem && (
            <div className="mt-2 text-[12.5px] leading-relaxed">
              <p className="text-ink-100">{problem.detail}</p>
              {problem.advice.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-300">
                  {problem.advice.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
              {problem.paths && problem.paths.length > 0 && <p className="mt-1 truncate font-mono text-[11px] text-ink-400" title={problem.paths.join('\n')}>{problem.paths.slice(0, 3).join(' · ')}</p>}
            </div>
          )}

          {report && success && (
            <p className="mt-1 text-[12.5px] text-ink-300">
              {live.toLocaleString()} file{live === 1 ? '' : 's'} live
              {report.placed ? ` · ${report.placed} placed` : ''}
              {report.removed ? ` · ${report.removed} removed` : ''}
              {report.unchanged ? ` · ${report.unchanged} unchanged` : ''}
              {report.methods.hardlink ? ` · ${report.methods.hardlink} hardlinked` : ''}
              {report.methods.copy ? ` · ${report.methods.copy} copied` : ''}
              {report.methods.symlink ? ` · ${report.methods.symlink} symlinked` : ''}
              {report.verification ? ` · ${report.verification.checked.toLocaleString()} checked` : ''}
              {report.verification && !report.verification.loadVerified && live > 0 ? '. The files are in place, but NexusForge cannot tell from them whether the game loads them; start the game, then run Diagnose to read what its mod loader logged.' : '. Whether each mod really runs shows after the next start (from the mod loader\'s log, where the game has one).'}
            </p>
          )}

          {skippedMods.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12.5px] leading-relaxed text-amber-200/90">
              {skippedMods.map((n) => (
                <li key={n} className="flex gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {n}
                </li>
              ))}
            </ul>
          )}

          {failedChecks.length > 0 && (
            <div className="mt-2 space-y-1">
              {failedChecks.map((c) => (
                <CheckLine key={c.label} c={c} />
              ))}
            </div>
          )}

          {report && (report.rescued > 0 || report.kept > 0 || report.backedUp > 0) && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
              {report.backedUp ? `${report.backedUp} original game file(s) were backed up and come back on purge. ` : ''}
              {report.rescued ? `${report.rescued} file(s) changed after the last deployment were moved to the overwrite folder instead of being deleted. ` : ''}
              {report.kept ? `${report.kept} world/save file(s) you played were left where they are.` : ''}
            </p>
          )}

          {report && details && (
            <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
              {checks.filter((c) => c.ok).length > 0 && (
                <div className="space-y-1">
                  {checks
                    .filter((c) => c.ok)
                    .map((c) => (
                      <CheckLine key={c.label} c={c} />
                    ))}
                </div>
              )}
              {otherNotes.map((n) => (
                <p key={n} className="text-[12px] leading-relaxed text-ink-400">
                  {n}
                </p>
              ))}
              {report.errors.filter((e) => e !== problem?.detail).map((e) => (
                <p key={e} className="text-[12px] leading-relaxed text-rose-200/80">
                  {e}
                </p>
              ))}
              <div className="flex flex-wrap gap-1.5">
                {report.stages.map((s, i) => (
                  <span key={`${s.stage}-${i}`} className={cn('rounded-md border px-1.5 py-0.5 text-[11px]', s.ok ? 'border-white/[0.07] text-ink-400' : 'border-rose-400/30 text-rose-200')} title={STAGE_LABEL[s.stage]}>
                    {s.stage} {s.ms} ms
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {report && (checks.length > 0 || otherNotes.length > 0 || report.stages.length > 0) && (
            <Button size="sm" variant="ghost" icon={<ChevronDown className={cn('size-3.5 transition-transform', details && 'rotate-180')} />} onClick={() => setDetails(!details)}>
              Details
            </Button>
          )}
          {!success && outcome !== 'nothing' && (
            <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => void invoke('app:openLogs')}>
              Log
            </Button>
          )}
          {!success && outcome !== 'nothing' && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Bug className="size-3.5" />}
              onClick={() =>
                reportBug({
                  title: `Deployment ${o.label.toLowerCase()}: ${problem?.title ?? report?.title ?? last?.title ?? ''}`.slice(0, 140),
                  origin: 'deploy',
                  error: { message: problem?.detail ?? report?.title ?? last?.title ?? 'Deployment failed', detail: [...(problem?.advice ?? []), ...(problem?.paths ?? []).slice(0, 5), ...(report?.errors ?? [])].join('\n') || undefined }
                })
              }
            >
              Report
            </Button>
          )}
          {onDismiss && report && (
            <IconButton label="Dismiss" onClick={onDismiss}>
              <X className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
    </motion.div>
  )
}
