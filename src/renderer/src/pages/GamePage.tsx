import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Clock, FolderOpen, Layers, Puzzle, Rocket, Settings, Star, Swords, CalendarClock, Upload, HardDrive, CircleCheck, CircleAlert, Wrench, Stethoscope, Sparkles } from 'lucide-react'
import type { Game, LaunchOption } from '@shared/types'
import { useLibrary } from '../store/library'
import { activeProfileOf, useMods } from '../store/mods'
import { useNav, type GameTab } from '../store/ui'
import { invoke, pathForFile } from '../lib/api'
import { cn, formatBytes, formatPlaytime, relativeTime } from '../lib/format'
import { Badge, Button, IconButton, PlayButton } from '../components/ui'
import { GameLogo, HeroArt } from '../components/GameArt'
import { EmptyState, PlatformBadge, Tabs } from '../components/Chrome'
import { ModsTab } from './game/ModsTab'
import { ConflictsTab } from './game/ConflictsTab'
import { ProfilesTab } from './game/ProfilesTab'
import { GameSettingsTab } from './game/GameSettingsTab'
import { DiagnoseTab } from './game/DiagnoseTab'
import { ReShadeTab } from './game/ReShadeTab'

/** One cell of the stats strip under the header. */
function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2.5">
      <div className={cn('shrink-0 text-ink-400 [&>svg]:size-4', tone === 'ok' && 'text-emerald-300', tone === 'warn' && 'text-amber-300')}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-400">{label}</div>
        <div className="truncate text-[13px] font-medium text-ink-100">{value}</div>
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
  const detectedInfo = useLibrary((s) => s.detected[gameId])
  const integration = useMods((s) => s.integration[gameId])
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
  const outside = detectedInfo?.mods.filter((m) => m.kind !== 'loader' && !m.managedModId).length ?? 0
  const runtimeFailed = Object.values(status?.runtime ?? {}).filter((r) => r.state === 'failed').length
  const reshade = integration?.loaders.find((l) => l.id === 'reshade')

  return (
    <div className="relative h-full overflow-y-auto">
      <Hero game={game} running={running} onLaunch={(variant) => void launch(game.id, variant)} onFavorite={() => void update(game.id, { favorite: !game.favorite })} onSettings={() => setCurrent('settings')} />

      <div className="relative -mt-4 px-8 pb-10">
        <div className="mb-5 flex divide-x divide-white/[0.05] rounded-xl border border-white/[0.055] bg-ink-850/90 backdrop-blur-md">
          <Stat icon={<Clock />} label="Playtime" value={formatPlaytime(game.playtimeMinutes)} />
          <Stat icon={<CalendarClock />} label="Last played" value={relativeTime(game.lastPlayed)} />
          <Stat
            icon={<Puzzle />}
            label="Mods"
            value={
              !state ? '—'
              : !state.mods.length && outside ? `${outside} in the game folder`
              : `${enabled} of ${state.mods.length} enabled${outside ? ` · +${outside} in folder` : ''}`
            }
          />
          {(() => {
            const failed = status?.last && (status.last.outcome === 'failed' || status.last.outcome === 'rolled_back')
            const verified = Boolean(status?.deployed && status.inSync && !failed && Object.values(status.perMod).some((s) => s === 'verified'))
            return (
              <Stat
                icon={failed ? <CircleAlert /> : status?.deployed ? status.inSync ? <CircleCheck /> : <CircleAlert /> : <Rocket />}
                label="Deployment"
                tone={failed || runtimeFailed ? 'warn' : status?.deployed ? (status.inSync ? 'ok' : 'warn') : undefined}
                value={
                  deploying ? 'Deploying…'
                  : !status ? '—'
                  : failed ? (status.last!.outcome === 'rolled_back' ? 'Last deploy rolled back' : 'Last deploy failed')
                  : runtimeFailed ? `${runtimeFailed} mod${runtimeFailed === 1 ? '' : 's'} failed in game`
                  : status.deployed ? (status.inSync ? `${status.fileCount.toLocaleString()} files ${verified ? 'verified' : 'in place'}` : 'Out of date, redeploy')
                  : 'Not deployed'
                }
              />
            )
          })()}
        </div>

        <Tabs<GameTab>
          id={`game-${gameId}`}
          value={current}
          onChange={setCurrent}
          tabs={[
            {
              value: 'mods',
              label: 'Mods',
              icon: <Layers />,
              badge: state?.mods.length || outside ? <span className="text-[11px] text-ink-400 tabular-nums">{(state?.mods.length ?? 0) + outside}</span> : undefined
            },
            {
              value: 'conflicts',
              label: 'Conflicts',
              icon: <Swords />,
              badge: conflictCount ? <Badge tone="warning">{conflictCount}</Badge> : undefined
            },
            { value: 'profiles', label: 'Profiles', icon: <Star />, badge: profile ? <span className="text-[11px] text-ink-400">{profile.name}</span> : undefined },
            {
              value: 'reshade',
              label: 'ReShade',
              icon: <Sparkles />,
              badge: reshade?.state === 'installed' ? <span className="size-1.5 rounded-full bg-emerald-400" /> : reshade?.required && reshade.state !== 'unsupported' ? <Badge tone="warning">needed</Badge> : undefined
            },
            {
              value: 'diagnose',
              label: 'Diagnose',
              icon: <Stethoscope />,
              badge: runtimeFailed ? <Badge tone="danger">{runtimeFailed}</Badge> : undefined
            },
            { value: 'settings', label: 'Settings', icon: <Settings /> }
          ]}
        />

        <div className="pt-5">
          <AnimatePresence mode="wait">
            <motion.div key={current} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
              {current === 'mods' && <ModsTab game={game} onShowConflicts={() => setCurrent('conflicts')} />}
              {current === 'conflicts' && <ConflictsTab game={game} />}
              {current === 'profiles' && <ProfilesTab game={game} />}
              {current === 'reshade' && <ReShadeTab game={game} />}
              {current === 'diagnose' && <DiagnoseTab game={game} />}
              {current === 'settings' && <GameSettingsTab game={game} onRemoved={() => navigate({ name: 'library' })} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {dropping && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-950/70 backdrop-blur-md">
            <motion.div initial={{ scale: 0.94 }} animate={{ scale: 1 }} className="flex flex-col items-center gap-4 rounded-[32px] border-2 border-dashed border-[color-mix(in_oklab,var(--nf-accent)_60%,transparent)] px-20 py-14">
              <div className="accent-gradient flex size-16 items-center justify-center rounded-3xl border border-white/10 text-white">
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

function Hero({ game, running, onLaunch, onFavorite, onSettings }: { game: Game; running: boolean; onLaunch(variant?: LaunchOption['id']): void; onFavorite(): void; onSettings(): void }) {
  const modInfo = useLibrary((s) => s.detected[game.id])
  // Games with a mod loader start two ways (Terraria / tModLoader, BepInEx on / off); the main one is the big button.
  const options = useMods((s) => s.integration[game.id]?.launchOptions) ?? []
  const primary = options.find((o) => o.primary && o.available) ?? options.find((o) => o.available)
  const others = options.filter((o) => o !== primary && (o.available || o.id === 'modded'))
  return (
    // Shorter on short windows, so the mod list starts above the fold.
    <div className="relative h-[clamp(220px,36vh,300px)] overflow-hidden">
      <motion.div initial={{ scale: 1.05, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }} className="absolute inset-0">
        <HeroArt game={game} />
      </motion.div>
      <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/60 to-ink-900/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-900/85 via-ink-900/20 to-transparent" />
      <div className="relative flex h-full flex-col justify-end px-8 pb-9">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            <PlatformBadge platform={game.platform} />
            {game.sizeBytes ? (
              <span className="frost inline-flex h-5.5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ink-200">
                <HardDrive className="size-3" /> {formatBytes(game.sizeBytes)}
              </span>
            ) : null}
            {game.version && <span className="frost inline-flex h-5.5 items-center rounded-md px-1.5 font-mono text-[11px] text-ink-200">v{game.version}</span>}
            {modInfo &&
              (modInfo.supported ? (
                <span title={modInfo.support.join('\n')} className="frost inline-flex h-5.5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ink-200">
                  <Wrench className="size-3" /> {modInfo.support[0] ?? 'Mod support'}
                </span>
              ) : (
                <span title={modInfo.support.join('\n') || 'No mod loader, mod folder or known mod setup found'} className="frost inline-flex h-5.5 items-center rounded-md px-1.5 text-[11px] font-medium text-ink-400">
                  No known mod support
                </span>
              ))}
            {game.missing && <Badge tone="danger">Install folder missing</Badge>}
          </div>
          <GameLogo game={game} className="!max-h-[72px]" />
          <div className="mt-4 flex items-center gap-1.5">
            <PlayButton className="min-w-[140px]" onClick={() => onLaunch(primary?.id)} disabled={running || game.missing} title={primary?.description} label={running ? 'Running' : (primary?.label ?? 'Play')} />
            {!running &&
              others.map((o) => (
                <Button
                  key={o.id}
                  variant="outline"
                  className="frost h-10"
                  disabled={!o.available || game.missing}
                  title={o.available ? o.description : o.reason}
                  onClick={() => onLaunch(o.id)}
                >
                  {o.label}
                </Button>
              ))}
            <IconButton label={game.favorite ? 'Unfavorite' : 'Favorite'} onClick={onFavorite} className={cn('frost size-10 rounded-[10px]', game.favorite && 'text-amber-300')}>
              <Star className={cn('size-4', game.favorite && 'fill-current')} />
            </IconButton>
            <IconButton label="Open install folder" onClick={() => void invoke('app:openPath', game.installDir)} className="frost size-10 rounded-[10px]">
              <FolderOpen className="size-4" />
            </IconButton>
            <IconButton label="Game settings" onClick={onSettings} className="frost size-10 rounded-[10px]">
              <Settings className="size-4" />
            </IconButton>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
