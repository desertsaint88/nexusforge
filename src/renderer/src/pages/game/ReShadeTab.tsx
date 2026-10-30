// ReShade for this game: install it (graphics API, build and shader packs are worked out, and can be changed),
// pick the active preset and the overlay key, and see what ReShade did at the last start. NexusForge's own copy is
// downloaded from reshade.me and checked against ReShade's signature; a copy installed by hand is left alone.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, CircleCheck, Cpu, Download, FileText, FolderOpen, Info, Keyboard, Layers, LoaderCircle, Palette, RefreshCw, Sparkles, Trash, TriangleAlert, Wrench } from 'lucide-react'
import type { Game, ReshadeSettingsPatch, ReshadeView } from '@shared/types'
import { invoke, on } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button, Card, IconButton, ProgressBar, Segmented, Toggle } from '../../components/ui'
import { Select } from '../../components/Popover'
import { useMods } from '../../store/mods'
import { useNav, confirm, toast } from '../../store/ui'

function Section({ icon, title, right, children, className }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('px-5 py-4', className)}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-ink-300 [&>svg]:size-4">{icon}</span>
        <h3 className="text-[13.5px] font-semibold text-ink-100">{title}</h3>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </Card>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-white/[0.04] py-3 first:border-t-0 first:pt-0">
      <div className="w-52 shrink-0">
        <div className="text-[13px] text-ink-100">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-400">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** ReShade's key format: "virtual key code,ctrl,shift,alt". Chromium's keyCode is the Windows virtual key code. */
function keyString(e: KeyboardEvent): string | undefined {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined
  return `${e.keyCode},${e.ctrlKey ? 1 : 0},${e.shiftKey ? 1 : 0},${e.altKey ? 1 : 0}`
}

function KeyPicker({ label, disabled, onPick }: { label: string; disabled?: boolean; onPick(key: string): void }) {
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) return
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) return setListening(false)
      const k = keyString(e)
      if (!k) return
      setListening(false)
      onPick(k)
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [listening, onPick])
  return (
    <div className="flex items-center gap-2">
      <kbd className={cn('inline-flex h-8 min-w-16 items-center justify-center rounded-lg border px-2.5 font-mono text-[12.5px]', listening ? 'border-[var(--nf-accent)] text-ink-100' : 'border-white/[0.1] bg-white/[0.04] text-ink-100')}>
        {listening ? 'Press a key…' : label}
      </kbd>
      <Button size="sm" variant="outline" disabled={disabled} icon={<Keyboard className="size-3.5" />} onClick={() => setListening(!listening)}>
        {listening ? 'Cancel' : 'Change'}
      </Button>
    </div>
  )
}

function statusBadge(v: ReshadeView): ReactNode {
  const s = v.status
  if (s.state === 'unsupported') return <Badge tone="neutral">not possible here</Badge>
  if (s.state === 'broken') return <Badge tone="danger">needs attention</Badge>
  if (s.state === 'outdated') return <Badge tone="warning">{s.refresh ? 'needs another build' : `v${s.version} · ${s.latest} available`}</Badge>
  if (s.state === 'installed') return <Badge tone="success">{s.version ? `v${s.version}` : 'installed'}{s.via === 'manual' ? ' · by hand' : ''}</Badge>
  return <Badge tone={s.required ? 'warning' : 'neutral'}>{s.required ? 'needed, not installed' : 'not installed'}</Badge>
}

export function ReShadeTab({ game }: { game: Game }) {
  const [view, setView] = useState<ReshadeView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [showAllPacks, setShowAllPacks] = useState(false)
  // Choices not applied yet (undefined = as saved).
  const [api, setApi] = useState<string | null>()
  const [build, setBuild] = useState<'standard' | 'addon' | null>()
  const [packs, setPacks] = useState<string[]>()
  const op = useMods((s) => s.operation[game.id])
  const refreshMods = useMods((s) => s.load)
  const navigate = useNav((s) => s.navigate)

  const load = useCallback(async () => {
    try {
      setView(await invoke('reshade:view', game.id))
      setError(undefined)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [game.id])

  useEffect(() => {
    void load()
    const offMods = on('mods:changed', (p) => p.gameId === game.id && void load())
    const offSetup = on('setup:progress', (p) => p.gameId === game.id && p.done && void load())
    return () => {
      offMods()
      offSetup()
    }
  }, [game.id, load])

  const selectedPacks = useMemo(() => packs ?? view?.packages.filter((p) => p.selected).map((p) => p.name) ?? [], [packs, view])
  if (error && !view) return <Card className="px-5 py-4 text-[13px] text-rose-200">ReShade: {error}</Card>
  if (!view) return <div className="skeleton h-40 rounded-2xl" />

  const s = view.status
  const managed = view.copies.some((c) => c.managed) || (s.via !== 'manual' && s.canRemove)
  const present = view.copies.length > 0
  const installable = s.state !== 'unsupported' && Boolean(view.exe)
  const effectiveApi = api === undefined ? (view.api.chosen ?? view.api.detected) : (api ?? view.api.detected)
  const effectiveBuild = build === undefined ? view.build.effective : (build ?? (view.build.neededBy.length ? 'addon' : 'standard'))
  const savedPacks = view.packages.filter((p) => p.selected).map((p) => p.name)
  const packsChanged = packs !== undefined && (packs.length !== savedPacks.length || packs.some((p) => !savedPacks.includes(p)))
  const choicesChanged = api !== undefined || build !== undefined || packsChanged
  // A reason that belongs to the detected API (Vulkan, none found) no longer applies once another one is picked here.
  const blocked = typeof api === 'string' && s.state === 'missing' ? undefined : s.blocked
  const running = op && !op.done
  const opRunning = running && /ReShade/i.test(op.title)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
      await load()
      void refreshMods(game.id)
    } catch (err) {
      toast.error(label, (err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const install = (opts: { takeOver?: boolean } = {}) =>
    run('Install ReShade', async () => {
      if (
        opts.takeOver &&
        !(await confirm({
          title: s.state === 'broken' ? 'Fix ReShade?' : 'Let NexusForge manage ReShade?',
          message: `NexusForge moves ${view.copies.map((c) => c.name).join(', ')} into its backup folder and installs ReShade from reshade.me (signature checked)${s.proxy && s.state === 'broken' ? ` under the name ${game.name} really loads` : ''}${view.build.effective === 'addon' ? ', with add-on support like your copy' : ''}. Your copy comes back if you remove ReShade in NexusForge. ReShade.ini, your presets and shaders stay.`,
          confirmLabel: s.state === 'broken' ? 'Fix it' : "Use NexusForge's ReShade"
        }))
      )
        return
      await invoke('reshade:setup', game.id, { api: api === undefined ? undefined : api, build: build === undefined ? undefined : build, packages: packs, install: true })
      setApi(undefined)
      setBuild(undefined)
      setPacks(undefined)
    })

  const settings = (label: string, patch: ReshadeSettingsPatch) =>
    run(label, async () => {
      setView(await invoke('reshade:settings', game.id, patch))
    })

  const visiblePacks = showAllPacks ? view.packages : view.packages.filter((p) => p.required || p.defaultOn || p.installed || p.selected || p.neededFor.length || selectedPacks.includes(p.name))
  const activePreset = view.presets.find((p) => p.active)

  return (
    <div className="space-y-4">
      {/* Status */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-2xl', present ? 'accent-gradient text-white' : 'bg-white/[0.06] text-ink-300')}>
            {opRunning ? <LoaderCircle className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-ink-100">ReShade</span>
              {statusBadge(view)}
              {present && view.copies[0] && <Badge>{view.copies[0].build === 'addon' ? 'with add-on support' : 'standard build'}</Badge>}
              {present && view.copies[0] && <Badge className="font-mono">{view.copies[0].name}</Badge>}
              {view.latest && !present && <span className="text-[11.5px] text-ink-400">newest: {view.latest.version}{view.latest.released ? ` (${view.latest.released})` : ''}</span>}
            </div>
            <p className={cn('mt-1 text-[12.5px] leading-relaxed', blocked ? 'text-amber-200/90' : 'text-ink-300')}>{blocked ?? s.detail ?? s.summary}</p>
            {view.usedBy.length > 0 && <p className="mt-1 text-[12px] text-ink-400">Needed by {view.usedBy.join(', ')}.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <IconButton label="Check again" onClick={() => void run('Check again', load)}>
              <RefreshCw className={cn('size-4', busy === 'Check again' && 'animate-spin')} />
            </IconButton>
            {installable && !present && !managed && (
              <Button variant="primary" loading={busy === 'Install ReShade'} disabled={Boolean(running) || !effectiveApi || effectiveApi === 'vulkan'} icon={<Download className="size-4" />} onClick={() => void install()}>
                Install ReShade
              </Button>
            )}
            {(s.canUpdate || (managed && s.state === 'missing')) && (
              <Button variant="primary" loading={busy === 'Install ReShade'} disabled={Boolean(running)} icon={<Download className="size-4" />} onClick={() => void install()}>
                {s.state === 'missing' ? 'Deploy' : s.refresh ? 'Switch build' : `Update to ${s.latest}`}
              </Button>
            )}
            {present && !managed && installable && (s.state !== 'broken' || s.canInstall) && (
              <Button variant={s.state === 'broken' ? 'primary' : 'outline'} loading={busy === 'Install ReShade'} disabled={Boolean(running)} icon={<Wrench className="size-4" />} onClick={() => void install({ takeOver: true })}>
                {s.state === 'broken' ? 'Fix it' : 'Let NexusForge manage it'}
              </Button>
            )}
            {present && managed && view.copies.some((c) => !c.managed) && (
              <Button
                variant="outline"
                disabled={Boolean(running) || Boolean(busy)}
                onClick={() => void run('Move unused copy', () => invoke('reshade:setup', game.id, { cleanup: true }))}
                title="Moves the copy NexusForge doesn't manage into its backup folder"
              >
                Move {view.copies.find((c) => !c.managed)?.name} out
              </Button>
            )}
            {managed && (
              <Button
                variant="ghost"
                disabled={Boolean(running) || Boolean(busy)}
                icon={<Trash className="size-4" />}
                onClick={async () => {
                  if (await confirm({ title: 'Remove ReShade?', message: `ReShade and NexusForge's shader packs are taken out of ${game.name}. Presets and screenshots stay; a ReShade.ini NexusForge created is moved out too. Mods that need ReShade stop working until it is installed again.`, confirmLabel: 'Remove', danger: true })) {
                    void run('Remove ReShade', () => invoke('reshade:remove', game.id))
                  }
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        {s.warning && (
          <div className="flex gap-2 border-t border-white/[0.05] px-5 py-2.5 text-[12.5px] leading-relaxed text-amber-200/90">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {s.warning}
          </div>
        )}
        {op && running && opRunning && (
          <div className="space-y-1.5 border-t border-white/[0.05] px-5 py-3">
            {op.steps.map((st) => (
              <div key={st.id} className="text-[12.5px]">
                <div className="flex items-center gap-2 text-ink-200">
                  {st.state === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : st.state === 'done' ? <CircleCheck className="size-3.5 text-emerald-300" /> : st.state === 'failed' ? <TriangleAlert className="size-3.5 text-rose-300" /> : <Info className="size-3.5 text-ink-500" />}
                  {st.label}
                  {st.detail && <span className="truncate text-ink-400">· {st.detail}</span>}
                </div>
                {st.state === 'running' && <ProgressBar className="mt-1" value={st.progress} indeterminate={st.progress === undefined} />}
              </div>
            ))}
          </div>
        )}
        {op?.done && !op.ok && /ReShade/i.test(op.title) && <div className="border-t border-rose-400/20 bg-rose-500/[0.06] px-5 py-2.5 text-[12.5px] text-rose-100/90">{op.error ?? 'The last ReShade setup failed; see the Setup panel in the Mods tab.'}</div>}
      </Card>

      {/* Installation choices */}
      {view.exe && !view.compat?.banned && (view.arch === 'x86' || view.arch === 'x64') && (
        <Section icon={<Cpu />} title={present ? 'Installation' : 'Set up ReShade'} right={choicesChanged && managed ? <Button size="sm" variant="primary" loading={busy === 'Install ReShade'} disabled={Boolean(running)} onClick={() => void install()}>Apply changes</Button> : undefined}>
          <Row label="Game executable" hint="ReShade goes next to the program the game really runs.">
            <div className="font-mono text-[12px] break-all text-ink-200">{view.exe}</div>
            {view.note && <div className="mt-1 text-[12px] text-ink-400">{view.note}</div>}
            <button className="mt-1 text-[12px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline" onClick={() => navigate({ name: 'game', gameId: game.id, tab: 'settings' })}>
              Wrong file? Pick the executable in Settings.
            </button>
          </Row>
          <Row
            label="Graphics API"
            hint={
              <>
                {view.api.detected ? `Detected: ${view.api.options.find((o) => o.id === view.api.detected)?.label ?? view.api.detected}. ` : 'Not detected. '}
                {view.api.evidence}
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                value={effectiveApi ?? ''}
                onChange={(v) => setApi(v === view.api.detected ? null : v)}
                options={view.api.options.map((o) => ({ value: o.id, label: o.label }))}
              />
              {view.api.chosen && api === undefined && (
                <Button size="sm" variant="ghost" onClick={() => setApi(null)}>
                  Use detected
                </Button>
              )}
            </div>
            <div className="mt-1.5 text-[12px] text-ink-400">
              {effectiveApi === 'vulkan'
                ? 'Vulkan: ReShade would have to be registered system-wide, which NexusForge does not do. Pick DirectX if the game offers it.'
                : `Goes in as ${view.api.options.find((o) => o.id === effectiveApi)?.module ?? '…'}.`}
            </div>
          </Row>
          <Row label="Build" hint="The add-on build loads ReShade add-ons; it is meant for single-player games.">
            <Segmented
              size="sm"
              value={effectiveBuild}
              onChange={(v) => setBuild(v)}
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'addon', label: 'With add-on support' }
              ]}
            />
            {view.build.neededBy.length > 0 && <div className="mt-1.5 text-[12px] text-amber-200/90">{view.build.neededBy.join(', ')} {view.build.neededBy.length === 1 ? 'is a ReShade add-on and needs' : 'are ReShade add-ons and need'} add-on support.</div>}
          </Row>
          <Row
            label="Shader packs"
            hint={
              <>
                From ReShade&apos;s own list; downloaded from each author&apos;s GitHub.{' '}
                <button className="underline-offset-2 hover:text-ink-100 hover:underline" onClick={() => setShowAllPacks(!showAllPacks)}>
                  {showAllPacks ? 'Show fewer' : `Show all ${view.packages.length}`}
                </button>
              </>
            }
          >
            {!view.packages.length && <div className="text-[12.5px] text-ink-400">ReShade&apos;s list of shader packs couldn&apos;t be loaded (offline?).</div>}
            {view.shaders && !view.shaders.managed && view.shaders.effects > 0 && (
              <div className="mb-2 text-[12px] text-ink-300">
                reshade-shaders already has {view.shaders.effects} effects (from ReShade&apos;s own setup or a mod). NexusForge only adds packs when you tick them here and apply.
              </div>
            )}
            <div className="grid gap-1.5 sm:grid-cols-2">
              {visiblePacks.map((p) => {
                const on = selectedPacks.includes(p.name) || p.required
                return (
                  <label key={p.id} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2', on ? 'border-white/[0.1] bg-white/[0.04]' : 'border-white/[0.04] bg-black/10', p.required && 'cursor-default')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--nf-accent)]"
                      checked={on}
                      disabled={p.required}
                      onChange={(e) => setPacks(e.target.checked ? [...new Set([...selectedPacks, p.name])] : selectedPacks.filter((x) => x !== p.name))}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-100">
                        {p.name}
                        {p.installed && <Badge tone="success" className="text-[10px]">installed</Badge>}
                        {p.neededFor.length > 0 && <Badge tone="warning" className="text-[10px]">a preset uses {p.neededFor.slice(0, 2).join(', ')}</Badge>}
                      </span>
                      <span className="block text-[11.5px] leading-snug text-ink-400">{p.description}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </Row>
          {!present && !managed && (
            <div className="mt-2 flex justify-end">
              <Button variant="primary" loading={busy === 'Install ReShade'} disabled={Boolean(running) || !effectiveApi || effectiveApi === 'vulkan'} icon={<Download className="size-4" />} onClick={() => void install()}>
                Install ReShade{selectedPacks.length ? ` with ${selectedPacks.length} shader pack${selectedPacks.length === 1 ? '' : 's'}` : ''}
              </Button>
            </div>
          )}
        </Section>
      )}

      {/* ReShade.ini */}
      {present && view.ini && (
        <Section
          icon={<Palette />}
          title="Settings"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} disabled={!view.ini.exists} onClick={() => void invoke('app:openPath', view.ini!.path)}>
                ReShade.ini
              </Button>
              <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('app:openPath', view.dir!)}>
                Folder
              </Button>
            </div>
          }
        >
          {view.running && <div className="mb-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] text-amber-100/90">{game.name} is running: close it to change these settings.</div>}
          <Row label="Overlay key" hint="Opens ReShade in game.">
            <KeyPicker label={view.ini.keyLabel} disabled={view.running || Boolean(busy)} onPick={(k) => void settings('Overlay key', { keyOverlay: k })} />
          </Row>
          <Row label="Active preset" hint="A preset that comes with a mod becomes active automatically, until you pick one here or in the overlay.">
            <Select
              width={340}
              value={activePreset?.path ?? view.ini.presetPath}
              placeholder={view.ini.presetPath ? `${view.ini.presetPath} (not found)` : 'ReShadePreset.ini'}
              onChange={(v) => void settings('Active preset', { presetPath: v })}
              options={view.presets.map((p) => ({ value: p.path, label: p.name, hint: `${p.techniques} effect${p.techniques === 1 ? '' : 's'}${p.missing.length ? ` · ${p.missing.length} missing` : ''}` }))}
            />
            {activePreset && activePreset.missing.length > 0 && (
              <div className="mt-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-3 py-2 text-[12.5px] text-amber-100/90">
                <div>
                  {activePreset.name} uses {activePreset.missing.map((m) => m.file).join(', ')}, which {activePreset.missing.length === 1 ? 'is' : 'are'} not installed.
                </div>
                {(() => {
                  const add = [...new Set(activePreset.missing.map((m) => m.pack).filter((x): x is string => Boolean(x)))]
                  return add.length ? (
                    <Button
                      className="mt-1.5"
                      size="sm"
                      variant="primary"
                      disabled={Boolean(running) || Boolean(busy)}
                      icon={<Download className="size-3.5" />}
                      onClick={() => void run('Install shader packs', () => invoke('reshade:setup', game.id, { packages: [...new Set([...savedPacks, ...add])], install: true }))}
                    >
                      Install {add.join(', ')}
                    </Button>
                  ) : (
                    <div className="mt-1 text-ink-300">They are not in ReShade&apos;s list of shader packs; the preset&apos;s page should say where they come from.</div>
                  )
                })()}
              </div>
            )}
          </Row>
          <Row label="Performance mode" hint="Effects compile faster and cost less; their settings can't be changed in the overlay while it is on.">
            <Toggle checked={view.ini.performanceMode} disabled={view.running || Boolean(busy)} onChange={(v) => void settings('Performance mode', { performanceMode: v })} label="Performance mode" />
          </Row>
          <details className="group border-t border-white/[0.04] pt-3">
            <summary className="cursor-pointer list-none text-[12.5px] text-ink-300 select-none hover:text-ink-100">
              <span className="inline-flex items-center gap-1.5">
                <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" /> Depth buffer {view.compat?.listed ? "(set from ReShade's compatibility list)" : ''}
              </span>
            </summary>
            <div className="mt-2 space-y-2 pl-5 text-[12.5px] text-ink-200">
              {(
                [
                  ['reversed', 'Reversed (most games since 2012)'],
                  ['upsideDown', 'Upside down'],
                  ['logarithmic', 'Logarithmic']
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-3">
                  <Toggle checked={view.ini!.depth[k]} disabled={view.running || Boolean(busy)} onChange={(v) => void settings('Depth buffer', { depth: { [k]: v } })} label={label} />
                  {label}
                </label>
              ))}
              <p className="text-[11.5px] text-ink-400">Depth effects (ambient occlusion, depth of field) need these to match the game. Check with DisplayDepth.fx in the overlay.</p>
            </div>
          </details>
        </Section>
      )}

      {/* Last start */}
      {present && (
        <Section
          icon={<Layers />}
          title="Last start"
          right={
            view.lastStart && (
              <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => void invoke('app:openPath', view.lastStart!.logFile)}>
                ReShade.log
              </Button>
            )
          }
        >
          {!view.lastStart ? (
            <p className="text-[12.5px] leading-relaxed text-ink-300">No ReShade.log yet. Start {game.name}; ReShade shows a short banner at the top, and {view.ini?.keyLabel ?? 'Home'} opens its overlay.</p>
          ) : view.lastStart.placeholder ? (
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-200">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
              <span>
                ReShade.log is still the note ReShade&apos;s setup leaves ({relativeTime(view.lastStart.at)}): ReShade hasn&apos;t run in {game.name} since. If you started the game after that, it didn&apos;t load {view.copies.map((c) => c.name).join(', ') || 'ReShade'}.
              </span>
            </p>
          ) : (
            <div className="space-y-2 text-[12.5px] leading-relaxed">
              <p className="flex items-start gap-2 text-ink-200">
                {view.lastStart.runtime ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-300" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />}
                <span>
                  ReShade {view.lastStart.version} ({view.lastStart.bits}-bit) loaded as {view.lastStart.module} {relativeTime(view.lastStart.at)}
                  {view.lastStart.runtime
                    ? ` and attached to the game${view.lastStart.api ? ` (${view.lastStart.api}` : ''}${view.lastStart.gpu ? `${view.lastStart.api ? ', ' : ' ('}${view.lastStart.gpu}` : ''}${view.lastStart.api || view.lastStart.gpu ? ')' : ''}.`
                    : view.lastStart.exited
                      ? ", but never attached to the game's picture. The graphics API above is probably wrong."
                      : '.'}
                </span>
              </p>
              <p className="text-ink-300">
                {view.lastStart.compiled} effect{view.lastStart.compiled === 1 ? '' : 's'} compiled
                {view.lastStart.failed.length ? `, ${view.lastStart.failed.length} failed` : ''}
                {view.lastStart.addons.length ? ` · add-ons: ${view.lastStart.addons.map((a) => a.name).join(', ')}` : ''}.
              </p>
              {view.lastStart.failed.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-amber-100/80">
                  {view.lastStart.failed.map((f) => [f.file, ...f.errors.slice(0, 3).map((e) => `  ${e}`)].join('\n')).join('\n')}
                </pre>
              )}
              {view.lastStart.errors.length > 0 && <pre className="max-h-32 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-rose-100/80">{view.lastStart.errors.join('\n')}</pre>}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
