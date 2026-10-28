import { useEffect, useState, type ReactNode } from 'react'
import { EyeOff, FileCode, FolderOpen, Image, ImagePlus, Link2, RefreshCw, ShieldAlert, ShieldCheck, Trash, Wand2, Eye } from 'lucide-react'
import type { DeployStrategy, Game, SourceGameBinding, SourceInfo } from '@shared/types'
import { invoke } from '../../lib/api'
import { useMods } from '../../store/mods'
import { confirm, toast } from '../../store/ui'
import { useLibrary } from '../../store/library'
import { cn } from '../../lib/format'
import { Badge, Button, Card, Field, Input, Segmented, Spinner } from '../../components/ui'
import { Select } from '../../components/Popover'

function Section({ title, subtitle, children, icon }: { title: string; subtitle?: ReactNode; children: ReactNode; icon: ReactNode }) {
  return (
    <Card className="p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-white/[0.06] text-ink-200 [&>svg]:size-4.5">{icon}</div>
        <div>
          <h3 className="text-[15px] font-semibold text-ink-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-300">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-5">{children}</div>
    </Card>
  )
}

function PathField({ label, value, onPick, onChange, hint, pickLabel = 'Browse' }: { label: string; value: string; onPick(): void; onChange(v: string): void; hint?: ReactNode; pickLabel?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input mono value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onChange(draft)} onKeyDown={(e) => e.key === 'Enter' && draft !== value && onChange(draft)} />
        <Button icon={<FolderOpen className="size-4" />} onClick={onPick}>
          {pickLabel}
        </Button>
      </div>
    </Field>
  )
}

function SourceBinding({ game, source }: { game: Game; source: SourceInfo }) {
  const update = useLibrary((s) => s.update)
  const [options, setOptions] = useState<SourceGameBinding[] | undefined>()
  const [custom, setCustom] = useState('')
  const current = game.modding.sources[source.id]

  useEffect(() => {
    let alive = true
    invoke('sources:bindings', source.id, game.id)
      .then((o) => alive && setOptions(o))
      .catch(() => alive && setOptions([]))
    return () => {
      alive = false
    }
  }, [source.id, game.id])

  const effective = current ?? options?.[0]?.value
  const list = [...(options ?? [])]
  if (current && !list.some((o) => o.value === current)) list.unshift({ value: current, label: current })

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
      <div className="w-36 shrink-0">
        <div className="text-[13px] font-semibold text-ink-100">{source.name}</div>
        <div className="text-[11.5px] text-ink-400">{source.bindingLabel}</div>
      </div>
      {options === undefined ? (
        <Spinner />
      ) : (
        <Select
          value={effective}
          width={320}
          className="min-w-0 flex-1"
          placeholder="Not set"
          options={list.map((o) => ({ value: o.value, label: o.label, hint: o.value }))}
          onChange={(v) => void update(game.id, { modding: { ...game.modding, sources: { ...game.modding.sources, [source.id]: v } } })}
        />
      )}
      <Input
        mono
        className="w-44"
        placeholder="custom id"
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom.trim()) {
            void update(game.id, { modding: { ...game.modding, sources: { ...game.modding.sources, [source.id]: custom.trim() } } })
            setCustom('')
          }
        }}
      />
      {current ? <Badge tone="accent">set</Badge> : effective ? <Badge>auto</Badge> : <Badge tone="warning">none</Badge>}
    </div>
  )
}

export function GameSettingsTab({ game, onRemoved }: { game: Game; onRemoved(): void }) {
  const update = useLibrary((s) => s.update)
  const state = useMods((s) => s.byGame[game.id])
  const probe = useMods((s) => s.probe)
  const caps = state?.caps
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [probing, setProbing] = useState(false)
  const [refetching, setRefetching] = useState(false)

  useEffect(() => {
    void invoke('sources:list').then((s) => setSources(s.filter((x) => x.bindingLabel && x.enabled)))
  }, [])

  useEffect(() => {
    setProbing(true)
    void probe(game.id).finally(() => setProbing(false))
  }, [game.id, game.modding.targetDir, probe])

  const setModding = (patch: Partial<Game['modding']>) => update(game.id, { modding: { ...game.modding, ...patch } })

  const strategies: Array<{ value: DeployStrategy; label: ReactNode }> = [
    { value: 'auto', label: <>Automatic</> },
    { value: 'hardlink', label: <>Hardlink</> },
    { value: 'copy', label: <>Copy</> },
    { value: 'symlink', label: <>Symlink</> }
  ]
  const info = useMods((s) => s.integration[game.id])
  const extraTargets = (info?.targets ?? []).filter((t) => t.id !== 'game')

  // Symlinks are the only method that can be unavailable; every other choice works (copies as the fallback).
  const chosenOk = !caps ? undefined : game.modding.strategy === 'symlink' ? caps.symlink : true

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Section icon={<FileCode />} title="Game" subtitle="How NexusForge starts this game.">
        <Field label="Name">
          <Input defaultValue={game.name} onBlur={(e) => e.target.value.trim() && e.target.value !== game.name && void update(game.id, { name: e.target.value })} />
        </Field>
        <PathField
          label="Executable"
          value={game.exePath ?? ''}
          hint={game.launch.kind === 'url' ? `Launched through ${game.platform === 'steam' ? 'Steam' : 'Epic'} (${game.launch.url.split('/')[0]}//…) so playtime and overlays keep working.` : game.launch.kind === 'appx' ? 'Launched as a Windows Store app.' : undefined}
          onChange={(v) => void update(game.id, { exePath: v })}
          onPick={async () => {
            const f = await invoke('app:pickFile', { title: 'Game executable', filters: [{ name: 'Programs', extensions: ['exe'] }] })
            if (f) void update(game.id, { exePath: f })
          }}
        />
        {game.launch.kind === 'exe' && (
          <Field label="Launch arguments">
            <Input mono defaultValue={game.launchArgs ?? ''} placeholder="-windowed" onBlur={(e) => e.target.value !== (game.launchArgs ?? '') && void update(game.id, { launchArgs: e.target.value })} />
          </Field>
        )}
        <Field label="Install folder">
          <div className="flex gap-2">
            <Input mono readOnly value={game.installDir} />
            <Button icon={<FolderOpen className="size-4" />} onClick={() => void invoke('app:openPath', game.installDir)}>
              Open
            </Button>
          </div>
        </Field>
      </Section>

      <Section
        icon={<Link2 />}
        title="Mod deployment"
        subtitle="Mods stay in NexusForge's storage. Deploying links or copies them into the folder below, and purging removes them again."
      >
        {info && info.integrationId !== 'generic' ? (
          <Field
            label="Deploy into"
            hint={`${info.name}: NexusForge puts each kind of file where ${game.name} loads it, so this is not a single folder. If the game moves, rescan the library; the next deploy moves the files.`}
          >
            <div className="space-y-1.5 rounded-xl border border-white/[0.06] bg-black/20 px-3.5 py-2.5">
              {(info.targets ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-3 text-[12.5px]">
                  <span className="w-36 shrink-0 text-ink-300">{t.label}</span>
                  <button className="min-w-0 truncate text-left font-mono text-[11.5px] text-ink-400 hover:text-ink-100" title={t.dir} onClick={() => void invoke('app:openPath', t.dir)}>
                    {t.dir}
                  </button>
                </div>
              ))}
            </div>
          </Field>
        ) : (
          <PathField
            label="Deploy into"
            value={game.modding.targetDir}
            hint={`Usually the game folder, or its Data / Mods sub-folder. If you change it, the next deploy cleans the old location first.${extraTargets.length ? ` Also used: ${extraTargets.map((t) => t.label).join(', ')}.` : ''}`}
            onChange={(v) => void setModding({ targetDir: v })}
            onPick={async () => {
              const d = await invoke('app:pickFolder', { title: 'Where should mods be deployed?', defaultPath: game.modding.targetDir })
              if (d) void setModding({ targetDir: d })
            }}
          />
        )}
        <Field
          label="Method"
          hint={
            game.modding.strategy === 'auto'
              ? 'Hardlinks when mod storage and the game are on the same drive, copies otherwise. Needs no special Windows rights and no Developer Mode. Saves and worlds are always copied.'
              : game.modding.strategy === 'symlink'
                ? 'Only works when Windows lets this account create symlinks (administrators, or with Developer Mode). If it doesn\'t, NexusForge uses hardlinks and copies instead; the game gets the same files either way, so there is nothing to switch on.'
                : game.modding.strategy === 'hardlink'
                  ? 'Hardlinks use no extra space and need no special rights. On another drive than mod storage (or FAT32/exFAT) files are copied instead.'
                  : 'Copies work everywhere and suit games that reject links, but they duplicate the files on disk.'
          }
        >
          <Segmented value={game.modding.strategy} options={strategies} onChange={(v) => void setModding({ strategy: v })} />
        </Field>
        <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', chosenOk === false ? 'border-amber-400/20 bg-amber-500/8' : 'border-white/[0.06] bg-black/20')}>
          {probing ? <Spinner className="mt-0.5" /> : chosenOk === false ? <ShieldAlert className="mt-0.5 size-4 text-amber-300" /> : <ShieldCheck className="mt-0.5 size-4 text-emerald-300" />}
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={caps?.symlink ? 'success' : 'neutral'}>Symlinks {caps ? (caps.symlink ? 'available' : 'unavailable') : '…'}</Badge>
              <Badge tone={caps?.hardlink ? 'success' : 'neutral'}>Hardlinks {caps ? (caps.hardlink ? 'available' : 'unavailable') : '…'}</Badge>
            </div>
            {caps?.autoMethod && game.modding.strategy === 'auto' && <p className="mt-2 text-ink-200">{caps.autoMethod}</p>}
            {caps && !caps.symlink && caps.symlinkReason && game.modding.strategy === 'symlink' && <p className="mt-2 text-ink-300">{caps.symlinkReason}</p>}
            {caps && !caps.hardlink && caps.hardlinkReason && <p className="mt-1 text-ink-300">{caps.hardlinkReason}</p>}
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => (setProbing(true), void probe(game.id).finally(() => setProbing(false)))}>
            Re-check
          </Button>
        </div>
      </Section>

      {sources.length > 0 && (
        <Section icon={<Wand2 />} title="Mod sources" subtitle="Which game each source should search. NexusForge guesses; pick another entry or type an id if the guess is wrong.">
          {sources.map((s) => (
            <SourceBinding key={s.id} game={game} source={s} />
          ))}
        </Section>
      )}

      <Section icon={<Image />} title="Artwork" subtitle="Use your own images, or look the game up on the Steam store again.">
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<ImagePlus className="size-4" />}
            onClick={async () => {
              const f = await invoke('app:pickFile', { title: 'Cover image (portrait)', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
              if (f) void update(game.id, { customArt: { capsule: f } })
            }}
          >
            Set cover
          </Button>
          <Button
            icon={<ImagePlus className="size-4" />}
            onClick={async () => {
              const f = await invoke('app:pickFile', { title: 'Background image (wide)', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
              if (f) void update(game.id, { customArt: { hero: f } })
            }}
          >
            Set background
          </Button>
          {(game.customArt?.capsule || game.customArt?.hero) && (
            <Button variant="ghost" onClick={() => void update(game.id, { customArt: { capsule: '', hero: '' } })}>
              Reset custom images
            </Button>
          )}
          {game.platform !== 'steam' && (
            <Button
              variant="ghost"
              loading={refetching}
              icon={<RefreshCw className="size-4" />}
              onClick={async () => {
                setRefetching(true)
                try {
                  await invoke('library:fetchArtwork', game.id)
                  toast.success('Artwork updated')
                } catch (err) {
                  toast.error('No artwork found', (err as Error).message)
                } finally {
                  setRefetching(false)
                }
              }}
            >
              Find on Steam store
            </Button>
          )}
        </div>
      </Section>

      <Section icon={<Trash />} title="Library" subtitle="Hide the game, or remove it from NexusForge. The game itself is never uninstalled.">
        <div className="flex flex-wrap gap-2">
          <Button icon={game.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} onClick={() => void update(game.id, { hidden: !game.hidden })}>
            {game.hidden ? 'Show in library' : 'Hide from library'}
          </Button>
          <Button
            variant="danger"
            icon={<Trash className="size-4" />}
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${game.name} from NexusForge?`,
                message:
                  'Deployed mods are purged from the game folder first and the original files restored. Then the game\'s installed mods and profiles are deleted from NexusForge.\n\nThe game itself stays installed.' +
                  (game.platform !== 'manual' ? '\n\nScanned games are hidden instead of deleted, so a rescan doesn\'t bring them back.' : ''),
                confirmLabel: 'Remove',
                danger: true
              })
              if (!ok) return
              try {
                await invoke('library:remove', game.id)
                toast.success(`Removed ${game.name}`)
                onRemoved()
              } catch (err) {
                toast.error('Could not remove game', (err as Error).message)
              }
            }}
          >
            Remove from NexusForge
          </Button>
        </div>
      </Section>
    </div>
  )
}
