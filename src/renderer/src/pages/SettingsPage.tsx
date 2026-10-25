import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, FolderOpen, FolderPlus, Gamepad2, HardDrive, KeyRound, Link2, LogIn, Monitor, Palette, Plug, Plus, RefreshCw, Rss, ScrollText, ShieldAlert, ShieldCheck, Trash, Wand2, Info } from 'lucide-react'
import { accountForSource, useAccounts } from '../store/accounts'
import type { AccentName, DeployStrategy, FeedConfig, PluginInfo, Settings, SourceInfo } from '@shared/types'
import { invoke } from '../lib/api'
import { cn } from '../lib/format'
import { useApp } from '../store/app'
import { useLibrary } from '../store/library'
import { toast, useNav, type SettingsSection } from '../store/ui'
import { Badge, Button, Card, Field, Input, Segmented, Toggle } from '../components/ui'
import { Logo } from '../components/Chrome'

// Same muted tones as styles.css.
const ACCENTS: Array<{ value: AccentName; label: string; a: string; b: string }> = [
  { value: 'graphite', label: 'Graphite', a: '#a3a6ae', b: '#6f727a' },
  { value: 'violet', label: 'Dusk', a: '#8e88c2', b: '#6c7aa3' },
  { value: 'cyan', label: 'Steel', a: '#6fa2b1', b: '#7480aa' },
  { value: 'emerald', label: 'Moss', a: '#6fa68b', b: '#8ea86e' },
  { value: 'ember', label: 'Ember', a: '#c08a66', b: '#a56c6c' }
]

const UI_SCALES = [0.85, 0.9, 1, 1.1, 1.25]

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-white/[0.05] py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink-100">{title}</div>
        {/* Long paths in descriptions wrap instead of running under the controls on the right. */}
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed [overflow-wrap:anywhere] text-ink-400">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Panel({ title, icon, children, right }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Card className="p-6">
      <div className="mb-2 flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-white/[0.06] text-ink-200 [&>svg]:size-4">{icon}</div>
        <h3 className="flex-1 text-[15px] font-semibold text-ink-100">{title}</h3>
        {right}
      </div>
      {children}
    </Card>
  )
}

function General({ s, update }: { s: Settings; update(p: Partial<Settings>): void }) {
  return (
    <div className="space-y-4">
      <Panel title="Appearance" icon={<Palette />}>
        <Row title="Accent tone" description="A muted tint for selections, focus rings and progress. Everything else stays dark.">
          <div className="flex gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                onClick={() => update({ accent: a.value })}
                title={a.label}
                className={cn('relative size-8 rounded-lg border border-white/10 transition-transform hover:scale-105', s.accent === a.value && 'ring-2 ring-white/60 ring-offset-2 ring-offset-ink-900')}
                style={{ background: `linear-gradient(135deg, ${a.a}, ${a.b})` }}
              />
            ))}
          </div>
        </Row>
        <Row
          title="Interface size"
          description={
            <>
              Makes text, buttons and pictures bigger or smaller (useful on a TV or a small window). Also <span className="font-mono text-ink-300">Ctrl +</span> /{' '}
              <span className="font-mono text-ink-300">Ctrl −</span> / <span className="font-mono text-ink-300">Ctrl 0</span> or Ctrl + mouse wheel.
            </>
          }
        >
          <Segmented<string>
            size="sm"
            value={String(UI_SCALES.includes(s.uiScale ?? 1) ? (s.uiScale ?? 1) : 'custom')}
            onChange={(v) => v !== 'custom' && update({ uiScale: Number(v) })}
            options={[
              ...UI_SCALES.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` })),
              ...(UI_SCALES.includes(s.uiScale ?? 1) ? [] : [{ value: 'custom', label: `${Math.round((s.uiScale ?? 1) * 100)}%` }])
            ]}
          />
        </Row>
        <Row title="Reduce motion" description="Turns off most animations.">
          <Toggle checked={s.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
        </Row>
      </Panel>
      <Panel title="Launching" icon={<Gamepad2 />}>
        <Row title="Minimize NexusForge when a game starts">
          <Toggle checked={s.minimizeOnLaunch} onChange={(v) => update({ minimizeOnLaunch: v })} />
        </Row>
      </Panel>
    </div>
  )
}

function LibrarySettings({ s, update }: { s: Settings; update(p: Partial<Settings>): void }) {
  const { scan, scanning } = useLibrary()
  const platforms: Array<{ key: keyof Settings['scanPlatforms']; label: string; description: string }> = [
    { key: 'steam', label: 'Steam', description: 'All library folders from libraryfolders.vdf, plus playtime from your Steam profile.' },
    { key: 'epic', label: 'Epic Games Store', description: 'Install manifests in ProgramData.' },
    { key: 'xbox', label: 'Xbox / Microsoft Store', description: 'Game Pass and Store games in XboxGames folders.' },
    { key: 'gog', label: 'GOG', description: 'GOG Galaxy and offline installers (registry).' },
    { key: 'custom', label: 'Game folders', description: 'Games outside the launchers: your drives (below) and your own folders. Every sub folder counts as one game.' }
  ]
  const [driveRoots, setDriveRoots] = useState<string[] | null>(null)
  useEffect(() => {
    if (!s.scanAllDrives) return setDriveRoots([])
    let live = true
    void invoke('library:driveRoots').then((r) => live && setDriveRoots(r), () => live && setDriveRoots([]))
    return () => {
      live = false
    }
  }, [s.scanAllDrives, scanning])
  const addFolder = async () => {
    const dir = await invoke('app:pickFolder', { title: 'Folder that contains your games' })
    if (!dir) return
    if (s.customFolders.some((f) => f.toLowerCase() === dir.toLowerCase())) return toast.info('That folder is already in the list')
    update({ customFolders: [...s.customFolders, dir] })
    toast.success('Folder added', 'Rescan to pick up the games inside it.')
  }
  return (
    <div className="space-y-4">
      <Panel
        title="Game scanning"
        icon={<Gamepad2 />}
        right={
          <Button size="sm" icon={<RefreshCw className={cn('size-3.5', scanning && 'animate-spin')} />} disabled={scanning} onClick={() => void scan()}>
            {scanning ? 'Scanning…' : 'Scan now'}
          </Button>
        }
      >
        {platforms.map((p) => (
          <Row key={p.key} title={p.label} description={p.description}>
            <Toggle checked={s.scanPlatforms[p.key]} onChange={(v) => update({ scanPlatforms: { ...s.scanPlatforms, [p.key]: v } })} />
          </Row>
        ))}
        <Row title="Scan when NexusForge starts" description="Looks for new games and for the mods installed in every game (also ones installed by hand or by other tools) each time NexusForge opens.">
          <Toggle checked={s.scanOnStartup} onChange={(v) => update({ scanOnStartup: v })} />
        </Row>
        <Row
          title="Fetch artwork from the Steam store"
          description="NexusForge looks up each game on the Steam store (by its name, or its Steam app id) for cover art and checks that every picture loads. Only the name is sent. Pictures in a game's own folder (cover.jpg, banner.png) are used when the store has none."
        >
          <Toggle checked={s.autoFetchArtwork} onChange={(v) => update({ autoFetchArtwork: v })} />
        </Row>
      </Panel>
      <Panel title="Every drive" icon={<HardDrive />}>
        <Row
          title="Find games on all drives"
          description="Looks at every local drive (C:, E:, …) for game folders: “Games” folders, Steam libraries Steam doesn't list, and the Epic, GOG, EA, Ubisoft, Rockstar, Riot and Amazon install folders. Read-only."
        >
          <Toggle checked={s.scanAllDrives} disabled={!s.scanPlatforms.custom} onChange={(v) => update({ scanAllDrives: v })} />
        </Row>
        {s.scanAllDrives && s.scanPlatforms.custom && (
          <div className="mt-1 space-y-1.5 pb-1">
            {driveRoots === null ? (
              <p className="text-[12.5px] text-ink-400">Looking at your drives…</p>
            ) : driveRoots.length ? (
              driveRoots.map((f) => (
                <div key={f} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-2">
                  <HardDrive className="size-3.5 text-ink-400" />
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-ink-300">{f}</span>
                </div>
              ))
            ) : (
              <p className="text-[12.5px] text-ink-400">No game folders found on your drives. Add yours below.</p>
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="Custom game folders"
        icon={<FolderPlus />}
        right={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => void addFolder()}>
            Add folder
          </Button>
        }
      >
        {s.customFolders.length ? (
          <div className="mt-2 space-y-1.5">
            {s.customFolders.map((f) => (
              <div key={f} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-2.5">
                <FolderOpen className="size-4 text-ink-400" />
                <span className="selectable min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-200">{f}</span>
                <Button size="sm" variant="ghost" className="px-2" aria-label="Remove folder" onClick={() => update({ customFolders: s.customFolders.filter((x) => x !== f) })}>
                  <Trash className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-ink-400">No custom folders yet. Add the folders where you keep games that don't come from a launcher.</p>
        )}
      </Panel>
    </div>
  )
}

function ModsSettings({ s, update }: { s: Settings; update(p: Partial<Settings>): void }) {
  return (
    <div className="space-y-4">
      <Panel title="Mod storage" icon={<HardDrive />}>
        <Field
          label="Storage folder"
          hint="Installed mods live here and get linked into games. Hardlinks only work when this folder is on the same drive as the game. Changing it affects new installs; existing mods stay where they are."
        >
          <div className="mt-1 flex gap-2">
            <Input mono readOnly value={s.modStorageDir} />
            <Button
              icon={<FolderOpen className="size-4" />}
              onClick={async () => {
                const d = await invoke('app:pickFolder', { title: 'Mod storage folder', defaultPath: s.modStorageDir })
                if (d) update({ modStorageDir: d })
              }}
            >
              Change
            </Button>
          </div>
        </Field>
      </Panel>
      <Panel title="Dependencies" icon={<Link2 />}>
        <Row title="When a mod needs other mods" description="Required mods are placed before the mod in the load order. Mods from outside NexusForge (script extenders, DLC) are always listed so you can get them yourself.">
          <Segmented<Settings['dependencyMode']>
            value={s.dependencyMode}
            onChange={(v) => update({ dependencyMode: v })}
            options={[
              { value: 'ask', label: 'Ask me' },
              { value: 'always', label: 'Install automatically' },
              { value: 'never', label: 'Never' }
            ]}
          />
        </Row>
      </Panel>
      <Panel title="Steam Workshop" icon={<Gamepad2 />}>
        <Field label="SteamCMD" hint="Used for Workshop downloads with an anonymous login. Leave empty to use C:\SteamCMD if it exists, or a copy NexusForge downloads itself.">
          <div className="mt-1 flex gap-2">
            <Input mono value={s.steamcmdPath} placeholder="automatic" onChange={(e) => update({ steamcmdPath: e.target.value })} />
            <Button
              icon={<FolderOpen className="size-4" />}
              onClick={async () => {
                const f = await invoke('app:pickFile', { title: 'steamcmd.exe', filters: [{ name: 'SteamCMD', extensions: ['exe'] }] })
                if (f) update({ steamcmdPath: f })
              }}
            >
              Browse
            </Button>
          </div>
        </Field>
      </Panel>
      <Panel title="Default deployment method" icon={<Wand2 />}>
        <Row title="For newly added games" description="Each game can override this in its settings. Symlinks fall back to hardlinks, then copies, automatically.">
          <Segmented<DeployStrategy>
            value={s.defaultStrategy}
            onChange={(v) => update({ defaultStrategy: v })}
            options={[
              { value: 'symlink', label: 'Symlink' },
              { value: 'hardlink', label: 'Hardlink' },
              { value: 'copy', label: 'Copy' }
            ]}
          />
        </Row>
      </Panel>
    </div>
  )
}

function SourcesSettings({ s, update }: { s: Settings; update(p: Partial<Settings>): void }) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [feeds, setFeeds] = useState<FeedConfig[]>(s.feeds)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [newFeed, setNewFeed] = useState({ name: '', url: '' })

  const refresh = async () => {
    setSources(await invoke('sources:list'))
    setPlugins(await invoke('sources:plugins'))
  }
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => setFeeds(s.feeds), [s.feeds])

  const saveFeeds = async (next: FeedConfig[]) => {
    try {
      setSources(await invoke('sources:setFeeds', next))
      await useApp.getState().load()
    } catch (err) {
      toast.error('Could not save feeds', (err as Error).message)
    }
  }

  const builtins = sources.filter((x) => x.kind === 'builtin')
  return (
    <div className="space-y-4">
      <Panel title="Mod sources" icon={<Wand2 />}>
        {builtins.map((src) => (
          <div key={src.id} className="border-b border-white/[0.05] py-4 last:border-b-0">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink-100">
                  {src.name}
                  {src.apiKey && (src.hasKey ? <Badge tone="success">API key saved</Badge> : <Badge tone={src.apiKey === 'required' ? 'warning' : 'neutral'}>{src.apiKey === 'required' ? 'needs API key' : 'no API key'}</Badge>)}
                  {!src.hasKey && accountForSource(src.id) ? (
                    <button
                      className="flex items-center gap-1 text-[12px] font-normal text-[color-mix(in_oklab,var(--nf-accent)_65%,white)] hover:underline"
                      onClick={async () => {
                        if (await useAccounts.getState().signIn(accountForSource(src.id)!)) void refresh()
                      }}
                    >
                      sign in to get it automatically <LogIn className="size-3" />
                    </button>
                  ) : (
                    src.apiKeyUrl &&
                    !src.hasKey && (
                      <button className="flex items-center gap-1 text-[12px] font-normal text-[color-mix(in_oklab,var(--nf-accent)_65%,white)] hover:underline" onClick={() => void invoke('app:openExternal', src.apiKeyUrl!)}>
                        get a key <ExternalLink className="size-3" />
                      </button>
                    )
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-400">{src.description}</div>
              </div>
              <Toggle
                checked={s.sources[src.id]?.enabled ?? true}
                onChange={async (v) => {
                  update({ sources: { [src.id]: { enabled: v } } })
                  setTimeout(() => void refresh(), 300)
                }}
              />
            </div>
            {src.apiKey && (
              <div className="mt-3 flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
                  <Input
                    type="password"
                    mono
                    className="pl-9"
                    placeholder={src.hasKey ? '•••••••• (saved, encrypted with Windows DPAPI)' : 'Personal API key from your account settings'}
                    value={keyDraft[src.id] ?? ''}
                    onChange={(e) => setKeyDraft({ ...keyDraft, [src.id]: e.target.value })}
                  />
                </div>
                <Button
                  disabled={!keyDraft[src.id]}
                  onClick={async () => {
                    await useApp.getState().update({ sources: { [src.id]: { enabled: s.sources[src.id]?.enabled ?? true, apiKey: keyDraft[src.id] } } })
                    setKeyDraft({ ...keyDraft, [src.id]: '' })
                    toast.success('API key saved')
                    void refresh()
                  }}
                >
                  Save key
                </Button>
                {src.hasKey && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await useApp.getState().update({ sources: { [src.id]: { enabled: s.sources[src.id]?.enabled ?? true, apiKey: '' } } })
                      void refresh()
                    }}
                  >
                    Forget
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </Panel>

      <Panel title="Custom feeds" icon={<Rss />}>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-400">
          Add any JSON mod index, from a URL or a local file. See <span className="font-mono text-ink-300">docs/PLUGINS.md</span> for the format.
        </p>
        <div className="space-y-1.5">
          {feeds.map((f) => (
            <div key={f.id} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-2.5">
              <Rss className="size-4 text-ink-400" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink-100">{f.name}</div>
                <div className="truncate font-mono text-[11.5px] text-ink-400">{f.url}</div>
              </div>
              <Toggle checked={f.enabled} onChange={(v) => void saveFeeds(feeds.map((x) => (x.id === f.id ? { ...x, enabled: v } : x)))} />
              <Button size="sm" variant="ghost" className="px-2" aria-label="Remove feed" onClick={() => void saveFeeds(feeds.filter((x) => x.id !== f.id))}>
                <Trash className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Input placeholder="Name" className="w-44" value={newFeed.name} onChange={(e) => setNewFeed({ ...newFeed, name: e.target.value })} />
          <Input mono placeholder="https://example.com/mods.json or C:\path\feed.json" value={newFeed.url} onChange={(e) => setNewFeed({ ...newFeed, url: e.target.value })} />
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            disabled={!newFeed.url.trim()}
            onClick={async () => {
              await saveFeeds([...feeds, { id: '', name: newFeed.name || 'Custom feed', url: newFeed.url, enabled: true }])
              setNewFeed({ name: '', url: '' })
            }}
          >
            Add
          </Button>
        </div>
      </Panel>

      <Panel
        title="Plugins"
        icon={<Plug />}
        right={
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('sources:openPluginsFolder')}>
              Open folder
            </Button>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={async () => (await invoke('sources:reload'), void refresh())}>
              Reload
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-400">
          Plugins are JavaScript mod sources in the plugins folder. They run with the same rights as NexusForge, so a plugin only loads after you trust it, and trust is reset whenever its code changes.
        </p>
        {plugins.length ? (
          <div className="space-y-1.5">
            {plugins.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
                {p.trusted ? <ShieldCheck className="size-4 text-emerald-300" /> : <ShieldAlert className="size-4 text-amber-300" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-ink-100">
                    {p.name} {p.version && <span className="font-mono text-[11px] text-ink-400">v{p.version}</span>}
                    {p.loaded && <Badge tone="success">loaded</Badge>}
                    {p.changed && <Badge tone="warning">code changed, re-approve</Badge>}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-ink-400">{p.dir}</div>
                  {p.error && <div className="mt-1 text-[12px] text-rose-300">{p.error}</div>}
                </div>
                <Button
                  size="sm"
                  variant={p.trusted ? 'ghost' : 'primary'}
                  onClick={async () => {
                    try {
                      setPlugins(await invoke('sources:trustPlugin', p.id, !p.trusted))
                      setSources(await invoke('sources:list'))
                    } catch (err) {
                      toast.error('Plugin error', (err as Error).message)
                    }
                  }}
                >
                  {p.trusted ? 'Distrust' : 'Trust & load'}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-400">No plugins installed.</p>
        )}
      </Panel>
    </div>
  )
}

function Advanced({ s, update }: { s: Settings; update(p: Partial<Settings>): void }) {
  const info = useApp((x) => x.info)
  return (
    <div className="space-y-4">
      <Panel title="Logging" icon={<ScrollText />}>
        <Row title="Log level" description={<span className="font-mono">{info?.logFile}</span>}>
          <Segmented
            size="sm"
            value={s.logLevel}
            onChange={(v) => update({ logLevel: v })}
            options={[
              { value: 'error', label: 'Errors' },
              { value: 'warn', label: 'Warnings' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' }
            ]}
          />
        </Row>
        <Row title="Log files">
          <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('app:openLogs')}>
            Show logs
          </Button>
        </Row>
        <Row title="App data" description={<span className="font-mono">{info?.userData}</span>}>
          <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => info && void invoke('app:openPath', info.userData)}>
            Open
          </Button>
        </Row>
        <Row title="Show the welcome screen again">
          <Button size="sm" onClick={() => update({ firstRunComplete: false })}>
            Reset
          </Button>
        </Row>
      </Panel>
      <Panel title="About" icon={<Info />}>
        <div className="flex items-center gap-4 py-3">
          <Logo size={48} />
          <div>
            <div className="text-lg font-bold text-ink-100">NexusForge {info?.version}</div>
            <div className="text-[12.5px] text-ink-400">
              Electron {info?.electron} · Chromium {info?.chrome} · Node {info?.node} · {info?.platform}
            </div>
            <div className="mt-1 text-[12.5px] text-ink-400">
              <Monitor className="mr-1 inline size-3.5" />
              {info?.isElevated ? 'Running as administrator (symlinks available)' : 'Running as a normal user'}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function SettingsPage({ section }: { section?: SettingsSection }) {
  const s = useApp((x) => x.settings)
  const update = useApp((x) => x.update)
  const navigate = useNav((x) => x.navigate)
  const [current, setCurrent] = useState<SettingsSection>(section ?? 'general')
  useEffect(() => setCurrent(section ?? 'general'), [section])
  if (!s) return null
  const sections: Array<{ value: SettingsSection; label: string; icon: ReactNode }> = [
    { value: 'general', label: 'General', icon: <Palette /> },
    { value: 'library', label: 'Library', icon: <Gamepad2 /> },
    { value: 'mods', label: 'Mods', icon: <HardDrive /> },
    { value: 'sources', label: 'Sources & plugins', icon: <Plug /> },
    { value: 'advanced', label: 'Advanced', icon: <ScrollText /> }
  ]
  const apply = (p: Partial<Settings>) => void update(p)
  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 px-4 pt-4">
        <h1 className="mb-5 px-3 text-[28px] font-bold tracking-tight text-ink-100">Settings</h1>
        <div className="space-y-1">
          {sections.map((x) => (
            <button
              key={x.value}
              onClick={() => (setCurrent(x.value), navigate({ name: 'settings', section: x.value }))}
              className={cn('relative flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium transition-colors', current === x.value ? 'text-ink-100' : 'text-ink-400 hover:text-ink-100')}
            >
              {current === x.value && <motion.span layoutId="settings-active" className="absolute inset-0 rounded-xl bg-white/[0.07]" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <span className="relative [&>svg]:size-4">{x.icon}</span>
              <span className="relative">{x.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 pt-[72px] pb-10">
        <div className="max-w-3xl">
          <AnimatePresence mode="wait">
            <motion.div key={current} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              {current === 'general' && <General s={s} update={apply} />}
              {current === 'library' && <LibrarySettings s={s} update={apply} />}
              {current === 'mods' && <ModsSettings s={s} update={apply} />}
              {current === 'sources' && <SourcesSettings s={s} update={apply} />}
              {current === 'advanced' && <Advanced s={s} update={apply} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
