import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Bug, CircleAlert, CircleArrowUp, CircleCheck, Compass, Download, Info, Library, Minus, Search, Settings, Square, SquareStack, TriangleAlert, UserRound, X } from 'lucide-react'
import type { ToastAction } from '@shared/types'
import { usePalette } from './CommandPalette'
import { reportBug, useBugReport, useUpdater } from '../store/bugreport'
import { startUpdate } from '../lib/update'
import { invoke, on } from '../lib/api'
import { cn, PLATFORM_COLOR, PLATFORM_LABEL } from '../lib/format'
import { useNav, useToasts, type Route } from '../store/ui'
import { useLibrary, visibleGames } from '../store/library'
import { isActive, useDownloads } from '../store/downloads'
import { useAccounts } from '../store/accounts'
import { GameIcon } from './GameArt'
import { ProgressBar } from './ui'

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="nf-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--nf-accent)" />
          <stop offset="1" stopColor="var(--nf-accent-2)" />
        </linearGradient>
      </defs>
      <path d="M32 3 57 17.5v29L32 61 7 46.5v-29Z" fill="url(#nf-g)" opacity="0.18" />
      <path d="M32 3 57 17.5v29L32 61 7 46.5v-29Z" fill="none" stroke="url(#nf-g)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M21 44V20l22 24V20" fill="none" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** In the title bar while an update is waiting, downloading or installing. */
function UpdatePill() {
  const status = useUpdater((s) => s.status)
  if (!status || !['available', 'downloading', 'installing'].includes(status.phase) || !status.version) return null
  const busy = status.phase !== 'available'
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      onClick={() => (busy ? useNav.getState().navigate({ name: 'settings', section: 'about' }) : void startUpdate())}
      className="accent-gradient flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold text-white shadow-lg"
      title={busy ? 'Show update progress' : `Update to NexusForge ${status.version}`}
    >
      <CircleArrowUp className={cn('size-3.5', busy && 'animate-pulse')} />
      {status.phase === 'available' && `Update ${status.version}`}
      {status.phase === 'downloading' && `Updating ${Math.round(status.percent ?? 0)}%`}
      {status.phase === 'installing' && 'Restarting…'}
    </motion.button>
  )
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const { history, back } = useNav()
  const errorCount = useBugReport((s) => s.state?.recentErrors.length ?? 0)
  useEffect(() => {
    void invoke('window:isMaximized').then(setMaximized)
    return on('window:maximized', setMaximized)
  }, [])
  return (
    <div className="drag relative z-40 flex h-10 shrink-0 items-center pl-3" onDoubleClick={() => void invoke('window:toggleMaximize')}>
      <div className="flex w-[232px] items-center gap-2">
        <Logo size={20} />
        <span className="text-[13px] font-semibold tracking-tight text-ink-100">
          Nexus<span className="text-ink-300">Forge</span>
        </span>
      </div>
      <button
        onClick={back}
        disabled={!history.length}
        className="no-drag flex size-7 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-white/[0.07] hover:text-ink-100 disabled:opacity-30"
        aria-label="Back"
      >
        <ArrowLeft className="size-4" />
      </button>
      <div className="flex flex-1 justify-center">
        <button
          onClick={() => usePalette.getState().set(true)}
          onDoubleClick={(e) => e.stopPropagation()}
          className="no-drag flex h-7 w-[min(340px,40vw)] items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 text-[12px] text-ink-400 transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] hover:text-ink-200"
          aria-label="Quick search"
        >
          <Search className="size-3.5" />
          <span className="flex-1 truncate text-left">Search games and pages</span>
          <kbd className="rounded border border-white/[0.1] px-1 font-mono text-[10px]">Ctrl K</kbd>
        </button>
      </div>
      <div className="no-drag mr-2 flex items-center gap-1.5" onDoubleClick={(e) => e.stopPropagation()}>
        <UpdatePill />
        <button
          onClick={() => reportBug({ origin: 'title bar' })}
          className="relative flex size-7 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-white/[0.07] hover:text-ink-100"
          aria-label="Report a bug"
          title={errorCount ? `Report a bug (${errorCount} error(s) recorded in this session)` : 'Report a bug'}
        >
          <Bug className="size-4" />
          {errorCount > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-rose-400/90" />}
        </button>
      </div>
      <div className="no-drag flex h-full">
        <WindowButton label="Minimize" onClick={() => void invoke('window:minimize')}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton label={maximized ? 'Restore' : 'Maximize'} onClick={() => void invoke('window:toggleMaximize')}>
          {maximized ? <SquareStack className="size-3.5" /> : <Square className="size-3.5" />}
        </WindowButton>
        <WindowButton label="Close" danger onClick={() => void invoke('window:close')}>
          <X className="size-4" />
        </WindowButton>
      </div>
    </div>
  )
}

function WindowButton({ children, onClick, label, danger }: { children: ReactNode; onClick(): void; label: string; danger?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn('flex h-full w-12 items-center justify-center text-ink-300 transition-colors', danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-white/[0.08] hover:text-ink-100')}
    >
      {children}
    </button>
  )
}

function NavItem({ icon, label, active, onClick, badge }: { icon: ReactNode; label: string; active: boolean; onClick(): void; badge?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn('group relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors', active ? 'text-ink-100' : 'text-ink-300 hover:text-ink-100')}
    >
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-white/[0.07] bg-white/[0.07]" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
      {active && <motion.span layoutId="nav-bar" className="accent-line absolute top-3 bottom-3 left-0 w-[2px] rounded-full" />}
      <span className="relative [&>svg]:size-[18px]">{icon}</span>
      <span className="relative flex-1 text-left">{label}</span>
      {badge !== undefined && <span className="relative">{badge}</span>}
    </button>
  )
}

export function Sidebar() {
  const { route, navigate } = useNav()
  const games = useLibrary((s) => s.games)
  const running = useLibrary((s) => s.running)
  const downloads = useDownloads((s) => s.items)
  const nexusSignedIn = useAccounts((s) => s.accounts.find((a) => a.id === 'nexus')?.signedIn ?? true)
  const active = downloads.filter(isActive)
  const visible = visibleGames(games)
  const quick = [...visible]
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    .slice(0, 8)
  const is = (name: Route['name']) => route.name === name

  const totalBytes = active.reduce((a, d) => a + d.total, 0)
  const receivedBytes = active.reduce((a, d) => a + d.received, 0)

  return (
    <aside className="flex w-[248px] shrink-0 flex-col px-3 pt-2 pb-3">
      <nav className="space-y-1">
        <NavItem icon={<Library />} label="Library" active={is('library') || is('game')} onClick={() => navigate({ name: 'library' })} badge={<span className="text-[11px] text-ink-400 tabular-nums">{visible.length}</span>} />
        <NavItem icon={<Compass />} label="Browse mods" active={is('browse')} onClick={() => navigate({ name: 'browse' })} />
        <NavItem
          icon={<Download />}
          label="Downloads"
          active={is('downloads')}
          onClick={() => navigate({ name: 'downloads' })}
          badge={active.length ? <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.08] px-1.5 text-[11px] font-bold text-ink-100">{active.length}</span> : undefined}
        />
        <NavItem
          icon={<UserRound />}
          label="Accounts"
          active={is('accounts')}
          onClick={() => navigate({ name: 'accounts' })}
          badge={nexusSignedIn ? undefined : <span className="block size-2 rounded-full bg-amber-400 shadow-[0_0_8px] shadow-amber-400/70" title="Not signed in to Nexus Mods" />}
        />
        <NavItem icon={<Settings />} label="Settings" active={is('settings')} onClick={() => navigate({ name: 'settings' })} />
      </nav>

      {quick.length > 0 && (
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <div className="mb-2 px-3 text-[11px] font-semibold tracking-[0.12em] text-ink-400 uppercase">Quick access</div>
          <div className="space-y-0.5">
            {quick.map((g) => {
              const selected = route.name === 'game' && route.gameId === g.id
              return (
                <button
                  key={g.id}
                  onClick={() => navigate({ name: 'game', gameId: g.id })}
                  className={cn('flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors', selected ? 'bg-white/[0.07] text-ink-100' : 'text-ink-300 hover:bg-white/[0.04] hover:text-ink-100')}
                >
                  <GameIcon game={g} className="size-7" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{g.name}</span>
                  {running.includes(g.id) && <span className="size-1.5 rounded-full bg-emerald-400/90" title="Running" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {!quick.length && <div className="flex-1" />}

      <AnimatePresence>
        {active.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={() => navigate({ name: 'downloads' })}
            className="glass mt-3 rounded-2xl p-3 text-left"
          >
            <div className="mb-2 flex items-center justify-between text-[12px]">
              <span className="truncate font-medium text-ink-100">{active.length === 1 ? active[0].name : `${active.length} downloads`}</span>
              <span className="text-ink-400 tabular-nums">{totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : 0}%</span>
            </div>
            <ProgressBar value={totalBytes ? receivedBytes / totalBytes : undefined} indeterminate={!totalBytes} />
          </motion.button>
        )}
      </AnimatePresence>
    </aside>
  )
}

export function PlatformBadge({ platform, className }: { platform: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-5.5 items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/40 px-1.5 text-[11px] font-semibold text-ink-200 backdrop-blur-md', className)}>
      <span className="size-1.5 rounded-full opacity-80" style={{ background: PLATFORM_COLOR[platform] ?? '#999' }} />
      {PLATFORM_LABEL[platform] ?? platform}
    </span>
  )
}

function runToastAction(a: ToastAction): void {
  if (a.id === 'report') reportBug(a.report)
  else if (a.id === 'update') void startUpdate()
  else useNav.getState().navigate({ name: 'settings', section: 'about' })
}

export function Toasts() {
  const { toasts, dismiss } = useToasts()
  const icons = {
    success: <CircleCheck className="size-4.5 text-emerald-400" />,
    error: <CircleAlert className="size-4.5 text-rose-400" />,
    warning: <TriangleAlert className="size-4.5 text-amber-400" />,
    info: <Info className="size-4.5 text-sky-400" />
  }
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[70] flex w-[360px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="glass-strong pointer-events-auto flex items-start gap-3 rounded-2xl px-4 py-3"
            onClick={() => dismiss(t.id)}
          >
            <div className="mt-0.5">{icons[t.kind]}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink-100">{t.title}</div>
              {t.message && <div className="selectable mt-0.5 text-[12.5px] leading-relaxed break-words text-ink-300">{t.message}</div>}
              {t.action && (
                <button
                  className="mt-2 flex h-6.5 items-center gap-1.5 rounded-md border border-white/[0.12] bg-white/[0.06] px-2 text-[12px] font-medium text-ink-100 transition-colors hover:bg-white/[0.12]"
                  onClick={(e) => {
                    e.stopPropagation()
                    dismiss(t.id)
                    runToastAction(t.action!)
                  }}
                >
                  {t.action.id === 'report' ? <Bug className="size-3.5" /> : <CircleArrowUp className="size-3.5" />}
                  {t.action.label}
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function EmptyState({ icon, title, message, children }: { icon: ReactNode; title: string; message?: ReactNode; children?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="relative mb-5">
        <div className="glass relative flex size-16 items-center justify-center rounded-3xl text-ink-100 [&>svg]:size-7">{icon}</div>
      </div>
      <h3 className="text-lg font-semibold tracking-tight text-ink-100">{title}</h3>
      {message && <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-300">{message}</p>}
      {children && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </motion.div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs, id }: { value: T; onChange(v: T): void; tabs: Array<{ value: T; label: string; icon?: ReactNode; badge?: ReactNode }>; id: string }) {
  return (
    <div className="flex gap-1 border-b border-white/[0.06]">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn('relative flex h-11 items-center gap-2 px-4 text-[13.5px] font-medium transition-colors', value === t.value ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200')}
        >
          <span className="[&>svg]:size-4">{t.icon}</span>
          {t.label}
          {t.badge}
          {value === t.value && <motion.span layoutId={`tab-${id}`} className="accent-line absolute inset-x-3 -bottom-px h-[2px] rounded-full" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
        </button>
      ))}
    </div>
  )
}
