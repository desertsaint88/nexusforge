import { useEffect, useMemo, useState } from 'react'
import { FileArchive, FolderOpen, Puzzle } from 'lucide-react'
import type { Game, InstalledMod, ModFileEntry } from '@shared/types'
import { invoke } from '../lib/api'
import { cn, formatBytes, relativeTime } from '../lib/format'
import { toast } from '../store/ui'
import { useMods } from '../store/mods'
import { Modal } from '../components/Modal'
import { Badge, Button, Field, Input, SearchInput, Spinner } from '../components/ui'
import { Select } from '../components/Popover'

export function ModSettingsModal({ game, mod, onClose }: { game: Game; mod?: InstalledMod; onClose(): void }) {
  const load = useMods((s) => s.load)
  const info = useMods((s) => s.integration[game.id])
  const targetLabel = (id: string) => info?.targets.find((t) => t.id === id)?.label ?? (id === 'game' ? 'Game folder' : id)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [root, setRoot] = useState('')
  const [roots, setRoots] = useState<string[]>([])
  const [files, setFiles] = useState<ModFileEntry[] | undefined>()
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!mod) return
    setName(mod.name)
    setVersion(mod.version ?? '')
    setRoot(mod.rootPath)
    setFiles(undefined)
    setQuery('')
    void invoke('mods:rootCandidates', game.id, mod.id).then(setRoots)
  }, [mod, game.id])

  useEffect(() => {
    if (!mod) return
    let alive = true
    setFiles(undefined)
    // Preview what the chosen content folder would deploy.
    const preview = root === mod.rootPath ? invoke('mods:files', game.id, mod.id) : Promise.resolve(undefined)
    void preview.then((f) => alive && setFiles(f))
    return () => {
      alive = false
    }
  }, [mod, root, game.id])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (files ?? []).filter((f) => !q || f.rel.toLowerCase().includes(q))
  }, [files, query])

  if (!mod) return <Modal open={false} onClose={onClose}>{null}</Modal>

  const save = async () => {
    setSaving(true)
    try {
      await invoke('mods:update', game.id, mod.id, { name, version, rootPath: root })
      await load(game.id)
      toast.success('Mod updated', root !== mod.rootPath ? 'Deploy again to apply the new content folder.' : undefined)
      onClose()
    } catch (err) {
      toast.error('Could not save', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(mod)}
      onClose={onClose}
      icon={<Puzzle className="size-5" />}
      title={mod.name}
      subtitle={
        <>
          Installed {relativeTime(mod.installedAt)} · {mod.fileCount.toLocaleString()} files · {formatBytes(mod.sizeBytes)}
        </>
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" icon={<FolderOpen className="size-4" />} className="mr-auto" onClick={() => void invoke('mods:openFolder', game.id, mod.id)}>
            Open folder
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {mod.summary && <p className="selectable text-[13px] leading-relaxed text-ink-300">{mod.summary}</p>}
        <div className="flex flex-wrap gap-1.5">
          {mod.author && <Badge>by {mod.author}</Badge>}
          {mod.source && <Badge tone="accent">{mod.source.sourceId}</Badge>}
          {mod.originalFile && (
            <Badge>
              <FileArchive className="size-3" /> {mod.originalFile}
            </Badge>
          )}
        </div>
        {(mod.checks ?? []).length > 0 && (
          <div className="space-y-1.5 rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
            {(mod.checks ?? []).map((c) => (
              <p key={c.message} className={cn('text-[12.5px] leading-relaxed', c.level === 'error' ? 'text-rose-200/90' : c.level === 'warning' ? 'text-amber-200/90' : 'text-ink-300')}>
                {c.level === 'error' ? "Can't deploy: " : c.level === 'warning' ? 'Warning: ' : ''}
                {c.message}
              </p>
            ))}
          </div>
        )}
        {(mod.routes ?? []).length > 0 && (
          <div className="text-[12.5px] leading-relaxed text-ink-300">
            <div className="mb-1 font-medium text-ink-200">Where it goes</div>
            {(mod.routes ?? []).map((r) => (
              <div key={`${r.from}->${r.target}:${r.to}`} className="flex gap-2 font-mono text-[11.5px]">
                <span className="truncate text-ink-400">{r.from || '(mod root)'}</span>
                <span className="text-ink-500">→</span>
                <span className="truncate">
                  {targetLabel(r.target)}
                  {r.to ? ` / ${r.to}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[1fr_160px] gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Version">
            <Input mono value={version} onChange={(e) => setVersion(e.target.value)} placeholder="—" />
          </Field>
        </div>
        <Field
          label="Content folder"
          hint={
            <>
              The folder inside the mod whose contents go into the game. NexusForge lays mods out by the game's rules; picking a folder by hand maps it onto <span className="font-mono text-ink-300">{info?.targets.find((t) => t.id === 'game')?.dir ?? game.modding.targetDir}</span> as it is, so only do that if a mod lands in the wrong place.
            </>
          }
        >
          <Select value={root} width={560} className="w-full font-mono text-[12.5px]" options={roots.map((r) => ({ value: r, label: r || '(mod root)' }))} onChange={setRoot} />
        </Field>
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[12.5px] font-medium text-ink-200">Files that will be deployed</div>
            <SearchInput value={query} onChange={setQuery} placeholder="Filter" className="w-56" />
          </div>
          <div className="h-56 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/30 p-2">
            {root !== mod.rootPath ? (
              <div className="p-3 text-[12.5px] text-ink-400">Save to rescan the new content folder.</div>
            ) : !files ? (
              <div className="p-3">
                <Spinner />
              </div>
            ) : (
              <>
                {shown.slice(0, 400).map((f) => (
                  <div key={f.rel} className="flex justify-between gap-3 rounded-md px-2 py-1 font-mono text-[11.5px] text-ink-300 hover:bg-white/[0.04]">
                    <span className="selectable truncate">{f.rel}</span>
                    <span className="shrink-0 text-ink-500">{formatBytes(f.size)}</span>
                  </div>
                ))}
                {shown.length > 400 && <div className="px-2 py-1 text-[11.5px] text-ink-500">…and {(shown.length - 400).toLocaleString()} more</div>}
              </>
            )}
          </div>
        </div>
        {(mod.skipped ?? []).length > 0 && (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-200">Left out of the game ({(mod.skipped ?? []).length})</div>
            <div className="max-h-32 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/30 p-2">
              {(mod.skipped ?? []).slice(0, 200).map((s) => (
                <div key={s.path} className="flex justify-between gap-3 rounded-md px-2 py-1 text-[11.5px] hover:bg-white/[0.04]">
                  <span className="selectable truncate font-mono text-ink-300">{s.path}</span>
                  <span className="shrink-0 text-ink-500">{s.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
