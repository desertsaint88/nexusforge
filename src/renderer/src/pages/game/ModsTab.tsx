import { useMemo, useState } from 'react'
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd'
import { motion } from 'framer-motion'
import { Compass, Ellipsis, FolderOpen, GripVertical, Link2, PackagePlus, Pencil, Power, PowerOff, Puzzle, Rocket, Trash, Undo2, Zap } from 'lucide-react'
import type { Game, InstalledMod } from '@shared/types'
import { missingRequirements } from '@shared/deps'
import { activeProfileOf, useMods } from '../../store/mods'
import { useLibrary } from '../../store/library'
import { confirm, useNav } from '../../store/ui'
import { invoke } from '../../lib/api'
import { cn, formatBytes, relativeTime } from '../../lib/format'
import { Badge, Button, ProgressBar, SearchInput, Toggle } from '../../components/ui'
import { MenuItem, MenuSeparator, Popover, Select } from '../../components/Popover'
import { EmptyState } from '../../components/Chrome'
import { ModSettingsModal } from '../../modals/ModSettingsModal'
import { DetectedMods } from './DetectedMods'

const SOURCE_LABEL: Record<string, string> = {
  nexus: 'Nexus',
  thunderstore: 'Thunderstore',
  modrinth: 'Modrinth',
  steamworkshop: 'Workshop',
  modio: 'mod.io',
  curseforge: 'CurseForge',
  moddb: 'ModDB',
  beamng: 'BeamNG',
  frameworks: 'Mod loader'
}

function ModThumb({ mod }: { mod: InstalledMod }) {
  const [failed, setFailed] = useState(false)
  if (mod.thumbnail && !failed) return <img src={mod.thumbnail} onError={() => setFailed(true)} alt="" className="size-10 shrink-0 rounded-xl object-cover" draggable={false} />
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.04] text-ink-300">
      <Puzzle className="size-4.5" />
    </div>
  )
}

export function ModsTab({ game, onShowConflicts }: { game: Game; onShowConflicts(): void }) {
  const navigate = useNav((s) => s.navigate)
  const state = useMods((s) => s.byGame[game.id])
  const deploying = useMods((s) => s.deploying[game.id])
  const installing = useMods((s) => s.installing[game.id] ?? 0)
  const { toggle, reorder, install, remove, deploy, purge, switchProfile, setAll } = useMods()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<InstalledMod | undefined>()

  const profile = activeProfileOf(state)
  const modsById = useMemo(() => new Map((state?.mods ?? []).map((m) => [m.id, m])), [state?.mods])
  const ordered = useMemo(() => (profile?.order ?? []).map((id) => modsById.get(id)).filter(Boolean) as InstalledMod[], [profile?.order, modsById])
  const q = query.trim().toLowerCase()
  const shown = q ? ordered.filter((m) => m.name.toLowerCase().includes(q) || (m.author ?? '').toLowerCase().includes(q)) : ordered
  const perMod = state?.conflicts?.perMod ?? {}
  const enabledSet = useMemo(() => new Set(profile?.enabled ?? []), [profile?.enabled])
  const status = state?.status
  const outsideCount = useLibrary((s) => s.detected[game.id]?.mods.filter((m) => m.kind !== 'loader' && !m.managedModId).length ?? 0)

  const onDragEnd = (r: DropResult) => {
    if (!r.destination || r.destination.index === r.source.index) return
    void reorder(game.id, r.source.index, r.destination.index)
  }

  const addFiles = async () => {
    const files = await invoke('app:pickFiles', {
      title: `Install mods for ${game.name}`,
      filters: [
        { name: 'Mod archives', extensions: ['zip', '7z', 'rar', 'tar', 'gz'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (files.length) await install(game.id, files)
  }

  const progress = typeof deploying === 'object' ? deploying : undefined
  const needsDeploy = status && !status.inSync

  if (!state?.loaded) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-16 rounded-2xl" />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={state.activeId}
          width={240}
          className="w-[210px]"
          options={state.profiles.map((p) => ({ value: p.id, label: p.name, hint: `${p.enabled.length}` }))}
          onChange={(id) => void switchProfile(game.id, id)}
        />
        <SearchInput value={query} onChange={setQuery} placeholder="Filter mods" className="w-60" />
        <div className="flex-1" />
        <Button icon={<Compass className="size-4" />} onClick={() => navigate({ name: 'browse', gameId: game.id })}>
          Browse
        </Button>
        <Button icon={<PackagePlus className="size-4" />} onClick={addFiles} loading={installing > 0}>
          {installing > 0 ? `Installing ${installing}…` : 'Install from file'}
        </Button>
        <Button
          variant="primary"
          icon={<Rocket className="size-4" />}
          onClick={() => void deploy(game.id)}
          loading={Boolean(deploying)}
          className={cn(needsDeploy && !deploying && 'ring-1 ring-[color-mix(in_oklab,var(--nf-accent)_55%,transparent)] ring-offset-2 ring-offset-ink-950')}
        >
          {deploying ? 'Deploying…' : needsDeploy ? 'Deploy changes' : 'Deploy'}
        </Button>
        <Popover
          align="end"
          width={250}
          trigger={({ toggle: t }) => (
            <Button variant="ghost" className="px-2.5" onClick={t} aria-label="More">
              <Ellipsis className="size-4" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Power />} onClick={() => (close(), void setAll(game.id, true))}>
                Enable all mods
              </MenuItem>
              <MenuItem icon={<PowerOff />} onClick={() => (close(), void setAll(game.id, false))}>
                Disable all mods
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<FolderOpen />} onClick={() => (close(), void invoke('mods:openFolder', game.id))}>
                Open mod storage
              </MenuItem>
              <MenuItem icon={<FolderOpen />} onClick={() => (close(), void invoke('app:openPath', game.modding.targetDir))}>
                Open deploy folder
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Undo2 />}
                onClick={async () => {
                  close()
                  if (
                    await confirm({
                      title: 'Purge deployed mods?',
                      message: `Removes every file NexusForge deployed into ${game.name} and restores the original game files. Your installed mods stay in the library.`,
                      confirmLabel: 'Purge',
                      danger: true
                    })
                  )
                    void purge(game.id)
                }}
              >
                Purge from game folder
              </MenuItem>
            </>
          )}
        </Popover>
      </div>

      {(progress || (deploying && !progress)) && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="glass mb-4 rounded-2xl px-4 py-3">
          <div className="mb-2 flex justify-between text-[12.5px] text-ink-300">
            <span className="font-medium text-ink-100 capitalize">{progress?.phase ?? 'Preparing'}…</span>
            {progress && progress.total > 0 && (
              <span className="tabular-nums">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
            )}
          </div>
          <ProgressBar value={progress && progress.total ? progress.done / progress.total : undefined} indeterminate={!progress || !progress.total} />
        </motion.div>
      )}

      {status?.deployed && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
          <Link2 className="size-3.5" />
          Deployed {relativeTime(status.deployedAt)} ·
          {status.methods.symlink > 0 && <Badge tone="success">{status.methods.symlink.toLocaleString()} symlinked</Badge>}
          {status.methods.hardlink > 0 && <Badge tone="info">{status.methods.hardlink.toLocaleString()} hardlinked</Badge>}
          {status.methods.copy > 0 && <Badge>{status.methods.copy.toLocaleString()} copied</Badge>}
          {needsDeploy && <Badge tone="warning">changes pending</Badge>}
        </div>
      )}

      {!ordered.length ? (
        <EmptyState
          icon={<PackagePlus />}
          title={outsideCount ? 'No mods managed by NexusForge yet' : 'No mods yet'}
          message={
            <>
              {outsideCount ? `${outsideCount} mod${outsideCount === 1 ? ' is' : 's are'} already installed in the game folder (listed below). ` : ''}
              Drop mod archives anywhere on this window, install from a file, or browse online sources. Mods are kept in NexusForge's storage and linked into{' '}
              <span className="font-mono text-ink-200">{game.modding.targetDir}</span> when you deploy.
            </>
          }
        >
          <Button variant="primary" icon={<Compass className="size-4" />} onClick={() => navigate({ name: 'browse', gameId: game.id })}>
            Browse mods
          </Button>
          <Button icon={<PackagePlus className="size-4" />} onClick={addFiles}>
            Install from file
          </Button>
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 grid grid-cols-[28px_36px_40px_minmax(0,1fr)_120px_90px_36px] items-center gap-3 px-4 text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">
            <span />
            <span>#</span>
            <span />
            <span>Mod</span>
            <span>Conflicts</span>
            <span className="text-right">Size</span>
            <span />
          </div>
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId={`mods-${game.id}`}>
              {(drop) => (
                <div ref={drop.innerRef} {...drop.droppableProps} className="space-y-1.5">
                  {shown.map((mod, i) => {
                    const index = ordered.indexOf(mod)
                    const on = profile?.enabled.includes(mod.id) ?? false
                    const c = perMod[mod.id]
                    return (
                      // While filtering, dragging is off and indices must stay consecutive for the DnD library.
                      <Draggable key={mod.id} draggableId={mod.id} index={q ? i : index} isDragDisabled={Boolean(q)}>
                        {(drag, snap) => (
                          <div
                            ref={drag.innerRef}
                            {...drag.draggableProps}
                            className={cn(
                              'grid grid-cols-[28px_36px_40px_minmax(0,1fr)_120px_90px_36px] items-center gap-3 rounded-2xl border px-4 py-2.5 transition-[background,border-color,box-shadow,opacity]',
                              snap.isDragging
                                ? 'glass-strong border-white/[0.16] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.95)]'
                                : 'border-white/[0.05] bg-white/[0.025] hover:border-white/[0.1] hover:bg-white/[0.045]',
                              !on && !snap.isDragging && 'opacity-55'
                            )}
                          >
                            <span {...drag.dragHandleProps} className={cn('flex h-8 items-center text-ink-500', q ? 'cursor-not-allowed' : 'cursor-grab hover:text-ink-200 active:cursor-grabbing')} aria-label="Drag to reorder">
                              <GripVertical className="size-4" />
                            </span>
                            <span className="font-mono text-[12px] text-ink-400 tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                            <Toggle checked={on} onChange={(v) => void toggle(game.id, mod.id, v)} label={`Enable ${mod.name}`} />
                            <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => setEditing(mod)}>
                              <ModThumb mod={mod} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-[14px] font-semibold text-ink-100">{mod.name}</span>
                                  {mod.version && <span className="shrink-0 font-mono text-[11px] text-ink-400">v{mod.version}</span>}
                                </div>
                                <div className="mt-0.5 flex items-center gap-2 truncate text-[12px] text-ink-400">
                                  {mod.source && <Badge className="h-4.5 text-[10px]">{SOURCE_LABEL[mod.source.sourceId] ?? mod.source.sourceId.replace(/^(feed|plugin):/, '')}</Badge>}
                                  {mod.author && <span className="truncate">by {mod.author}</span>}
                                  <span>{mod.fileCount.toLocaleString()} files</span>
                                  {(() => {
                                    const missing = on ? missingRequirements(mod, state.mods, enabledSet) : []
                                    if (!missing.length) return null
                                    const names = missing.map((x) => `${x.ref.name ?? x.ref.modId}${x.disabled ? ' (disabled)' : ''}`).join(', ')
                                    return (
                                      <Badge tone="warning" className="h-4.5 text-[10px]">
                                        <span title={`Needs: ${names}`}>needs {missing.length === 1 ? (missing[0].ref.name ?? 'a mod') : `${missing.length} mods`}</span>
                                      </Badge>
                                    )
                                  })()}
                                </div>
                              </div>
                            </button>
                            <div>
                              {c && on ? (
                                <button onClick={onShowConflicts} className="flex items-center gap-1.5 text-[12px]" title="Open conflict resolver">
                                  <Zap className={cn('size-3.5', c.loses ? 'text-amber-400' : 'text-emerald-400')} />
                                  {c.wins > 0 && <span className="text-emerald-300">{c.wins} win</span>}
                                  {c.loses > 0 && <span className="text-amber-300">{c.loses} lose</span>}
                                </button>
                              ) : (
                                <span className="text-[12px] text-ink-500">—</span>
                              )}
                            </div>
                            <span className="text-right text-[12px] text-ink-300 tabular-nums">{formatBytes(mod.sizeBytes)}</span>
                            <Popover
                              align="end"
                              width={220}
                              trigger={({ toggle: t }) => (
                                <button onClick={t} className="flex size-8 items-center justify-center rounded-lg text-ink-400 hover:bg-white/[0.07] hover:text-ink-100" aria-label="Mod actions">
                                  <Ellipsis className="size-4" />
                                </button>
                              )}
                            >
                              {(close) => (
                                <>
                                  <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(mod))}>
                                    Details & content folder
                                  </MenuItem>
                                  <MenuItem icon={<FolderOpen />} onClick={() => (close(), void invoke('mods:openFolder', game.id, mod.id))}>
                                    Open mod folder
                                  </MenuItem>
                                  {mod.source && SOURCE_LABEL[mod.source.sourceId] && (
                                    <MenuItem icon={<Compass />} onClick={() => (close(), void invoke('sources:openPage', mod.source!.sourceId, mod.source!.modId, game.id))}>
                                      Open mod page
                                    </MenuItem>
                                  )}
                                  <MenuSeparator />
                                  <MenuItem
                                    danger
                                    icon={<Trash />}
                                    onClick={async () => {
                                      close()
                                      if (
                                        await confirm({
                                          title: `Remove ${mod.name}?`,
                                          message: 'Its files are deleted from mod storage. If the mod is deployed, it is removed from the game folder first.',
                                          confirmLabel: 'Remove mod',
                                          danger: true
                                        })
                                      )
                                        void remove(game.id, mod.id)
                                    }}
                                  >
                                    Remove mod
                                  </MenuItem>
                                </>
                              )}
                            </Popover>
                          </div>
                        )}
                      </Draggable>
                    )
                  })}
                  {drop.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
          <p className="mt-4 text-[12px] text-ink-400">Drag to change the load order. Mods lower in the list win when two mods contain the same file.</p>
        </>
      )}

      <DetectedMods game={game} />

      <ModSettingsModal game={game} mod={editing} onClose={() => setEditing(undefined)} />
    </div>
  )
}
