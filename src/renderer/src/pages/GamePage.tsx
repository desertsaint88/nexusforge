import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Clock, FolderOpen, Layers, Play, Puzzle, Rocket, Settings, Star, Swords, CalendarClock, Upload, HardDrive, CircleCheck, CircleAlert } from 'lucide-react'
import type { Game } from '@shared/types'
import { useLibrary } from '../store/library'
import { activeProfileOf, useMods } from '../store/mods'
import { useNav, type GameTab } from '../store/ui'
import { invoke, pathForFile } from '../lib/api'
import { cn, formatBytes, formatPlaytime, relativeTime } from '../lib/format'
import { Badge, Button, IconButton } from '../components/ui'
import { GameLogo, HeroArt } from '../components/GameArt'
import { EmptyState, PlatformBadge, Tabs } from '../components/Chrome'
import { ModsTab } from './game/ModsTab'
import { ConflictsTab } from './game/ConflictsTab'
import { ProfilesTab } from './game/ProfilesTab'
import { GameSettingsTab } from './game/GameSettingsTab'

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className="glass flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-4 py-3">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-ink-200 [&>svg]:size-4.5', tone === 'ok' && 'bg-emerald-500/15 text-emerald-300', tone === 'warn' && 'bg-amber-500/15 text-amber-300')}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">{label}</div>
        <div className="truncate text-[14px] font-semibold text-ink-100">{value}</div>
      </div>
    </div>
  )
}

function useFileDrop(onFiles: (paths: string[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const callback = useRef(onFiles)
  callback.current = onFiles
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    }
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => pathForFile(f)).filter(Boolean)
      if (paths.length) callback.current(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

export function GamePage({ gameId, tab }: { gameId: string; tab?: GameTab }) {
  const game = useLibrary((s) => s.games.find((g) => g.id === gameId))
  const running = useLibrary((s) => s.running.includes(gameId))
  const launch = useLibrary((s) => s.launch)
  const update = useLibrary((s) => s.update)
  const navigate = useNav((s) => s.navigate)
  const state = useMods((s) => s.byGame[gameId])
  const load = useMods((s) => s.load)
  const install = useMods((s) => s.install)
  const deploying = useMods((s) => s.deploying[gameId])
  const [current, setCurrent] = useState<GameTab>(tab ?? 'mods')

  useEffect(() => setCurrent(tab ?? 'mods'), [gameId, tab])
  useEffect(() => {
    void load(gameId)
  }, [gameId, load])

  const dropping = useFileDrop((paths) => void install(gameId, paths))

  if (!game) return <EmptyState icon={<Puzzle />} title="Game not found" message="It may have been removed from your library." />

  const profile = activeProfileOf(state)
  const enabled = profile?.enabled.length ?? 0
  const status = state?.status
  const conflictCount = state?.conflicts?.totalFiles ?? 0

  return (
    <div className="relative h-full overflow-y-auto">
      <Hero game={game} running={running} onLaunch={() => void launch(game.id)} onFavorite={() => void update(game.id, { favorite: !game.favorite })} onSettings={() => setCurrent('settings')} />

      <div className="relative -mt-6 px-8 pb-10">
        <div className="mb-6 flex gap-3">
          <Stat icon={<Clock />} label="Playtime" value={formatPlaytime(game.playtimeMinutes)} />
          <Stat icon={<CalendarClock />} label="Last played" value={relativeTime(game.lastPlayed)} />
          <Stat icon={<Puzzle />} label="Mods" value={state ? `${enabled} of ${state.mods.length} enabled` : '—'} />
          <Stat
            icon={status?.deployed ? status.inSync ? <CircleCheck /> : <CircleAlert /> : <Rocket />}
            label="Deployment"
            tone={status?.deployed ? (status.inSync ? 'ok' : 'warn') : undefined}
            value={deploying ? 'Deploying…' : !status ? '—' : status.deployed ? (status.inSync ? `${status.fileCount.toLocaleString()} files live` : 'Out of date, redeploy') : 'Not deployed'}
          />
        </div>

        <Tabs<GameTab>
          id={`game-${gameId}`}
          value={current}
          onChange={setCurrent}
          tabs={[
            { value: 'mods', label: 'Mods', icon: <Layers />, badge: state?.mods.length ? <span className="text-[11px] text-ink-400 tabular-nums">{state.mods.length}</span> : undefined },
            {
              value: 'conflicts',
              label: 'Conflicts',
              icon: <Swords />,
              badge: conflictCount ? <Badge tone="warning">{conflictCount}</Badge> : undefined
            },
            { value: 'profiles', label: 'Profiles', icon: <Star />, badge: profile ? <span className="text-[11px] text-ink-400">{profile.name}</span> : undefined },
            { value: 'settings', label: 'Settings', icon: <Settings /> }
          ]}
        />

        <div className="pt-6">
          <AnimatePresence mode="wait">
            <motion.div key={current} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
              {current === 'mods' && <ModsTab game={game} onShowConflicts={() => setCurrent('conflicts')} />}
              {current === 'conflicts' && <ConflictsTab game={game} />}
              {current === 'profiles' && <ProfilesTab game={game} />}
              {current === 'settings' && <GameSettingsTab game={game} onRemoved={() => navigate({ name: 'library' })} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {dropping && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-950/70 backdrop-blur-md">
            <motion.div initial={{ scale: 0.94 }} animate={{ scale: 1 }} className="flex flex-col items-center gap-4 rounded-[32px] border-2 border-dashed border-[color-mix(in_oklab,var(--nf-accent)_60%,transparent)] px-20 py-14">
              <div className="accent-gradient flex size-16 items-center justify-center rounded-3xl text-white shadow-[0_0_60px_-10px_var(--nf-accent)]">
                <Upload className="size-7" />
              </div>
              <div className="text-xl font-semibold text-ink-100">Drop to install into {game.name}</div>
              <div className="text-sm text-ink-300">.zip, .7z, .rar, folders or single files</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Hero({ game, running, onLaunch, onFavorite, onSettings }: { game: Game; running: boolean; onLaunch(): void; onFavorite(): void; onSettings(): void }) {
  return (
    <div className="relative h-[340px] overflow-hidden">
      <motion.div initial={{ scale: 1.08, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} className="absolute inset-0">
        <HeroArt game={game} />
      </motion.div>
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/55 to-ink-950/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-950/80 via-transparent to-transparent" />
      <div className="relative flex h-full flex-col justify-end px-8 pb-12">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 24 }}>
          <div className="mb-4 flex items-center gap-2">
            <PlatformBadge platform={game.platform} />
            {game.sizeBytes ? (
              <Badge className="bg-black/40 backdrop-blur-md">
                <HardDrive className="size-3" /> {formatBytes(game.sizeBytes)}
              </Badge>
            ) : null}
            {game.missing && <Badge tone="danger">Install folder missing</Badge>}
          </div>
          <GameLogo game={game} />
          <div className="mt-6 flex items-center gap-2">
            <Button variant="primary" size="lg" className="min-w-[180px]" icon={<Play className="size-4.5 fill-current" />} onClick={onLaunch} disabled={running || game.missing}>
              {running ? 'Running' : 'Launch game'}
            </Button>
            <IconButton label={game.favorite ? 'Unfavorite' : 'Favorite'} onClick={onFavorite} className={cn('size-12 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md', game.favorite && 'text-amber-300')}>
              <Star className={cn('size-5', game.favorite && 'fill-current')} />
            </IconButton>
            <IconButton label="Open install folder" onClick={() => void invoke('app:openPath', game.installDir)} className="size-12 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md">
              <FolderOpen className="size-5" />
            </IconButton>
            <IconButton label="Game settings" onClick={onSettings} className="size-12 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md">
              <Settings className="size-5" />
            </IconButton>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
