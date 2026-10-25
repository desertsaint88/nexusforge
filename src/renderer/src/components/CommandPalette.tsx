import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Compass, CornerDownLeft, Download, Library, RefreshCw, Search, Settings, UserRound } from 'lucide-react'
import { create } from 'zustand'
import { useLibrary, visibleGames } from '../store/library'
import { useNav, type Route } from '../store/ui'
import { cn, PLATFORM_LABEL } from '../lib/format'
import { GameIcon } from './GameArt'
import { PlayGlyph } from './ui'

export const usePalette = create<{ open: boolean; set(open: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }))

interface Item {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  /** Enter. */
  run(): void
  /** Ctrl + Enter (games: play). */
  alt?(): void
  keywords?: string
}

/** Subsequence match with a bonus for word starts and runs; 0 = no match. */
function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 1000 - t.length
  if (idx > 0) return 800 - idx - t.length / 10
  let s = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    run = found === ti ? run + 1 : 0
    s += 10 + run * 5 + (found === 0 || /[\s:\-_.]/.test(t[found - 1]) ? 15 : 0)
    ti = found + 1
  }
  return s
}

/** Ctrl + K: jump to any game or page by typing. Ctrl + Enter starts the selected game. */
export function CommandPalette() {
  const { open, set } = usePalette()
  const navigate = useNav((s) => s.navigate)
  const games = visibleGames(useLibrary((s) => s.games))
  const launch = useLibrary((s) => s.launch)
  const scan = useLibrary((s) => s.scan)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        set(!usePalette.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [set])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const go = (route: Route) => () => navigate(route)
    const pages: Item[] = [
      { id: 'p:library', label: 'Library', icon: <Library />, run: go({ name: 'library' }), hint: 'Page' },
      { id: 'p:browse', label: 'Browse mods', icon: <Compass />, run: go({ name: 'browse' }), hint: 'Page', keywords: 'search nexus workshop' },
      { id: 'p:downloads', label: 'Downloads', icon: <Download />, run: go({ name: 'downloads' }), hint: 'Page' },
      { id: 'p:accounts', label: 'Accounts', icon: <UserRound />, run: go({ name: 'accounts' }), hint: 'Page', keywords: 'sign in login nexus steam' },
      { id: 'p:settings', label: 'Settings', icon: <Settings />, run: go({ name: 'settings' }), hint: 'Page', keywords: 'interface size accent' },
      { id: 'p:sources', label: 'Settings: Sources & plugins', icon: <Settings />, run: go({ name: 'settings', section: 'sources' }), hint: 'Page', keywords: 'api key' },
      { id: 'a:rescan', label: 'Rescan library', icon: <RefreshCw />, run: () => void scan(), hint: 'Action', keywords: 'scan games find' }
    ]
    const recentFirst = [...games].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.name.localeCompare(b.name))
    const gameItems: Item[] = recentFirst.map((g) => ({
      id: g.id,
      label: g.name,
      hint: g.emulator ? 'Emulated' : PLATFORM_LABEL[g.platform],
      icon: <GameIcon game={g} className="size-6 rounded-md" />,
      run: go({ name: 'game', gameId: g.id }),
      alt: () => void launch(g.id),
      keywords: g.storeName
    }))
    return [...gameItems, ...pages]
  }, [games, navigate, launch, scan])

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const scored = items
      .map((it) => ({ it, s: Math.max(score(it.label, q), it.keywords ? score(it.keywords, q) * 0.6 : 0) }))
      .filter((x) => x.s > 0)
    // Without a query: recently played games first, then pages.
    if (!q) return scored.map((x) => x.it).slice(0, 40)
    return scored.sort((a, b) => b.s - a.s).map((x) => x.it).slice(0, 40)
  }, [items, q])

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (it: Item | undefined, alt = false) => {
    if (!it) return
    set(false)
    if (alt && it.alt) it.alt()
    else it.run()
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60] flex items-start justify-center px-6 pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[4px]" onClick={() => set(false)} />
          <motion.div
            role="dialog"
            aria-label="Quick search"
            className="glass-strong relative w-full max-w-xl overflow-hidden rounded-2xl"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 36 }}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4">
              <Search className="size-4 shrink-0 text-ink-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActive((a) => Math.min(shown.length - 1, a + 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActive((a) => Math.max(0, a - 1))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    choose(shown[active], e.ctrlKey || e.metaKey)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    set(false)
                  }
                }}
                placeholder="Jump to a game or page…"
                className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-400"
              />
              <kbd className="rounded-md border border-white/[0.1] px-1.5 py-0.5 font-mono text-[10.5px] text-ink-400">Esc</kbd>
            </div>
            <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
              {shown.length ? (
                shown.map((it, i) => (
                  <button
                    key={it.id}
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={(e) => choose(it, e.ctrlKey || e.metaKey)}
                    className={cn('flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors', i === active ? 'bg-white/[0.08] text-ink-100' : 'text-ink-200')}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-ink-300 [&>svg]:size-4">{it.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{it.label}</span>
                    {i === active && it.alt && (
                      <span className="flex items-center gap-1 text-[11px] text-ink-400">
                        <kbd className="rounded border border-white/[0.1] px-1 font-mono text-[10px]">Ctrl</kbd>
                        <CornerDownLeft className="size-3" />
                        <PlayGlyph className="size-3" />
                      </span>
                    )}
                    {it.hint && <span className="shrink-0 text-[11px] text-ink-500">{it.hint}</span>}
                  </button>
                ))
              ) : (
                <div className="px-3 py-8 text-center text-[13px] text-ink-400">Nothing matches “{query}”.</div>
              )}
            </div>
            <div className="flex items-center gap-4 border-t border-white/[0.06] px-4 py-2 text-[11px] text-ink-500">
              <span>↑↓ choose</span>
              <span>Enter open</span>
              <span>Ctrl + Enter play</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
