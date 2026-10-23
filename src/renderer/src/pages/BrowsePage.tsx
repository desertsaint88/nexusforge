import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CircleAlert, Compass, Download, Gamepad2, Settings, ThumbsUp, Clock } from 'lucide-react'
import type { ModSearchResult, SourceInfo } from '@shared/types'
import { invoke } from '../lib/api'
import { cn, formatCount, relativeTime } from '../lib/format'
import { useLibrary, visibleGames } from '../store/library'
import { useNav } from '../store/ui'
import { Button, SearchInput } from '../components/ui'
import { Select } from '../components/Popover'
import { EmptyState } from '../components/Chrome'
import { GameIcon } from '../components/GameArt'
import { ModDetailsModal } from '../modals/ModDetailsModal'

function ResultCard({ mod, index, onOpen }: { mod: ModSearchResult; index: number; onOpen(): void }) {
  const [failed, setFailed] = useState(false)
  return (
    <motion.button
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 20) * 0.02, type: 'spring', stiffness: 260, damping: 26 }}
      onClick={onOpen}
      className="group glass flex flex-col overflow-hidden rounded-2xl text-left transition-all duration-300 hover:-translate-y-1 hover:border-white/[0.14] hover:shadow-[0_20px_50px_-15px_rgba(0,0,0,0.9),0_0_40px_-20px_var(--nf-accent)]"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-ink-850">
        {mod.thumbnail && !failed ? (
          <>
            <img src={mod.thumbnail} alt="" onError={() => setFailed(true)} className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-xl" draggable={false} />
            <img src={mod.thumbnail} alt="" onError={() => setFailed(true)} loading="lazy" className="relative size-full object-contain transition-transform duration-500 group-hover:scale-[1.04]" draggable={false} />
          </>
        ) : (
          <div className="flex size-full items-center justify-center text-ink-500">
            <Compass className="size-8" />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="line-clamp-1 text-[14px] font-semibold text-ink-100">{mod.name}</div>
        {mod.author && <div className="mt-0.5 truncate text-[12px] text-ink-400">by {mod.author}</div>}
        <p className="mt-2 line-clamp-2 flex-1 text-[12.5px] leading-relaxed text-ink-300">{mod.summary}</p>
        <div className="mt-3 flex items-center gap-3 text-[11.5px] text-ink-400">
          {mod.downloads !== undefined && (
            <span className="flex items-center gap-1">
              <Download className="size-3" /> {formatCount(mod.downloads)}
            </span>
          )}
          {mod.endorsements !== undefined && (
            <span className="flex items-center gap-1">
              <ThumbsUp className="size-3" /> {formatCount(mod.endorsements)}
            </span>
          )}
          {mod.updatedAt && (
            <span className="ml-auto flex items-center gap-1">
              <Clock className="size-3" /> {relativeTime(mod.updatedAt)}
            </span>
          )}
        </div>
      </div>
    </motion.button>
  )
}

export function BrowsePage({ gameId: initialGame, sourceId: initialSource }: { gameId?: string; sourceId?: string }) {
  const games = visibleGames(useLibrary((s) => s.games))
  const navigate = useNav((s) => s.navigate)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [sourceId, setSourceId] = useState<string | undefined>(initialSource)
  const [gameId, setGameId] = useState<string | undefined>(initialGame ?? [...games].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0]?.id)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModSearchResult[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ModSearchResult | undefined>()
  const seq = useRef(0)

  useEffect(() => {
    void invoke('sources:list').then((list) => {
      const enabled = list.filter((s) => s.enabled)
      setSources(enabled)
      setSourceId((cur) => cur ?? enabled[0]?.id)
    })
  }, [])

  useEffect(() => {
    if (initialGame) setGameId(initialGame)
  }, [initialGame])

  const game = games.find((g) => g.id === gameId)

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    if (!sourceId) return
    const mySeq = ++seq.current
    setLoading(true)
    setError(undefined)
    const t = setTimeout(
      () => {
        invoke('sources:search', sourceId, query, gameId)
          .then((r) => mySeq === seq.current && setResults(r))
          .catch((err: Error) => {
            if (mySeq !== seq.current) return
            setResults([])
            setError(err.message)
          })
          .finally(() => mySeq === seq.current && setLoading(false))
      },
      query ? 380 : 0
    )
    return () => clearTimeout(t)
  }, [sourceId, query, gameId])

  const source = sources.find((s) => s.id === sourceId)
  const gameOptions = useMemo(() => games.map((g) => ({ value: g.id, label: g.name, icon: <GameIcon game={g} className="size-5 rounded" /> })), [games])
  const needsBinding = error && /choose|community|game domain|pick a game/i.test(error)

  return (
    <div className="h-full overflow-y-auto px-8 pt-4 pb-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-ink-100">Browse mods</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-300">Search any connected source and install straight into a game.</p>
        </div>
        <Select value={gameId} width={320} className="w-[300px]" icon={<Gamepad2 className="size-4" />} placeholder="Choose a game" options={gameOptions} onChange={setGameId} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="glass flex rounded-2xl p-1">
          {sources.map((s) => (
            <button
              key={s.id}
              onClick={() => setSourceId(s.id)}
              className={cn('relative h-9 rounded-xl px-4 text-[13px] font-medium transition-colors', sourceId === s.id ? 'text-white' : 'text-ink-300 hover:text-ink-100')}
            >
              {sourceId === s.id && <motion.span layoutId="source-pill" className="accent-gradient absolute inset-0 rounded-xl shadow-[0_6px_20px_-8px_var(--nf-accent)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="relative">{s.name}</span>
            </button>
          ))}
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={source ? `Search ${source.name}${game ? ` for ${game.name}` : ''}` : 'Search'} className="min-w-[280px] flex-1" />
      </div>

      {source?.description && !error && <p className="-mt-3 mb-5 text-[12.5px] text-ink-400">{source.description}</p>}

      {error ? (
        <EmptyState icon={<CircleAlert />} title="This source can't search right now" message={error}>
          {needsBinding && game && (
            <Button variant="primary" icon={<Settings className="size-4" />} onClick={() => navigate({ name: 'game', gameId: game.id, tab: 'settings' })}>
              Open {game.name} settings
            </Button>
          )}
        </EmptyState>
      ) : loading && !results?.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton h-[290px] rounded-2xl" />
          ))}
        </div>
      ) : results && results.length ? (
        <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 transition-opacity', loading && 'opacity-60')}>
          {results.map((r, i) => (
            <ResultCard key={`${r.sourceId}:${r.id}`} mod={r} index={i} onOpen={() => setOpen(r)} />
          ))}
        </div>
      ) : results ? (
        <EmptyState
          icon={<Compass />}
          title="Nothing found"
          message={
            query
              ? `No mods on ${source?.name ?? 'this source'} match "${query}".`
              : `${source?.name ?? 'This source'} has no mods for ${game?.name ?? 'this game'}${source?.bindingLabel ? `, or it lists the game under a different name. You can pick the right ${source.bindingLabel.toLowerCase()} in the game's settings` : ''}.`
          }
        >
          {source?.bindingLabel && game && (
            <Button icon={<Settings className="size-4" />} onClick={() => navigate({ name: 'game', gameId: game.id, tab: 'settings' })}>
              {game.name} settings
            </Button>
          )}
        </EmptyState>
      ) : null}

      <ModDetailsModal result={open} gameId={gameId} onClose={() => setOpen(undefined)} />
    </div>
  )
}
