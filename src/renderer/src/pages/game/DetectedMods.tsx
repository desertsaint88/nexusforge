import { useMemo, useState } from 'react'
import { ChevronDown, FolderOpen, RefreshCw, ScanSearch, ShieldCheck } from 'lucide-react'
import type { DetectedMod, DetectedModKind, Game } from '@shared/types'
import { useLibrary } from '../../store/library'
import { invoke } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button, SearchInput } from '../../components/ui'

const KIND_LABEL: Record<DetectedModKind, string> = {
  bepinex: 'BepInEx plugin',
  melonloader: 'MelonLoader mod',
  ue4ss: 'UE4SS mod',
  pak: '.pak mod',
  'gmod-addon': 'Addon',
  beamng: 'BeamNG mod',
  workshop: 'Workshop',
  modio: 'mod.io',
  plugin: 'Plugin',
  script: 'Script',
  scenery: 'Scenery',
  aircraft: 'Aircraft',
  contraption: 'Contraption',
  bo3: 'Mod / map',
  jar: 'Mod jar',
  loader: 'Mod loader',
  folder: 'Mod folder'
}

function Row({ mod }: { mod: DetectedMod }) {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_150px_160px_32px] items-center gap-3 rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-2', mod.enabled === false && 'opacity-55')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-100">{mod.name}</span>
          {mod.version && <span className="shrink-0 font-mono text-[11px] text-ink-400">v{mod.version.replace(/^v/i, '')}</span>}
          {mod.managedModId && (
            <Badge className="h-4.5 text-[10px]">
              <ShieldCheck className="size-3" /> NexusForge
            </Badge>
          )}
          {mod.enabled === false && <Badge className="h-4.5 text-[10px]">off</Badge>}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-ink-500" title={mod.path}>
          {mod.path}
        </div>
      </div>
      <span className="truncate text-[12px] text-ink-300">{KIND_LABEL[mod.kind]}</span>
      <span className="truncate text-[11.5px] text-ink-400" title="How NexusForge recognized it">
        {mod.detectedBy}
        {mod.author ? ` · ${mod.author}` : ''}
      </span>
      <button onClick={() => void invoke('app:showItem', mod.path)} className="flex size-8 items-center justify-center rounded-lg text-ink-400 hover:bg-white/[0.07] hover:text-ink-100" aria-label="Show in folder" title="Show in folder">
        <FolderOpen className="size-4" />
      </button>
    </div>
  )
}

/**
 * Everything installed in the game, found by reading its folders: mod loaders, plugins, addons, paks, Workshop
 * items, BeamNG zips… including mods installed by hand or by other tools.
 */
export function DetectedMods({ game }: { game: Game }) {
  const info = useLibrary((s) => s.detected[game.id])
  const [scanning, setScanning] = useState(false)
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(60)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const mods = (info?.mods ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q))
    const loaders = mods.filter((m) => m.kind === 'loader')
    const outside = mods.filter((m) => m.kind !== 'loader' && !m.managedModId)
    const managed = mods.filter((m) => m.kind !== 'loader' && m.managedModId)
    return { loaders, outside, managed, total: mods.length }
  }, [info, query])

  const rescan = async () => {
    setScanning(true)
    try {
      await invoke('mods:rescanInstalled', game.id)
    } finally {
      setScanning(false)
    }
  }

  const count = (info?.mods.filter((m) => m.kind !== 'loader').length ?? 0) || 0

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left">
          <ScanSearch className="size-4 text-ink-300" />
          <h3 className="text-[14.5px] font-semibold tracking-tight text-ink-100">Installed in the game folder</h3>
          <span className="text-[12px] text-ink-400 tabular-nums">{info ? count : '…'}</span>
          <ChevronDown className={cn('size-4 text-ink-400 transition-transform', !open && '-rotate-90')} />
        </button>
        {info?.support.length ? (
          <div className="flex flex-wrap gap-1.5">
            {info.support.map((s) => (
              <Badge key={s} className="text-[10.5px]">
                {s}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="flex-1" />
        {info && <span className="text-[11.5px] text-ink-500">checked {relativeTime(info.scannedAt)}</span>}
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-3.5', scanning && 'animate-spin')} />} disabled={scanning} onClick={() => void rescan()}>
          {scanning ? 'Scanning…' : 'Scan again'}
        </Button>
      </div>

      {open &&
        (!info ? (
          <p className="text-[12.5px] text-ink-400">NexusForge is reading the game folder…</p>
        ) : !info.mods.length ? (
          <p className="rounded-xl border border-white/[0.04] bg-white/[0.015] px-4 py-3 text-[12.5px] leading-relaxed text-ink-400">
            No mods found in {game.name}'s folders.{' '}
            {info.supported ? 'The game can be modded: browse mods or drop an archive here.' : 'NexusForge found no mod loader, mod folder or known mod setup for this game.'}
          </p>
        ) : (
          <div>
            {groups.total > 12 && <SearchInput value={query} onChange={setQuery} placeholder="Filter installed mods" className="mb-3 w-72" />}
            {groups.loaders.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {groups.loaders.map((m) => (
                  <Row key={m.key} mod={m} />
                ))}
              </div>
            )}
            {groups.outside.length > 0 && (
              <>
                <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">Installed outside NexusForge · {groups.outside.length}</div>
                <div className="space-y-1.5">
                  {groups.outside.slice(0, limit).map((m) => (
                    <Row key={m.key} mod={m} />
                  ))}
                </div>
                {groups.outside.length > limit && (
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => setLimit(limit + 200)}>
                    Show {Math.min(200, groups.outside.length - limit)} more
                  </Button>
                )}
              </>
            )}
            {groups.managed.length > 0 && (
              <>
                <div className="mt-4 mb-1.5 px-1 text-[11px] font-semibold tracking-[0.1em] text-ink-400 uppercase">Deployed by NexusForge · {groups.managed.length}</div>
                <div className="space-y-1.5">
                  {groups.managed.slice(0, 40).map((m) => (
                    <Row key={m.key} mod={m} />
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
    </section>
  )
}
