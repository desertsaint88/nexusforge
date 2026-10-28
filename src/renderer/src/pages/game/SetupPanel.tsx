// The game's mod setup at a glance: which integration handles it, where the copy came from, its mod loaders
// (install / update / remove through the official channel), where mods go, the running setup operation, what
// the loader logged at the last start, and shortcuts for the modded start.

import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Ban,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  Download,
  FileText,
  FolderOpen,
  Info,
  LoaderCircle,
  Monitor,
  RefreshCw,
  SkipForward,
  SquareMenu,
  Trash,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import type { Game, IntegrationInfo, LaunchCheck, LoaderStatus, SetupProgress, SetupStep, ShortcutInfo } from '@shared/types'
import { useMods } from '../../store/mods'
import { confirm } from '../../store/ui'
import { invoke } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button, Card, IconButton, ProgressBar } from '../../components/ui'

const SUPPORT: Record<IntegrationInfo['support'], { label: string; tone: 'success' | 'info' | 'neutral'; hint: string }> = {
  full: { label: 'Full support', tone: 'success', hint: 'NexusForge installs the mod loader, puts every file where the game loads it and checks the result.' },
  partial: { label: 'Partial support', tone: 'info', hint: 'NexusForge knows where mods go and checks them; some steps (see below) are up to you.' },
  basic: { label: 'Basic', tone: 'neutral', hint: 'NexusForge copies mod files into the deploy folder and removes them cleanly, but cannot tell whether the game loads them.' }
}

function loaderBadge(l: LoaderStatus): ReactNode {
  switch (l.state) {
    case 'installed':
      return <Badge tone="success">{l.version ? `v${l.version}` : 'installed'}</Badge>
    case 'outdated':
      return <Badge tone="warning">v{l.version} · {l.latest} available</Badge>
    case 'broken':
      return <Badge tone="danger">needs repair</Badge>
    case 'unsupported':
      return <Badge tone="neutral">not possible here</Badge>
    default:
      return <Badge tone={l.required ? 'warning' : 'neutral'}>{l.required ? 'needed, not installed' : 'not installed'}</Badge>
  }
}

/** The header shows loaders that are in the game or needed; with many (Cyberpunk has six) the rest are counted. */
function headerLoaders(loaders: LoaderStatus[]): { shown: LoaderStatus[]; more: number } {
  if (loaders.length <= 2) return { shown: loaders, more: 0 }
  const shown = loaders.filter((l) => l.required || l.state === 'installed' || l.state === 'outdated' || l.state === 'broken')
  return { shown, more: loaders.filter((l) => !shown.includes(l) && l.state !== 'unsupported').length }
}

function LoaderRow({ game, loader, all }: { game: Game; loader: LoaderStatus; all: LoaderStatus[] }) {
  const needs = (loader.requires ?? []).map((id) => all.find((l) => l.id === id)?.name ?? id)
  const busy = useMods((s) => Boolean(s.loaderBusy[`${game.id}:${loader.id}`]))
  const { installLoader, removeLoader } = useMods()
  const action = loader.canUpdate ? 'Update' : loader.canInstall ? (loader.state === 'broken' ? 'Repair' : 'Install') : undefined
  return (
    <div className="rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold text-ink-100">{loader.name}</span>
        {loaderBadge(loader)}
        {loader.via && loader.state !== 'unsupported' && (
          <span className="text-[11.5px] text-ink-400">{loader.via === 'steam' ? 'through Steam' : loader.via === 'github' ? 'official GitHub release' : loader.via === 'manual' ? 'installed by hand' : 'official release'}</span>
        )}
        <div className="flex-1" />
        {action && (
          <Button size="sm" variant={loader.required ? 'primary' : 'secondary'} loading={busy} icon={<Download className="size-3.5" />} onClick={() => void installLoader(game.id, loader.id)}>
            {action}
          </Button>
        )}
        {loader.canRemove && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            icon={<Trash className="size-3.5" />}
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${loader.name}?`,
                message:
                  loader.via === 'steam'
                    ? `Steam's uninstall dialog opens for ${loader.name}. Your modded worlds and characters stay in Documents.`
                    : `${loader.name} is taken out of ${game.name} again. Mods that need it stop working until it is installed again.`,
                confirmLabel: 'Remove',
                danger: true
              })
              if (ok) void removeLoader(game.id, loader.id)
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {loader.summary && <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{loader.summary}{needs.length ? ` Needs ${needs.join(' and ')} (installed with it).` : ''}</p>}
      {(loader.detail || loader.blocked) && <p className={cn('mt-1.5 text-[12.5px] leading-relaxed', loader.blocked ? 'text-amber-200/90' : 'text-ink-300')}>{loader.blocked ?? loader.detail}</p>}
      {loader.warning && !loader.blocked && (
        <p className="mt-1.5 flex gap-2 text-[12.5px] leading-relaxed text-amber-200/90">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {loader.warning}
        </p>
      )}
      {loader.dir && loader.state !== 'missing' && loader.state !== 'unsupported' && (
        <button className="mt-1 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-400 hover:text-ink-200" onClick={() => void invoke('app:openPath', loader.dir!)}>
          <FolderOpen className="size-3" /> {loader.dir}
        </button>
      )}
    </div>
  )
}

function StepIcon({ step }: { step: SetupStep }) {
  if (step.state === 'running') return <LoaderCircle className="size-4 animate-spin text-ink-200" />
  if (step.state === 'done') return <CircleCheck className="size-4 text-emerald-300" />
  if (step.state === 'failed') return <CircleX className="size-4 text-rose-300" />
  if (step.state === 'skipped') return <SkipForward className="size-4 text-ink-400" />
  return <CircleDashed className="size-4 text-ink-500" />
}

function Operation({ op }: { op: SetupProgress }) {
  return (
    <div className={cn('rounded-xl border px-4 py-3', op.done && !op.ok ? 'border-rose-400/20 bg-rose-500/[0.06]' : 'border-white/[0.06] bg-black/20')}>
      <div className="mb-2 text-[12.5px] font-semibold text-ink-100">{op.title}</div>
      <div className="space-y-2">
        {op.steps.map((s) => (
          <div key={s.id} className="flex items-start gap-2.5">
            <span className="mt-0.5">
              <StepIcon step={s} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink-100">{s.label}</div>
              {s.detail && <div className={cn('text-[12px] leading-relaxed', s.state === 'failed' ? 'text-rose-200/90' : 'text-ink-400')}>{s.detail}</div>}
              {s.state === 'running' && <ProgressBar className="mt-1.5" value={s.progress} indeterminate={s.progress === undefined} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LastStart({ check }: { check: LaunchCheck }) {
  if (!check.ran) return null
  const ok = !check.errors.length
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-[12.5px]', ok ? 'border-white/[0.06] bg-black/20' : 'border-amber-400/20 bg-amber-500/[0.06]')}>
      <div className="flex flex-wrap items-center gap-2">
        {ok ? <CircleCheck className="size-4 text-emerald-300" /> : <TriangleAlert className="size-4 text-amber-300" />}
        <span className="font-semibold text-ink-100">Last start{check.at ? ` ${relativeTime(check.at)}` : ''}</span>
        {check.loader && <Badge>{check.loader}</Badge>}
        <div className="flex-1" />
        {check.logFile && (
          <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => void invoke('app:openPath', check.logFile!)}>
            Loader log
          </Button>
        )}
      </div>
      <p className="mt-1.5 leading-relaxed text-ink-300">
        {check.loaded.length ? `Loaded ${check.loaded.length} plugin${check.loaded.length === 1 ? '' : 's'}: ${check.loaded.join(', ')}.` : check.loader?.startsWith('BepInEx') ? 'BepInEx started but loaded no plugins.' : 'The mod loader started.'}
        {check.errors.length ? ` ${check.errors.length} error line${check.errors.length === 1 ? '' : 's'} in its log:` : ''}
      </p>
      {check.errors.length > 0 && (
        <pre className="mt-1.5 max-h-28 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-amber-100/80">{check.errors.slice(0, 6).join('\n')}</pre>
      )}
    </div>
  )
}

const NO_SHORTCUTS: ShortcutInfo[] = []

export function SetupPanel({ game }: { game: Game }) {
  const info = useMods((s) => s.integration[game.id])
  const op = useMods((s) => s.operation[game.id])
  const check = useMods((s) => s.launchCheck[game.id])
  // Selectors must return stable values (a fresh [] each time would re-render forever).
  const shortcuts = useMods((s) => s.shortcuts[game.id]) ?? NO_SHORTCUTS
  const { inspect, createShortcut } = useMods()
  const [refreshing, setRefreshing] = useState(false)
  const needsAttention = Boolean(info && (!info.valid || info.loaders.some((l) => l.required && l.state !== 'installed' && l.state !== 'outdated') || (op?.done && !op.ok)))
  const [open, setOpen] = useState<boolean | undefined>()
  const expanded = open ?? needsAttention

  if (!info) return <div className="skeleton mb-4 h-14 rounded-2xl" />

  const support = SUPPORT[info.support]
  const running = op && !op.done
  const showOp = op && (running || !op.ok)
  const canShortcut = (info.shortcutVariants ?? []).length > 0

  return (
    <Card className="mb-4 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen(!expanded)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!expanded))}
        aria-expanded={expanded}
      >
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-xl', needsAttention ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.06] text-ink-200')}>
          {running ? <LoaderCircle className="size-4 animate-spin" /> : <Wrench className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-ink-100">{info.name}</span>
            <Badge tone={support.tone}>
              <span title={support.hint}>{support.label}</span>
            </Badge>
            <Badge>
              <span title={info.distribution.detail}>{info.distribution.label}</span>
            </Badge>
            {info.version && <Badge className="font-mono">{info.version}</Badge>}
            {headerLoaders(info.loaders).shown.map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1 text-[11.5px] text-ink-400">
                {l.name}: {loaderBadge(l)}
              </span>
            ))}
            {headerLoaders(info.loaders).more > 0 && (
              <span className="text-[11.5px] text-ink-400">
                {headerLoaders(info.loaders).more} more mod loader{headerLoaders(info.loaders).more === 1 ? '' : 's'} available
              </span>
            )}
          </div>
          {running ? (
            <div className="mt-0.5 truncate text-[12px] text-ink-300">{op.steps.find((s) => s.state === 'running')?.detail ?? op.title}</div>
          ) : !info.valid ? (
            <div className="mt-0.5 truncate text-[12px] text-rose-300">{info.problems[0]}</div>
          ) : info.limitations[0] && info.support !== 'full' ? (
            <div className="mt-0.5 truncate text-[12px] text-ink-400">{info.limitations[0]}</div>
          ) : null}
        </div>
        <IconButton
          label="Check again"
          onClick={(e) => {
            e.stopPropagation()
            setRefreshing(true)
            void inspect(game.id, true).finally(() => setRefreshing(false))
          }}
        >
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
        </IconButton>
        <ChevronDown className={cn('size-4 text-ink-400 transition-transform', expanded && 'rotate-180')} />
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className="space-y-3 border-t border-white/[0.05] px-4 py-4">
              {!info.valid && (
                <div className="flex gap-2.5 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-rose-100/90">
                  <Ban className="mt-0.5 size-4 shrink-0 text-rose-300" />
                  <div>
                    {info.problems.map((p) => (
                      <p key={p}>{p}</p>
                    ))}
                    <p className="mt-1 text-ink-300">Fix the executable or install folder in the Settings tab; nothing is deployed until the game checks out.</p>
                  </div>
                </div>
              )}

              {showOp && <Operation op={op} />}

              {info.loaders.map((l) => (
                <LoaderRow key={l.id} game={game} loader={l} all={info.loaders} />
              ))}

              {[...info.warnings, ...info.limitations].length > 0 && (
                <div className="space-y-1.5 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
                  {info.warnings.map((w) => (
                    <p key={w} className="flex gap-2 text-[12.5px] leading-relaxed text-amber-200/90">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
                    </p>
                  ))}
                  {info.limitations
                    .filter((x) => !info.loaders.some((l) => l.blocked === x))
                    .map((w) => (
                      <p key={w} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-300">
                        <Info className="mt-0.5 size-3.5 shrink-0 text-ink-400" /> {w}
                      </p>
                    ))}
                </div>
              )}

              {check && <LastStart check={check} />}

              {canShortcut && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-ink-100">Shortcut for the modded start</div>
                    <div className="text-[12px] text-ink-400">
                      {shortcuts.length ? shortcuts.map((s) => `${s.label} (${s.where === 'desktop' ? 'desktop' : 'Start menu'})`).join(', ') : 'Starts the game with its mod loader. Your own shortcuts stay as they are.'}
                    </div>
                  </div>
                  <Button size="sm" icon={<Monitor className="size-3.5" />} onClick={() => void createShortcut(game.id, 'modded', 'desktop')}>
                    {shortcuts.some((s) => s.where === 'desktop') ? 'Update desktop shortcut' : 'Desktop'}
                  </Button>
                  <Button size="sm" icon={<SquareMenu className="size-3.5" />} onClick={() => void createShortcut(game.id, 'modded', 'startmenu')}>
                    {shortcuts.some((s) => s.where === 'startmenu') ? 'Update Start menu' : 'Start menu'}
                  </Button>
                </div>
              )}

              <details className="group rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
                <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-ink-200 select-none">
                  <span className="inline-flex items-center gap-1.5">
                    <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" /> Where mods go and what NexusForge does for {game.name}
                  </span>
                </summary>
                <div className="mt-3 space-y-1.5">
                  {info.targets.map((t) => (
                    <div key={t.id} className="flex items-center gap-3 text-[12.5px]">
                      <span className="w-40 shrink-0 text-ink-300">{t.label}</span>
                      <button className="min-w-0 truncate text-left font-mono text-[11.5px] text-ink-400 hover:text-ink-100" title={t.dir} onClick={() => void invoke('app:openPath', t.dir)}>
                        {t.dir}
                      </button>
                      {t.userData && <Badge className="shrink-0 text-[10px]">saves: copied, never deleted</Badge>}
                    </div>
                  ))}
                </div>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-300">
                  {info.capabilities.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </details>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}
