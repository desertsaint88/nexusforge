import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Download, ExternalLink, ThumbsUp, Clock, Tag, CircleAlert } from 'lucide-react'
import type { ModDetails, ModSearchResult } from '@shared/types'
import { invoke } from '../lib/api'
import { cn, formatBytes, formatCount, relativeTime } from '../lib/format'
import { useDownloads } from '../store/downloads'
import { useLibrary } from '../store/library'
import { Modal } from '../components/Modal'
import { Badge, Button, Spinner } from '../components/ui'

export function ModDetailsModal({ result, gameId, onClose }: { result?: ModSearchResult; gameId?: string; onClose(): void }) {
  const [details, setDetails] = useState<ModDetails | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [started, setStarted] = useState<Set<string>>(new Set())
  const start = useDownloads((s) => s.start)
  const game = useLibrary((s) => s.games.find((g) => g.id === gameId))

  useEffect(() => {
    if (!result) return
    let alive = true
    setDetails(undefined)
    setError(undefined)
    setStarted(new Set())
    invoke('sources:details', result.sourceId, result.id, gameId)
      .then((d) => alive && setDetails(d))
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [result, gameId])

  const d = details
  const header = d?.images[0] ?? result?.thumbnail

  const download = async (versionId: string, version?: string) => {
    if (!result) return
    const item = await start({
      sourceId: result.sourceId,
      modId: result.id,
      versionId,
      gameId,
      name: d?.name ?? result.name,
      version,
      author: d?.author ?? result.author,
      summary: d?.summary ?? result.summary,
      thumbnail: d?.thumbnail ?? result.thumbnail
    })
    if (item) setStarted(new Set([...started, versionId]))
  }

  return (
    <Modal open={Boolean(result)} onClose={onClose} width="max-w-3xl" bodyClassName="!px-0 !pb-0">
      {result && (
        <div className="flex max-h-[80vh] flex-col">
          <div className={cn('relative shrink-0 overflow-hidden', header ? 'h-52' : 'h-32')}>
            {header ? (
              <>
                <img src={header} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl" draggable={false} />
                <img src={header} alt="" className="absolute inset-0 size-full object-contain" draggable={false} />
              </>
            ) : (
              <div className="accent-gradient absolute inset-0 opacity-25" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-[#0f1016] via-[#0f1016]/40 to-transparent" />
            <div className="absolute inset-x-6 bottom-4">
              <h2 className="text-2xl font-bold tracking-tight text-white drop-shadow">{d?.name ?? result.name}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12.5px] text-ink-200">
                {(d?.author ?? result.author) && <span>by {d?.author ?? result.author}</span>}
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

          <div className="grid min-h-0 flex-1 grid-cols-[1fr_300px] gap-0 overflow-hidden">
            <div className="min-h-0 overflow-y-auto px-6 py-5">
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
              {!game && <p className="mb-3 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">Pick a game at the top of the page to install directly. Otherwise the file is only downloaded.</p>}
              {!d && !error && <Spinner />}
              <div className="space-y-2">
                {d?.versions.slice(0, 40).map((v, i) => (
                  <motion.div key={v.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
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
                    <Button
                      size="sm"
                      variant={v.primary ? 'primary' : 'secondary'}
                      className="mt-2.5 w-full"
                      disabled={started.has(v.id)}
                      icon={v.manualOnly ? <ExternalLink className="size-3.5" /> : <Download className="size-3.5" />}
                      onClick={() => void download(v.id, v.version)}
                    >
                      {started.has(v.id) ? 'Started, see Downloads' : v.manualOnly ? 'Download on website' : game ? `Install to ${game.name.length > 18 ? 'game' : game.name}` : 'Download'}
                    </Button>
                  </motion.div>
                ))}
                {d && !d.versions.length && <p className="text-[12.5px] text-ink-400">No downloadable files.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
