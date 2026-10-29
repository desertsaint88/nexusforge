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
import { useApp } from '../store/app'
import { GameIcon } from './GameArt'
import { ProgressBar } from './ui'

/** The app icon (resources/icon.svg, scripts/brand-mark.mjs): an "N" in one stroke ending in an ember spark. */
export function Logo({ size = 28 }: { size?: number }) {
  const small = size <= 24
  const n = small ? { d: 'M20 47V17L44 47V30.5', w: 7.6 } : { d: 'M21 46V18L43 46V30', w: 6 }
  const e = small ? { cx: 44, cy: 18.5, r: 6.2 } : { cx: 43, cy: 19, r: 5.2 }
  const t = small ? { x: 0, r: 12 } : { x: 2, r: 14 }
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="nf-logo-t" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b2c32" />
          <stop offset="1" stopColor="#0c0c0f" />
        </linearGradient>
        <linearGradient id="nf-logo-s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#b4b7bf" />
        </linearGradient>
        <radialGradient id="nf-logo-e" cx="0.42" cy="0.38" r="0.62">
          <stop offset="0" stopColor="#ffe6b0" />
          <stop offset="0.45" stopColor="#ffa14a" />
          <stop offset="1" stopColor="#ec5a24" />
        </radialGradient>
      </defs>
      <rect x={t.x} y={t.x} width={64 - 2 * t.x} height={64 - 2 * t.x} rx={t.r} fill="url(#nf-logo-t)" />
      <rect x={t.x + 0.5} y={t.x + 0.5} width={63 - 2 * t.x} height={63 - 2 * t.x} rx={t.r - 0.5} fill="none" stroke="#ffffff" strokeOpacity={small ? 0.12 : 0.09} />
      <path d={n.d} fill="none" stroke="url(#nf-logo-s)" strokeWidth={n.w} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={e.cx} cy={e.cy} r={e.r} fill="url(#nf-logo-e)" />
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
      className="btn-light flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold"
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
      <div className="flex w-[220px] items-center gap-2 pl-0.5">
        <Logo size={18} />
        <span className="text-[12.5px] font-semibold tracking-tight text-ink-200">NexusForge</span>
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
          className="no-drag flex h-7 w-[min(340px,40vw)] items-center gap-2 rounded-lg bg-white/[0.045] px-2.5 text-[12px] text-ink-400 transition-colors hover:bg-white/[0.07] hover:text-ink-200"
          aria-label="Quick search"
        >
          <Search className="size-3.5" />
          <span className="flex-1 truncate text-left">Search games and pages</span>
          <kbd className="rounded bg-white/[0.06] px-1 font-mono text-[10px] text-ink-400">Ctrl K</kbd>
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
      className={cn('group relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] font-medium transition-colors', active ? 'text-ink-100' : 'text-ink-300 hover:bg-white/[0.035] hover:text-ink-100')}
    >
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-[10px] bg-white/[0.075]" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
      <span className={cn('relative [&>svg]:size-[17px]', active ? 'text-ink-100' : 'text-ink-400 group-hover:text-ink-200')}>{icon}</span>
      <span className="relative flex-1 text-left">{label}</span>
      {badge !== undefined && <span className="relative">{badge}</span>}
    </button>
  )
}

/** Bottom of the sidebar: who is signed in to Nexus Mods, and which NexusForge this is. */
function SidebarFooter() {
  const navigate = useNav((s) => s.navigate)
  const nexus = useAccounts((s) => s.accounts.find((a) => a.id === 'nexus'))
  const version = useApp((s) => s.info?.version)
  return (
    <div className="mt-3 border-t border-white/[0.05] pt-3">
      <button onClick={() => navigate({ name: 'accounts' })} className="flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors hover:bg-white/[0.04]">
        {nexus?.avatar ? (
          <img src={nexus.avatar} alt="" className="size-7 rounded-full object-cover" draggable={false} />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-white/[0.07] text-ink-300">
            <UserRound className="size-3.5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-ink-100">{nexus?.signedIn ? (nexus.user ?? 'Nexus Mods') : 'Not signed in'}</span>
          <span className="block truncate text-[11px] text-ink-400">{nexus?.signedIn ? `Nexus Mods${nexus.detail ? ` · ${nexus.detail}` : ''}` : 'Sign in for downloads'}</span>
        </span>
        {nexus && !nexus.signedIn && <span className="size-1.5 rounded-full bg-amber-400" />}
      </button>
      {version && (
        <button onClick={() => navigate({ name: 'settings', section: 'about' })} className="mt-1 w-full px-2 text-left font-mono text-[10.5px] text-ink-500 transition-colors hover:text-ink-300">
          NexusForge {version}
        </button>
      )}
    </div>
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
    <aside className="flex w-[232px] shrink-0 flex-col px-2.5 pt-1.5 pb-2.5">
      <nav className="space-y-0.5">
        <NavItem icon={<Library />} label="Library" active={is('library') || is('game')} onClick={() => navigate({ name: 'library' })} badge={<span className="text-[11px] text-ink-500 tabular-nums">{visible.length}</span>} />
        <NavItem icon={<Compass />} label="Browse mods" active={is('browse')} onClick={() => navigate({ name: 'browse' })} />
        <NavItem
          icon={<Download />}
          label="Downloads"
          active={is('downloads')}
          onClick={() => navigate({ name: 'downloads' })}
          badge={active.length ? <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-white/[0.12] px-1.5 text-[10.5px] font-semibold text-ink-100 tabular-nums">{active.length}</span> : undefined}
        />
        <NavItem
          icon={<UserRound />}
          label="Accounts"
          active={is('accounts')}
          onClick={() => navigate({ name: 'accounts' })}
          badge={nexusSignedIn ? undefined : <span className="block size-1.5 rounded-full bg-amber-400" title="Not signed in to Nexus Mods" />}
        />
        <NavItem icon={<Settings />} label="Settings" active={is('settings')} onClick={() => navigate({ name: 'settings' })} />
      </nav>

      {quick.length > 0 && (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <div className="mb-1.5 px-2.5 text-[11px] font-medium text-ink-500">Quick access</div>
          <div className="space-y-px">
            {quick.map((g) => {
              const selected = route.name === 'game' && route.gameId === g.id
              return (
                <button
                  key={g.id}
                  onClick={() => navigate({ name: 'game', gameId: g.id })}
                  className={cn('flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors', selected ? 'bg-white/[0.075] text-ink-100' : 'text-ink-300 hover:bg-white/[0.035] hover:text-ink-100')}
                >
                  <GameIcon game={g} className="size-6 rounded-md" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{g.name}</span>
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
            className="mt-3 rounded-xl bg-white/[0.04] p-3 text-left transition-colors hover:bg-white/[0.06]"
          >
            <div className="mb-2 flex items-center justify-between text-[12px]">
              <span className="truncate font-medium text-ink-100">{active.length === 1 ? active[0].name : `${active.length} downloads`}</span>
              <span className="text-ink-400 tabular-nums">{totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : 0}%</span>
            </div>
            <ProgressBar value={totalBytes ? receivedBytes / totalBytes : undefined} indeterminate={!totalBytes} />
          </motion.button>
        )}
      </AnimatePresence>
      <SidebarFooter />
    </aside>
  )
}

export function PlatformBadge({ platform, className }: { platform: string; className?: string }) {
  return (
    <span className={cn('frost inline-flex h-5.5 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-ink-200', className)}>
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
            className="glass-strong pointer-events-auto flex items-start gap-3 rounded-xl px-3.5 py-3"
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
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] text-ink-300 [&>svg]:size-5.5">{icon}</div>
      <h3 className="text-[16px] font-semibold tracking-tight text-ink-100">{title}</h3>
      {message && <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-400">{message}</p>}
      {children && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </motion.div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs, id }: { value: T; onChange(v: T): void; tabs: Array<{ value: T; label: string; icon?: ReactNode; badge?: ReactNode }>; id: string }) {
  return (
    <div className="flex gap-0.5 border-b border-white/[0.06]">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn('relative flex h-10 items-center gap-1.5 px-3 text-[13px] font-medium transition-colors', value === t.value ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200')}
        >
          <span className="[&>svg]:size-[15px]">{t.icon}</span>
          {t.label}
          {t.badge}
          {value === t.value && <motion.span layoutId={`tab-${id}`} className="accent-line absolute inset-x-2 -bottom-px h-[2px] rounded-full" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
        </button>
      ))}
    </div>
  )
}
