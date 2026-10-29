import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Ban, CircleCheck, CircleX, Download, FolderOpen, Inbox, MousePointerClick, PackagePlus, RotateCcw, Trash, X } from 'lucide-react'
import type { DownloadItem } from '@shared/types'
import { invoke } from '../lib/api'
import { cn, formatBytes, formatDuration, formatSpeed, relativeTime } from '../lib/format'
import { isActive, useDownloads } from '../store/downloads'
import { useLibrary, visibleGames } from '../store/library'
import { useNav } from '../store/ui'
import { Badge, Button, ProgressBar } from '../components/ui'
import { Popover, MenuItem } from '../components/Popover'
import { EmptyState } from '../components/Chrome'
import { GameIcon } from '../components/GameArt'

const STATE_BADGE: Record<DownloadItem['state'], { tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; label: string }> = {
  queued: { tone: 'neutral', label: 'Queued' },
  waiting: { tone: 'warning', label: 'Waiting for your click' },
  downloading: { tone: 'accent', label: 'Downloading' },
  installing: { tone: 'info', label: 'Installing' },
  completed: { tone: 'success', label: 'Done' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' }
}

function Thumb({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} className="size-full object-cover" draggable={false} />
  return <Download className="m-3.5 size-5 text-ink-400" />
}

function Row({ d }: { d: DownloadItem }) {
  const { cancel, retry, install, focus, remove } = useDownloads()
  const games = visibleGames(useLibrary((s) => s.games))
  const game = games.find((g) => g.id === d.gameId)
  const navigate = useNav((s) => s.navigate)
  const pct = d.total ? d.received / d.total : undefined
  const eta = d.speed > 0 && d.total ? Math.max(0, (d.total - d.received) / d.speed) : undefined
  const badge = STATE_BADGE[d.state]
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }} className="glass flex items-center gap-4 rounded-2xl px-5 py-4">
      <div className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-white/[0.05]">
        <Thumb src={d.thumbnail} />
        {d.state === 'completed' && <CircleCheck className="absolute -right-0.5 -bottom-0.5 size-4.5 rounded-full bg-ink-900 text-emerald-400" />}
        {d.state === 'failed' && <CircleX className="absolute -right-0.5 -bottom-0.5 size-4.5 rounded-full bg-ink-900 text-rose-400" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink-100">{d.name}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {game && (
            <button onClick={() => navigate({ name: 'game', gameId: game.id })} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-300 hover:bg-white/[0.06] hover:text-ink-100">
              <GameIcon game={game} className="size-4 rounded" /> {game.name}
            </button>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-[11.5px] text-ink-400">{d.fileName || d.url}</div>
        {d.state === 'waiting' && <div className="mt-1.5 text-[12.5px] leading-relaxed text-amber-200/90">{d.hint}</div>}
        {d.hint && d.state === 'downloading' && <div className="mt-1 truncate text-[12px] text-ink-300">{d.hint}</div>}
        {(d.state === 'downloading' || d.state === 'installing' || d.state === 'queued') && (
          <div className="mt-2.5 flex items-center gap-3">
            <ProgressBar value={pct} indeterminate={d.state !== 'downloading' || !d.total} className="flex-1" />
            <span className="w-48 shrink-0 text-right text-[11.5px] text-ink-300 tabular-nums">
              {d.state === 'installing'
                ? 'Extracting…'
                : `${formatBytes(d.received)}${d.total ? ` / ${formatBytes(d.total)}` : ''}${d.speed ? ` · ${formatSpeed(d.speed)}` : ''}${eta !== undefined ? ` · ${formatDuration(eta)} left` : ''}`}
            </span>
          </div>
        )}
        {d.error && <div className="selectable mt-1.5 text-[12px] text-rose-300">{d.error}</div>}
        {!isActive(d) && !d.error && <div className="mt-1 text-[11.5px] text-ink-500">{formatBytes(d.total || d.received)} · {relativeTime(d.finishedAt ?? d.startedAt)}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {d.state === 'waiting' && (
          <Button size="sm" variant="primary" icon={<MousePointerClick className="size-3.5" />} onClick={() => void focus(d.id)}>
            Show page
          </Button>
        )}
        {(d.state === 'downloading' || d.state === 'waiting') && (
          <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => void cancel(d.id)}>
            Cancel
          </Button>
        )}
        {(d.state === 'failed' || d.state === 'cancelled') && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void retry(d.id)}>
            Retry
          </Button>
        )}
        {d.state === 'completed' && !d.installedModId && d.filePath && (
          <Popover
            align="end"
            width={280}
            trigger={({ toggle }) => (
              <Button size="sm" variant="primary" icon={<PackagePlus className="size-3.5" />} onClick={toggle}>
                Install to…
              </Button>
            )}
          >
            {(close) => (
              <div className="max-h-72 overflow-y-auto">
                {games.map((g) => (
                  <MenuItem key={g.id} icon={<GameIcon game={g} className="size-4 rounded" />} onClick={() => (close(), void install(d.id, g.id))}>
                    {g.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        )}
        {d.filePath && (
          <Button size="sm" variant="ghost" className="px-2" aria-label="Show file" title="Show file" onClick={() => void invoke('app:showItem', d.filePath!)}>
            <FolderOpen className="size-3.5" />
          </Button>
        )}
        {!isActive(d) && (
          <Button size="sm" variant="ghost" className="px-2 text-ink-400 hover:text-ink-100" aria-label="Remove from list" title="Remove from list (deletes the downloaded archive; installed mods stay)" onClick={() => void remove(d.id)}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </motion.div>
  )
}

export function DownloadsPage() {
  const { items, clear } = useDownloads()
  const active = items.filter(isActive)
  const finished = items.filter((d) => !isActive(d))
  return (
    <div className="h-full overflow-y-auto px-8 pt-4 pb-10">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-100">Downloads</h1>
          <p className="mt-0.5 text-[13px] text-ink-400">{active.length ? `${active.length} in progress` : 'Nothing downloading right now'}</p>
        </div>
        {finished.length > 0 && (
          <Button icon={<Trash className="size-4" />} onClick={() => void clear()}>
            Clear finished
          </Button>
        )}
      </div>
      {!items.length ? (
        <EmptyState icon={<Inbox />} title="No downloads yet" message="Mods you download from Browse show up here, with progress, and are installed into the chosen game automatically." />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <section>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-ink-400 uppercase">Active</div>
              <div className="space-y-2">
                <AnimatePresence initial={false}>
                  {active.map((d) => (
                    <Row key={d.id} d={d} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}
          {finished.length > 0 && (
            <section>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-ink-400 uppercase">History</div>
              <div className={cn('space-y-2')}>
                <AnimatePresence initial={false}>
                  {finished.map((d) => (
                    <Row key={d.id} d={d} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
