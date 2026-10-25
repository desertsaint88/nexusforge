import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Clock, Download, ExternalLink, Gamepad2, Link2, Tag, ThumbsUp, TriangleAlert } from 'lucide-react'
import type { ModDetails, ModSearchResult, ModVersion, ResolvedDependency } from '@shared/types'
import { supportsVersion } from '@shared/deps'
import { invoke } from '../lib/api'
import { installWithDependencies } from '../lib/install'
import { cn, formatBytes, formatCount, relativeTime } from '../lib/format'
import { useLibrary } from '../store/library'
import { Modal } from '../components/Modal'
import { DependencyRow } from '../components/DependencyDialog'
import { Badge, Button, Spinner } from '../components/ui'

function GameVersions({ versions, installed }: { versions?: string[]; installed?: string }) {
  if (!versions?.length) return null
  const shown = versions.slice(-6).reverse()
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {shown.map((v) => {
        const match = supportsVersion([v], installed)
        return (
          <span key={v} className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]', match ? 'border-emerald-400/30 bg-emerald-500/12 text-emerald-200' : 'border-white/[0.08] bg-white/[0.04] text-ink-300')}>
            {v}
          </span>
        )
      })}
      {versions.length > 6 && <span className="px-1 py-0.5 text-[10.5px] text-ink-500">+{versions.length - 6} more</span>}
    </div>
  )
}

export function ModDetailsModal({ result, gameId, installed, onClose }: { result?: ModSearchResult; gameId?: string; installed?: boolean; onClose(): void }) {
  const [details, setDetails] = useState<ModDetails | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [deps, setDeps] = useState<ResolvedDependency[] | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [started, setStarted] = useState<Set<string>>(new Set())
  const game = useLibrary((s) => s.games.find((g) => g.id === gameId))

  useEffect(() => {
    if (!result) return
    let alive = true
    setDetails(undefined)
    setError(undefined)
    setDeps(undefined)
    setStarted(new Set())
    invoke('sources:details', result.sourceId, result.id, gameId)
      .then((d) => {
        if (!alive) return
        setDetails(d)
        const primary = d.versions.find((v) => v.primary) ?? d.versions[0]
        if (gameId)
          void invoke('sources:dependencies', result.sourceId, result.id, primary?.id, gameId)
            .then((r) => alive && setDeps(r))
            .catch(() => alive && setDeps([]))
        else setDeps([])
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [result, gameId])

  const d = details
  const header = d?.images[0] ?? result?.thumbnail
  const missingCount = deps?.filter((x) => !x.installed && x.required).length ?? 0

  const install = async (v: ModVersion) => {
    if (!result) return
    setBusy(v.id)
    try {
      const primary = d?.versions.find((x) => x.primary) ?? d?.versions[0]
      // Dependencies were resolved for the primary file; other files get their own lookup.
      const ok = await installWithDependencies({ ...result, ...(d ?? {}), sourceId: result.sourceId, id: result.id }, v, gameId, v.id === primary?.id ? deps : undefined)
      if (ok) setStarted(new Set([...started, v.id]))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Modal open={Boolean(result)} onClose={onClose} width="max-w-4xl" bodyClassName="!px-0 !pb-0">
      {result && (
        <div className="flex max-h-[82vh] flex-col">
          <div className={cn('relative shrink-0 overflow-hidden', header ? 'h-52' : 'h-32')}>
            {header ? (
              <>
                <img src={header} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl" draggable={false} />
                <img src={header} alt="" className="absolute inset-0 size-full object-contain" draggable={false} />
              </>
            ) : (
              <div className="accent-gradient absolute inset-0 opacity-25" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-[#0b0c0e] via-[#0b0c0e]/45 to-transparent" />
            <div className="absolute inset-x-6 bottom-4">
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-bold tracking-tight text-white drop-shadow">{d?.name ?? result.name}</h2>
                {installed && (
                  <span className="inline-flex h-6 items-center gap-1 rounded-md border border-emerald-300/20 bg-black/60 px-2 text-[11.5px] font-semibold text-emerald-200 backdrop-blur-md">
                    <CircleCheck className="size-3.5" /> Installed{game ? ` in ${game.name}` : ''}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12.5px] text-ink-200">
                {(d?.author ?? result.author) && <span>by {d?.author ?? result.author}</span>}
                {(d?.version ?? result.version) && <span className="font-mono">v{d?.version ?? result.version}</span>}
                {(d?.downloads ?? result.downloads) !== undefined && (
                  <span className="flex items-center gap-1">
                    <Download className="size-3.5" /> {formatCount(d?.downloads ?? result.downloads)}
                  </span>
                )}
                {(d?.endorsements ?? result.endorsements) !== undefined && (
                  <span className="flex items-center gap-1">
                    <ThumbsUp className="size-3.5" /> {formatCount(d?.endorsements ?? result.endorsements)}
                  </span>
                )}
                {(d?.updatedAt ?? result.updatedAt) && (
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5" /> updated {relativeTime(d?.updatedAt ?? result.updatedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px] overflow-hidden">
            <div className="min-h-0 overflow-y-auto px-6 py-5">
              {/* Requirements */}
              {gameId && (
                <section className="mb-5">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold tracking-[0.1em] text-ink-400 uppercase">
                    <Link2 className="size-3.5" /> Requirements
                    {deps && deps.length > 0 && (missingCount ? <Badge tone="warning">{missingCount} missing</Badge> : <Badge tone="success">all installed</Badge>)}
                  </div>
                  {!deps ? (
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-400">
                      <Spinner className="size-3.5" /> Checking what this mod needs…
                    </div>
                  ) : deps.length ? (
                    <div className="space-y-1.5">
                      {deps.map((x) => (
                        <DependencyRow key={`${x.sourceId}:${x.modId ?? x.name}`} dep={x} />
                      ))}
                      {missingCount > 0 && <p className="pt-1 text-[12px] text-ink-400">NexusForge offers to install the missing ones when you install this mod.</p>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-300">
                      <CircleCheck className="size-3.5 text-emerald-400" /> No other mods required.
                    </div>
                  )}
                </section>
              )}
              {d?.gameVersions?.length ? (
                <section className="mb-5">
                  <div className="mb-1 text-[12px] font-semibold tracking-[0.1em] text-ink-400 uppercase">Made for game versions</div>
                  <GameVersions versions={d.gameVersions} installed={game?.version} />
                </section>
              ) : null}
              {d?.tags?.length ? (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {d.tags.slice(0, 12).map((t) => (
                    <Badge key={t}>
                      <Tag className="size-3" /> {t}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {error ? (
                <div className="flex items-start gap-2 text-[13px] text-rose-300">
                  <CircleAlert className="mt-0.5 size-4" /> {error}
                </div>
              ) : !d ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="skeleton h-3.5 rounded" style={{ width: `${90 - i * 9}%` }} />
                  ))}
                </div>
              ) : (
                <div className="selectable text-[13px] leading-relaxed whitespace-pre-line text-ink-200">{d.description || d.summary || 'No description.'}</div>
              )}
            </div>

            <div className="min-h-0 overflow-y-auto border-l border-white/[0.06] bg-black/20 px-4 py-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[12px] font-semibold tracking-[0.1em] text-ink-400 uppercase">Files</div>
                {d?.url && (
                  <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('app:openExternal', d.url!)}>
                    Website
                  </Button>
                )}
              </div>
              {game && (
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[12px] text-ink-300">
                  <Gamepad2 className="size-3.5" />
                  <span className="truncate">
                    Your {game.name}: <span className="font-mono text-ink-100">{game.version ? `v${game.version}` : 'version unknown'}</span>
                  </span>
                </div>
              )}
              {!game && <p className="mb-3 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">Pick a game at the top of the page to install directly. Otherwise the file is only downloaded.</p>}
              {!d && !error && <Spinner />}
              <div className="space-y-2">
                {d?.versions.slice(0, 40).map((v, i) => {
                  const compatible = supportsVersion(v.gameVersions, game?.version)
                  return (
                    <motion.div key={v.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 10) * 0.02 }} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-semibold text-ink-100" title={v.name}>
                            {v.name}
                          </div>
                          <div className="mt-0.5 text-[11.5px] text-ink-400">
                            {[v.version && `v${v.version}`, v.sizeBytes && formatBytes(v.sizeBytes), v.date && relativeTime(v.date)].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        {v.primary && <Badge tone="accent">Latest</Badge>}
                      </div>
                      {v.loaders?.length ? <div className="mt-1.5 text-[11px] text-ink-400">Loaders: {v.loaders.join(', ')}</div> : null}
                      <GameVersions versions={v.gameVersions} installed={game?.version} />
                      {compatible === false && (
                        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300">
                          <TriangleAlert className="size-3" /> Not listed for your game version
                        </div>
                      )}
                      {v.description && <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-relaxed text-ink-300" title={v.description}>{v.description}</p>}
                      {v.dependencies && v.dependencies.length > 0 && !v.primary && (
                        <div className="mt-1.5 text-[11px] text-ink-400">Needs: {v.dependencies.map((x) => x.name).join(', ')}</div>
                      )}
                      <Button
                        size="sm"
                        variant={v.primary ? 'primary' : 'secondary'}
                        className="mt-2.5 w-full"
                        disabled={started.has(v.id) || Boolean(busy)}
                        loading={busy === v.id}
                        icon={<Download className="size-3.5" />}
                        title={v.manualOnly ? 'The file page opens in NexusForge\'s download panel; click its download button once and NexusForge installs the file.' : undefined}
                        onClick={() => void install(v)}
                      >
                        {started.has(v.id) ? 'Started, see Downloads' : game ? 'Install' : 'Download'}
                      </Button>
                    </motion.div>
                  )
                })}
                {d && !d.versions.length && <p className="text-[12.5px] text-ink-400">No downloadable files.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
