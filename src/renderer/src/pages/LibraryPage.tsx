import { memo, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, FolderSearch, Gamepad2, Layers, Play, Plus, RefreshCw, Star, Puzzle } from 'lucide-react'
import type { Game, Platform } from '@shared/types'
import { useLibrary, visibleGames } from '../store/library'
import { useNav } from '../store/ui'
import { cn, formatPlaytime, PLATFORM_LABEL, relativeTime } from '../lib/format'
import { Badge, Button, SearchInput } from '../components/ui'
import { Select } from '../components/Popover'
import { CapsuleArt, GameLogo, HeroArt } from '../components/GameArt'
import { EmptyState, PlatformBadge } from '../components/Chrome'
import { AddGameModal } from '../modals/AddGameModal'

type Filter = 'all' | 'favorites' | 'modded' | Platform | 'hidden'
type Sort = 'name' | 'recent' | 'playtime' | 'mods'

const GameCard = memo(function GameCard({ game, mods, running, index }: { game: Game; mods: number; running: boolean; index: number }) {
  const navigate = useNav((s) => s.navigate)
  const launch = useLibrary((s) => s.launch)
  const update = useLibrary((s) => s.update)
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26, delay: Math.min(index, 24) * 0.018 }}
      className="group relative"
    >
      <button
        onClick={() => navigate({ name: 'game', gameId: game.id })}
        className="relative block aspect-[2/3] w-full overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-850 text-left shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] transition-all duration-300 ease-[var(--ease-spring)] group-hover:-translate-y-1.5 group-hover:border-white/[0.16] group-hover:shadow-[0_24px_50px_-12px_rgba(0,0,0,0.9),0_0_0_1px_color-mix(in_oklab,var(--nf-accent)_30%,transparent),0_10px_60px_-20px_var(--nf-accent)]"
      >
        <CapsuleArt game={game} className="absolute inset-0 transition-transform duration-500 ease-[var(--ease-spring)] group-hover:scale-[1.04]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/25 to-transparent opacity-90 transition-opacity group-hover:opacity-100" />
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2.5">
          {mods > 0 ? (
            <Badge tone="accent" className="bg-black/50 backdrop-blur-md">
              <Puzzle className="size-3" />
              {mods}
            </Badge>
          ) : (
            <span />
          )}
          {running && (
            <span className="flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10.5px] font-bold text-emerald-300 backdrop-blur-md">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> RUNNING
            </span>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 p-3 pb-[52px] transition-all duration-300 group-hover:pb-[60px]">
          <div className="line-clamp-2 text-[14px] leading-snug font-semibold text-white drop-shadow">{game.name}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-white/60">
            <Clock className="size-3" />
            {formatPlaytime(game.playtimeMinutes)}
          </div>
        </div>
      </button>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center gap-2 transition-all duration-300 group-hover:bottom-3.5">
        <button
          onClick={() => void launch(game.id)}
          disabled={running || game.missing}
          className="accent-gradient pointer-events-auto flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-white/20 text-[13px] font-semibold text-white shadow-[0_6px_24px_-6px_var(--nf-accent)] transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          <Play className="size-3.5 fill-current" />
          {game.missing ? 'Missing' : running ? 'Running' : 'Play'}
        </button>
        <button
          onClick={() => void update(game.id, { favorite: !game.favorite })}
          className={cn(
            'pointer-events-auto flex size-9 items-center justify-center rounded-xl border border-white/15 bg-black/50 backdrop-blur-md transition-all hover:bg-black/70',
            game.favorite ? 'text-amber-300' : 'text-white/70 opacity-0 group-hover:opacity-100'
          )}
          aria-label={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={cn('size-4', game.favorite && 'fill-current')} />
        </button>
      </div>
    </motion.div>
  )
})

function ContinuePlaying({ game }: { game: Game }) {
  const navigate = useNav((s) => s.navigate)
  const launch = useLibrary((s) => s.launch)
  const running = useLibrary((s) => s.running.includes(game.id))
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative mb-8 h-[240px] overflow-hidden rounded-3xl border border-white/[0.07] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]"
    >
      <HeroArt game={game} />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/75 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/80 to-transparent" />
      <div className="relative flex h-full flex-col justify-end p-8">
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="accent">
            <Clock className="size-3" /> Continue playing
          </Badge>
          <PlatformBadge platform={game.platform} />
        </div>
        <GameLogo game={game} className="!max-h-20 !text-4xl" />
        <div className="mt-2 text-[13px] text-ink-300">
          {formatPlaytime(game.playtimeMinutes)} played · last {relativeTime(game.lastPlayed)}
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" size="lg" icon={<Play className="size-4 fill-current" />} onClick={() => void launch(game.id)} disabled={running}>
            {running ? 'Running' : 'Play'}
          </Button>
          <Button size="lg" variant="secondary" icon={<Layers className="size-4" />} onClick={() => navigate({ name: 'game', gameId: game.id })}>
            Manage mods
          </Button>
        </div>
      </div>
    </motion.div>
  )
}

export function LibraryPage() {
  const { games, running, scanning, scan, modCounts, loaded } = useLibrary()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [adding, setAdding] = useState(false)

  const visible = visibleGames(games)
  const platforms = useMemo(() => [...new Set(visible.map((g) => g.platform))], [visible])
  const hiddenCount = games.length - visible.length

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = filter === 'hidden' ? games.filter((g) => g.hidden) : visible
    return base
      .filter((g) => !q || g.name.toLowerCase().includes(q))
      .filter((g) => {
        if (filter === 'all' || filter === 'hidden') return true
        if (filter === 'favorites') return g.favorite
        if (filter === 'modded') return (modCounts[g.id] ?? 0) > 0
        return g.platform === filter
      })
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name)
        if (sort === 'playtime') return b.playtimeMinutes - a.playtimeMinutes
        if (sort === 'mods') return (modCounts[b.id] ?? 0) - (modCounts[a.id] ?? 0) || a.name.localeCompare(b.name)
        return (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.name.localeCompare(b.name)
      })
  }, [games, visible, query, filter, sort, modCounts])

  const recent = useMemo(() => [...visible].filter((g) => g.lastPlayed && !g.missing).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0], [visible])

  const chips: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: 'All games' },
    { value: 'favorites', label: 'Favorites' },
    { value: 'modded', label: 'Modded' },
    ...platforms.map((p) => ({ value: p as Filter, label: PLATFORM_LABEL[p] })),
    ...(hiddenCount ? [{ value: 'hidden' as Filter, label: `Hidden (${hiddenCount})` }] : [])
  ]

  return (
    <div className="h-full overflow-y-auto px-8 pt-4 pb-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-ink-100">Library</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-300">
            {visible.length} game{visible.length === 1 ? '' : 's'} across {platforms.length || 0} source{platforms.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<RefreshCw className={cn('size-4', scanning && 'animate-spin')} />} onClick={() => void scan()} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Rescan'}
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add game
          </Button>
        </div>
      </div>

      {recent && filter === 'all' && !query && <ContinuePlaying game={recent} />}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search your library" className="w-72" />
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.value}
              onClick={() => setFilter(c.value)}
              className={cn(
                'h-8 rounded-full border px-3.5 text-[12.5px] font-medium transition-all',
                filter === c.value ? 'border-white/20 bg-white/[0.1] text-ink-100' : 'border-white/[0.06] text-ink-300 hover:border-white/[0.12] hover:text-ink-100'
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Select<Sort>
          value={sort}
          onChange={setSort}
          width={200}
          className="w-[190px]"
          options={[
            { value: 'recent', label: 'Recently played' },
            { value: 'name', label: 'Name' },
            { value: 'playtime', label: 'Playtime' },
            { value: 'mods', label: 'Most mods' }
          ]}
        />
      </div>

      {!loaded ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />
          ))}
        </div>
      ) : list.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-5">
          {list.map((g, i) => (
            <GameCard key={g.id} game={g} mods={modCounts[g.id] ?? 0} running={running.includes(g.id)} index={i} />
          ))}
        </div>
      ) : visible.length ? (
        <EmptyState icon={<FolderSearch />} title="No matches" message="Nothing in your library matches that search or filter." />
      ) : (
        <EmptyState
          icon={<Gamepad2 />}
          title="Your library is empty"
          message="NexusForge looks for Steam, Epic, Xbox and GOG games automatically. Add folders with your other games in Settings, or add a game by hand."
        >
          <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => void scan()} loading={scanning}>
            Scan this PC
          </Button>
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add game manually
          </Button>
        </EmptyState>
      )}

      <AddGameModal open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}
