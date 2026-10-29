import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowDownWideNarrow, ChevronsDown, CircleAlert, CircleCheck, Compass, Download, Gamepad2, KeyRound, LogIn, Settings, ThumbsUp, Clock, Info } from 'lucide-react'
import { accountForSource, ensureSignedIn } from '../store/accounts'
import type { InstalledMod, ModSearchResponse, ModSearchResult, ModSort, SourceGameBinding, SourceInfo } from '@shared/types'
import { SORT_LABEL } from '@shared/sort'
import { installedIndex, isInstalled } from '@shared/installed'
import { invoke, on } from '../lib/api'
import { cn, formatCount, relativeTime } from '../lib/format'
import { useLibrary, visibleGames } from '../store/library'
import { toast, useNav } from '../store/ui'
import { Badge, Button, SearchInput, Spinner } from '../components/ui'
import { Select } from '../components/Popover'
import { EmptyState } from '../components/Chrome'
import { GameIcon } from '../components/GameArt'
import { ModDetailsModal } from '../modals/ModDetailsModal'

const SORTS: ModSort[] = ['relevance', 'endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated']
const SORT_KEY = 'nf.browse.sort'

/** "the last 7 days", "the last year", "all time" */
function span(days: number): string {
  if (!days) return 'all time'
  if (days % 365 === 0) return days === 365 ? 'the last year' : `the last ${days / 365} years`
  return `the last ${days} days`
}

function ResultCard({ mod, index, installed, onOpen }: { mod: ModSearchResult; index: number; installed: boolean; onOpen(): void }) {
  const [failed, setFailed] = useState(false)
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 16) * 0.015, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border border-white/[0.055] bg-white/[0.022] text-left transition-colors duration-200 hover:border-white/[0.11] hover:bg-white/[0.04]"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-ink-850">
        {installed && (
          <span className="frost absolute top-2 left-2 z-10 inline-flex h-5.5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-emerald-200">
            <CircleCheck className="size-3" /> Installed
          </span>
        )}
        {mod.thumbnail && !failed ? (
          <>
            <img src={mod.thumbnail} alt="" onError={() => setFailed(true)} className="absolute inset-0 size-full scale-110 object-cover opacity-30 blur-xl" draggable={false} />
            <img src={mod.thumbnail} alt="" onError={() => setFailed(true)} loading="lazy" className="relative size-full object-contain transition-transform duration-500 group-hover:scale-[1.03]" draggable={false} />
          </>
        ) : (
          <div className="flex size-full items-center justify-center text-ink-500">
            <Compass className="size-7" />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col px-3.5 pt-3 pb-3">
        <div className="line-clamp-1 text-[13.5px] font-semibold text-ink-100">{mod.name}</div>
        {mod.author && <div className="mt-0.5 truncate text-[12px] text-ink-400">by {mod.author}</div>}
        <p className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-relaxed text-ink-300">{mod.summary}</p>
        <div className="mt-2.5 flex items-center gap-3 text-[11.5px] text-ink-400 tabular-nums">
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
  // How the first page was put together (window looked back over, completed with another order); "Load more" continues it.
  const [shape, setShape] = useState<Omit<ModSearchResponse, 'results'> | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ModSearchResult | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [sortPref, setSortPref] = useState<ModSort>(() => {
    const saved = localStorage.getItem(SORT_KEY) as ModSort | null
    return saved && SORTS.includes(saved) ? saved : 'endorsed'
  })
  const [installedOnly, setInstalledOnly] = useState(false)
  const seq = useRef(0)
  const listOf = useRef('')
  const chooseSort = (s: ModSort) => {
    setSortPref(s)
    localStorage.setItem(SORT_KEY, s)
  }

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
  const source = sources.find((s) => s.id === sourceId)
  // Each site only gets the orders it has itself, so the list matches the site's. "Best match" only while searching.
  const searching = Boolean(query.trim())
  const offered = (searching && source?.querySorts) || source?.sorts
  const available = SORTS.filter((s) => (s === 'relevance' ? searching : !offered || offered.includes(s)))
  const sort: ModSort = available.includes(sortPref) ? sortPref : searching ? 'relevance' : available.includes('endorsed') ? 'endorsed' : (available[0] ?? 'endorsed')
  const updateGame = useLibrary((s) => s.update)

  // Which game the source searches ("Casualties: Unknown" on Nexus is "scavprototype"); shown so it can be corrected.
  const [bindings, setBindings] = useState<SourceGameBinding[] | undefined>()
  useEffect(() => {
    setBindings(undefined)
    if (!source?.bindingLabel || !gameId) return
    let alive = true
    invoke('sources:bindings', source.id, gameId)
      .then((b) => alive && setBindings(b))
      .catch(() => alive && setBindings([]))
    return () => {
      alive = false
    }
  }, [source?.id, source?.bindingLabel, gameId])
  const chosenBinding = sourceId ? game?.modding.sources[sourceId] : undefined
  const effectiveBinding = chosenBinding ?? bindings?.[0]?.value

  // "Load more": the site's next pages, appended; a page that brings nothing new ends the list.
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMore = async () => {
    if (!sourceId || loadingMore) return
    const mySeq = seq.current
    setLoadingMore(true)
    try {
      const r = await invoke('sources:query', sourceId, query, gameId, { sort, page: page + 1, windowDays: shape?.windowDays, fillSort: shape?.filled?.sort })
      if (mySeq !== seq.current) return
      const have = new Set((results ?? []).map((x) => x.id))
      const fresh = r.results.filter((x) => !have.has(x.id))
      setResults([...(results ?? []), ...fresh])
      setPage(page + 1)
      setMore(Boolean(r.more) && fresh.length > 0)
    } catch (err) {
      toast.error('Could not load more', (err as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }

  // Debounced search; stale responses are dropped. Another game or source starts from an empty grid, so its
  // list never shows the previous one's mods (or their "Installed" marks) while it loads.
  useEffect(() => {
    if (!sourceId) return
    const mySeq = ++seq.current
    const list = `${sourceId}|${gameId ?? ''}`
    if (listOf.current !== list) {
      listOf.current = list
      setResults(undefined)
      setShape(undefined)
    }
    setLoading(true)
    setError(undefined)
    setPage(0)
    setMore(false)
    const t = setTimeout(
      () => {
        invoke('sources:query', sourceId, query, gameId, { sort })
          .then(({ results: list, ...rest }) => {
            if (mySeq !== seq.current) return
            setResults(list)
            setShape(rest)
            setMore(Boolean(rest.more))
          })
          .catch((err: Error) => {
            if (mySeq !== seq.current) return
            setResults([])
            setShape(undefined)
            setError(err.message)
          })
          .finally(() => mySeq === seq.current && setLoading(false))
      },
      query ? 380 : 0
    )
    return () => clearTimeout(t)
  }, [sourceId, query, gameId, chosenBinding, attempt, sort])

  // What's installed in the chosen game: NexusForge's mods and the ones found in its folders.
  const detected = useLibrary((s) => (gameId ? s.detected[gameId] : undefined))
  const [managed, setManaged] = useState<InstalledMod[]>([])
  useEffect(() => {
    setManaged([])
    if (!gameId) return
    let live = true
    const load = () => void invoke('mods:list', gameId).then((m) => live && setManaged(m), () => {})
    load()
    const off = on('mods:changed', (e) => e.gameId === gameId && load())
    return () => {
      live = false
      off()
    }
  }, [gameId])
  const index = useMemo(() => installedIndex(managed, detected?.mods ?? []), [managed, detected])
  const shownResults = useMemo(() => (results && installedOnly ? results.filter((r) => isInstalled(index, r)) : results), [results, installedOnly, index])
  const installedHere = useMemo(() => (results ?? []).filter((r) => isInstalled(index, r)).length, [results, index])
  const sortOptions = available.map((s) => ({ value: s, label: SORT_LABEL[s], hint: source?.sortLabels?.[s] }))
  const siteName = source?.name ?? 'the site'
  const siteSortName = (s: ModSort) => source?.sortLabels?.[s] ?? SORT_LABEL[s]
  const forGame = game ? ` for ${game.name}` : ''

  // One line above the list that says whose order this is, and how a short list was completed.
  const listNote = (() => {
    if (!shape || shape.sort !== sort || !results?.length) return undefined
    if (shape.approximate) return `${siteName} can't list mods by “${SORT_LABEL[sort]}” itself, so NexusForge sorted the mods it returned.`
    if (shape.widenedFrom) {
      const { days, count } = shape.widenedFrom
      const few = count === 0 ? 'No mods' : count === 1 ? 'Only 1 mod' : `Only ${count} mods`
      return `${few} on ${siteName}${forGame} ${count === 1 ? 'is' : 'are'} from ${span(days)}, so this list covers ${span(shape.windowDays ?? 0)}, in ${siteName}${siteName.endsWith('s') ? "'" : "'s"} own order.`
    }
    if (shape.filled) {
      const { count, sort: rest } = shape.filled
      return count
        ? `${siteName} lists only ${count === 1 ? '1 mod' : `${count} mods`}${forGame} under “${siteSortName(sort)}”; the rest follow in its “${siteSortName(rest)}” order.`
        : `${siteName} lists no mods${forGame} under “${siteSortName(sort)}” yet, so this is its “${siteSortName(rest)}” order.`
    }
    return source?.sortLabels?.[sort] ? `Same order as ${siteName} itself: “${source.sortLabels[sort]}”.` : undefined
  })()

  const gameOptions = useMemo(() => games.map((g) => ({ value: g.id, label: g.name, icon: <GameIcon game={g} className="size-5 rounded" /> })), [games])
  const needsBinding = error && /choose|community|game domain|pick a game/i.test(error)
  // The game simply isn't on this site ("Modrinth only has Minecraft mods"); trying again won't change that.
  const wrongSite = Boolean(error && /only has/i.test(error))
  // Errors come as "Modrinth: …"; the selected tab already says which site.
  const errorText = error && source ? error.replace(`${source.name}: `, '') : error

  return (
    <div className="h-full overflow-y-auto px-8 pt-5 pb-10">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-100">Browse mods</h1>
          <p className="mt-0.5 text-[13px] text-ink-400">Search any connected source and install straight into a game.</p>
        </div>
        <Select value={gameId} width={320} className="w-[280px]" icon={<Gamepad2 className="size-4" />} placeholder="Choose a game" options={gameOptions} onChange={setGameId} />
      </div>

      <div className="mb-3 flex flex-wrap rounded-[10px] bg-white/[0.04] p-0.5">
        {sources.map((s) => (
          <button
            key={s.id}
            onClick={() => setSourceId(s.id)}
            className={cn('relative h-8 rounded-lg px-3.5 text-[13px] font-medium transition-colors', sourceId === s.id ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200')}
          >
            {sourceId === s.id && <motion.span layoutId="source-pill" className="absolute inset-0 rounded-lg bg-white/[0.09] shadow-[0_1px_2px_rgba(0,0,0,0.4)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <span className="relative">{s.name}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder={source ? `Search ${source.name}${forGame}` : 'Search'} className="min-w-[280px] flex-1" />
        <Select<ModSort> value={sort} width={340} className="w-[220px]" icon={<ArrowDownWideNarrow className="size-4" />} options={sortOptions} onChange={chooseSort} />
        <button
          onClick={() => setInstalledOnly(!installedOnly)}
          disabled={!gameId}
          className={cn(
            'flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition-colors disabled:opacity-40',
            installedOnly ? 'bg-emerald-400/[0.12] text-emerald-200' : 'bg-white/[0.04] text-ink-300 hover:bg-white/[0.07] hover:text-ink-100'
          )}
          title="Only mods that are already installed in this game"
        >
          <CircleCheck className="size-3.5" /> Installed{installedHere ? ` (${installedHere})` : ''}
        </button>
      </div>

      {source?.bindingLabel && game && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-400">
          <span>
            {source.name} lists {game.name} as
          </span>
          {bindings === undefined ? (
            <Spinner className="size-3.5" />
          ) : (
            <Select
              value={effectiveBinding}
              width={360}
              className="h-8 min-w-[220px] text-[12.5px]"
              placeholder="Not found, pick one"
              options={[
                ...(chosenBinding && !bindings.some((b) => b.value === chosenBinding) ? [{ value: chosenBinding, label: chosenBinding }] : []),
                ...bindings.map((b) => ({ value: b.value, label: b.label, hint: b.value }))
              ]}
              onChange={(v) => void updateGame(game.id, { modding: { ...game.modding, sources: { ...game.modding.sources, [source.id]: v } } })}
            />
          )}
          {!chosenBinding && effectiveBinding && <Badge>auto-detected</Badge>}
        </div>
      )}

      {!error && (source?.description || listNote) && (
        <div className="mb-4 space-y-1 text-[12px] leading-relaxed text-ink-400">
          {source?.description && <p>{source.description}</p>}
          {listNote && (
            <p className="flex items-start gap-1.5 text-ink-300">
              <Info className="mt-[3px] size-3.5 shrink-0 text-ink-400" />
              {listNote}
            </p>
          )}
        </div>
      )}

      {error ? (
        <EmptyState icon={wrongSite ? <Compass /> : <CircleAlert />} title={wrongSite ? `${game?.name ?? 'This game'} isn't on ${siteName}` : "This source can't search right now"} message={errorText}>
          {needsBinding && game && (
            <Button variant="primary" icon={<Settings className="size-4" />} onClick={() => navigate({ name: 'game', gameId: game.id, tab: 'settings' })}>
              Open {game.name} settings
            </Button>
          )}
          {/api key/i.test(error) && sourceId && accountForSource(sourceId) && (
            <Button
              variant="primary"
              icon={<LogIn className="size-4" />}
              onClick={async () => {
                if (await ensureSignedIn([sourceId], `${source?.name ?? 'This site'} only works with your (free) account.`)) setAttempt((n) => n + 1)
              }}
            >
              Sign in to {source?.name}
            </Button>
          )}
          {/api key/i.test(error) && (
            <Button icon={<KeyRound className="size-4" />} onClick={() => navigate({ name: 'accounts' })}>
              Accounts
            </Button>
          )}
          {!needsBinding && !wrongSite && !/api key/i.test(error) && <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
        </EmptyState>
      ) : loading && !results?.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton h-[272px] rounded-xl" />
          ))}
        </div>
      ) : shownResults && shownResults.length ? (
        <>
          <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5 transition-opacity', loading && 'opacity-50')}>
            {shownResults.map((r, i) => (
              <ResultCard key={`${r.sourceId}:${r.id}`} mod={r} index={i % 48} installed={isInstalled(index, r)} onOpen={() => setOpen(r)} />
            ))}
          </div>
          {more && !installedOnly && !loading && (
            <div className="mt-6 flex flex-col items-center gap-2">
              <Button icon={<ChevronsDown className="size-4" />} loading={loadingMore} onClick={() => void loadMore()} className="min-w-[200px]">
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
              <span className="text-[11.5px] text-ink-500">{results?.length ?? 0} mods shown</span>
            </div>
          )}
        </>
      ) : results && installedOnly && results.length ? (
        <EmptyState icon={<CircleCheck />} title="None of these are installed" message={`None of the mods in this list are installed in ${game?.name ?? 'this game'} yet.`}>
          <Button onClick={() => setInstalledOnly(false)}>Show all</Button>
        </EmptyState>
      ) : results ? (
        <EmptyState
          icon={<Compass />}
          title="Nothing found"
          message={
            query
              ? `No mods on ${siteName} match "${query}".`
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

      <ModDetailsModal result={open} gameId={gameId} installed={open ? isInstalled(index, open) : false} onClose={() => setOpen(undefined)} />
    </div>
  )
}
