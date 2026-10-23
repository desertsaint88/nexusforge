import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Crown, Pin, RotateCcw, ShieldCheck, Swords } from 'lucide-react'
import type { ConflictFile, ConflictGroup, Game } from '@shared/types'
import { useMods } from '../../store/mods'
import { cn } from '../../lib/format'
import { Badge, Button, Card, SearchInput } from '../../components/ui'
import { EmptyState } from '../../components/Chrome'

const naturalWinner = (f: ConflictFile) => f.providers[f.providers.length - 1]

function GroupCard({ game, group, names, query }: { game: Game; group: ConflictGroup; names: Map<string, string>; query: string }) {
  const setOverrides = useMods((s) => s.setOverrides)
  const [open, setOpen] = useState(group.files.length <= 8)
  const [limit, setLimit] = useState(60)
  const files = query ? group.files.filter((f) => f.rel.toLowerCase().includes(query)) : group.files
  const winners = new Map<string, number>()
  for (const f of group.files) winners.set(f.winner, (winners.get(f.winner) ?? 0) + 1)
  const pinned = group.files.filter((f) => f.overridden).length

  const preferAll = (modId: string) =>
    setOverrides(game.id, Object.fromEntries(group.files.map((f) => [f.key, f.providers.includes(modId) && modId !== naturalWinner(f) ? modId : undefined])))
  const reset = () => setOverrides(game.id, Object.fromEntries(group.files.map((f) => [f.key, undefined])))
  const pick = (f: ConflictFile, modId: string) => setOverrides(game.id, { [f.key]: modId === naturalWinner(f) ? undefined : modId })

  if (query && !files.length) return null
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-300">
            <Swords className="size-4.5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold text-ink-100">
              {group.mods.map((m, i) => (
                <span key={m} className="flex items-center gap-2">
                  {i > 0 && <span className="text-ink-500">vs</span>}
                  <span className="truncate">{names.get(m) ?? m}</span>
                  <span className="text-[11px] font-medium text-ink-400 tabular-nums">({winners.get(m) ?? 0} won)</span>
                </span>
              ))}
            </div>
            <div className="mt-0.5 text-[12px] text-ink-400">
              {group.files.length} shared file{group.files.length === 1 ? '' : 's'}
              {pinned > 0 && ` · ${pinned} pinned by you`}
            </div>
          </div>
          <ChevronDown className={cn('ml-auto size-4 shrink-0 text-ink-400 transition-transform', open && 'rotate-180')} />
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {group.mods.map((m) => (
            <Button key={m} size="sm" variant="outline" icon={<Crown className="size-3.5" />} onClick={() => void preferAll(m)} title={`Let ${names.get(m)} win every file in this group`}>
              <span className="max-w-[120px] truncate">{names.get(m)}</span>
            </Button>
          ))}
          {pinned > 0 && (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void reset()}>
              Load order
            </Button>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="border-t border-white/[0.05]">
              {files.slice(0, limit).map((f) => (
                <div key={f.key} className="flex items-center gap-3 border-b border-white/[0.03] px-5 py-2 last:border-b-0 hover:bg-white/[0.02]">
                  {f.overridden ? <Pin className="size-3.5 shrink-0 text-[color-mix(in_oklab,var(--nf-accent)_70%,white)]" /> : <span className="size-3.5 shrink-0" />}
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-ink-200" title={f.rel}>
                    {f.rel}
                  </span>
                  <div className="flex shrink-0 rounded-lg border border-white/[0.06] bg-black/25 p-0.5">
                    {f.providers.map((p) => (
                      <button
                        key={p}
                        onClick={() => void pick(f, p)}
                        className={cn(
                          'max-w-[150px] truncate rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                          f.winner === p ? 'accent-gradient text-white shadow' : 'text-ink-400 hover:text-ink-100'
                        )}
                        title={f.winner === p ? `${names.get(p)} provides this file` : `Use ${names.get(p)}'s version`}
                      >
                        {names.get(p) ?? p}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {files.length > limit && (
                <button onClick={() => setLimit(limit + 200)} className="w-full py-2.5 text-[12.5px] text-ink-300 hover:text-ink-100">
                  Show {Math.min(200, files.length - limit)} more of {files.length - limit} remaining
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

export function ConflictsTab({ game }: { game: Game }) {
  const state = useMods((s) => s.byGame[game.id])
  const [query, setQuery] = useState('')
  const names = useMemo(() => new Map((state?.mods ?? []).map((m) => [m.id, m.name])), [state?.mods])
  const report = state?.conflicts

  if (!report) return <div className="skeleton h-40 rounded-2xl" />
  if (!report.totalFiles) {
    return (
      <EmptyState
        icon={<ShieldCheck />}
        title="No conflicts"
        message="None of your enabled mods replace the same file, so load order doesn't matter right now. When two mods overlap, you can pick the winner for each file here."
      />
    )
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-100">
            Conflict resolver <Badge tone="warning">{report.totalFiles.toLocaleString()} files</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-ink-300">
            By default the mod lower in the load order wins. Pick a different winner for a single file or a whole group. Pinned choices survive reordering. Deploy afterwards to apply them.
          </p>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Filter by file path" className="w-72" />
      </div>
      <div className="space-y-3">
        {report.groups.map((g) => (
          <GroupCard key={g.mods.join('|')} game={game} group={g} names={names} query={query.trim().toLowerCase()} />
        ))}
      </div>
    </div>
  )
}
