import { create } from 'zustand'
import type {
  ConflictReport,
  DeployProgress,
  DeployReport,
  DeployStatus,
  InstalledMod,
  IntegrationInfo,
  LaunchCheck,
  LinkCapabilities,
  ModUpdate,
  Profile,
  SetupProgress,
  ShortcutInfo
} from '@shared/types'
import { invoke, on } from '../lib/api'
import { toast } from './ui'
import { useDownloads } from './downloads'
import { ensureSignedIn } from './accounts'

export interface GameMods {
  mods: InstalledMod[]
  profiles: Profile[]
  activeId: string
  conflicts?: ConflictReport
  status?: DeployStatus
  caps?: LinkCapabilities
  loaded: boolean
}

/** What a deployment stage is doing, in words. */
export const STAGE_LABEL: Record<string, string> = {
  validate: 'Checking the game…',
  loader: 'Installing the mod loader…',
  recover: 'Undoing an interrupted deployment…',
  plan: 'Working out what changes…',
  preflight: 'Checking folders, rights and free space…',
  remove: 'Taking out files that are no longer wanted…',
  place: 'Putting files in place…',
  configure: "Updating the mod loader's settings…",
  verify: 'Checking every file…',
  record: 'Saving the result…',
  rollback: 'Something failed: putting the previous state back…',
  done: 'Finished'
}

interface ModsState {
  byGame: Record<string, GameMods>
  deploying: Record<string, DeployProgress | 'starting' | undefined>
  installing: Record<string, number>
  lastReport: Record<string, DeployReport | undefined>
  /** How NexusForge mods each game (loaders, deploy folders, launch options). */
  integration: Record<string, IntegrationInfo | undefined>
  /** The running (or last) setup operation per game: loader install, deploy, verify. */
  operation: Record<string, SetupProgress | undefined>
  /** What the mod loader logged at the last start. */
  launchCheck: Record<string, LaunchCheck | undefined>
  shortcuts: Record<string, ShortcutInfo[] | undefined>
  /** Loader install/remove buttons that are busy, "<gameId>:<loaderId>". */
  loaderBusy: Record<string, boolean>
  inspect(gameId: string, fresh?: boolean): Promise<IntegrationInfo | undefined>
  installLoader(gameId: string, loaderId: string): Promise<void>
  removeLoader(gameId: string, loaderId: string): Promise<void>
  createShortcut(gameId: string, variant: 'vanilla' | 'modded', where: 'startmenu' | 'desktop'): Promise<void>
  cancel(gameId: string): Promise<void>
  /** Newer files for installed mods, per game (undefined = not checked yet). */
  updates: Record<string, ModUpdate[] | undefined>
  checkingUpdates: Record<string, boolean>
  /** Mods whose update download was started (hidden from the list until the check runs again). */
  updating: Record<string, true>
  checkUpdates(gameId: string, force?: boolean): Promise<void>
  applyUpdates(gameId: string, updates: ModUpdate[]): Promise<void>
  load(gameId: string): Promise<void>
  refreshMeta(gameId: string): Promise<void>
  probe(gameId: string): Promise<void>
  install(gameId: string, files: string[]): Promise<void>
  remove(gameId: string, modId: string): Promise<void>
  saveProfile(gameId: string, profile: Profile): Promise<void>
  toggle(gameId: string, modId: string, enabled?: boolean): Promise<void>
  setAll(gameId: string, enabled: boolean): Promise<void>
  reorder(gameId: string, from: number, to: number): Promise<void>
  setOverrides(gameId: string, overrides: Record<string, string | undefined>): Promise<void>
  deploy(gameId: string): Promise<DeployReport | undefined>
  purge(gameId: string): Promise<DeployReport | undefined>
  switchProfile(gameId: string, profileId: string): Promise<void>
  createProfile(gameId: string, name: string, cloneFrom?: string): Promise<void>
  renameProfile(gameId: string, profileId: string, name: string): Promise<void>
  deleteProfile(gameId: string, profileId: string): Promise<void>
}

export function activeProfileOf(g: GameMods | undefined): Profile | undefined {
  return g?.profiles.find((p) => p.id === g.activeId)
}

export const useMods = create<ModsState>((set, get) => {
  const patchGame = (gameId: string, patch: Partial<GameMods>) => {
    const current = get().byGame[gameId] ?? { mods: [], profiles: [], activeId: '', loaded: false }
    set({ byGame: { ...get().byGame, [gameId]: { ...current, ...patch } } })
  }

  const fail = (title: string) => (err: unknown) => {
    toast.error(title, (err as Error).message)
  }

  return {
    byGame: {},
    deploying: {},
    installing: {},
    lastReport: {},
    integration: {},
    operation: {},
    launchCheck: {},
    shortcuts: {},
    loaderBusy: {},
    updates: {},
    checkingUpdates: {},
    updating: {},

    async inspect(gameId, fresh) {
      try {
        const [info, shortcuts, last, op] = await Promise.all([
          invoke('integration:inspect', gameId, fresh),
          invoke('integration:shortcuts', gameId).catch(() => [] as ShortcutInfo[]),
          invoke('integration:lastLaunch', gameId).catch(() => undefined),
          invoke('integration:operation', gameId).catch(() => undefined)
        ])
        set({
          integration: { ...get().integration, [gameId]: info },
          shortcuts: { ...get().shortcuts, [gameId]: shortcuts },
          launchCheck: { ...get().launchCheck, [gameId]: last },
          operation: op ? { ...get().operation, [gameId]: op } : get().operation
        })
        return info
      } catch (err) {
        fail('Could not check the game setup')(err)
        return undefined
      }
    },

    async installLoader(gameId, loaderId) {
      const key = `${gameId}:${loaderId}`
      set({ loaderBusy: { ...get().loaderBusy, [key]: true } })
      try {
        const report = await invoke('integration:installLoader', gameId, loaderId)
        if (report) set({ lastReport: { ...get().lastReport, [gameId]: report } })
      } catch (err) {
        // The main process already showed the failed step in the setup panel; the toast says what to do.
        fail('Installing the mod loader failed')(err)
      } finally {
        set({ loaderBusy: { ...get().loaderBusy, [key]: false } })
        await Promise.all([get().inspect(gameId, true), get().load(gameId)])
      }
    },

    async removeLoader(gameId, loaderId) {
      const key = `${gameId}:${loaderId}`
      set({ loaderBusy: { ...get().loaderBusy, [key]: true } })
      try {
        const info = await invoke('integration:removeLoader', gameId, loaderId)
        set({ integration: { ...get().integration, [gameId]: info } })
        toast.success('Mod loader removed')
      } catch (err) {
        fail('Could not remove the mod loader')(err)
      } finally {
        set({ loaderBusy: { ...get().loaderBusy, [key]: false } })
        await get().load(gameId)
      }
    },

    async createShortcut(gameId, variant, where) {
      try {
        const s = await invoke('integration:shortcut', gameId, variant, where)
        toast.success(`Shortcut "${s.label}" ${where === 'desktop' ? 'on the desktop' : 'in the Start menu'}`, s.path)
        set({ shortcuts: { ...get().shortcuts, [gameId]: await invoke('integration:shortcuts', gameId) } })
      } catch (err) {
        fail('Could not create the shortcut')(err)
      }
    },

    async cancel(gameId) {
      await invoke('deploy:cancel', gameId).catch(() => {})
    },

    async checkUpdates(gameId, force) {
      if (get().checkingUpdates[gameId]) return
      set({ checkingUpdates: { ...get().checkingUpdates, [gameId]: true } })
      try {
        const list = await invoke('mods:checkUpdates', gameId, force)
        const updating = { ...get().updating }
        // A finished update no longer shows up in a fresh check; forget that it was running.
        if (force) for (const k of Object.keys(updating)) if (k.startsWith(`${gameId}:`) && !list.some((u) => `${gameId}:${u.modId}` === k)) delete updating[k]
        set({ updates: { ...get().updates, [gameId]: list }, updating })
        if (force) toast.info(list.length ? `${list.length} update${list.length === 1 ? '' : 's'} available` : 'All mods are up to date', list.length ? list.map((u) => u.name).slice(0, 4).join(', ') : undefined)
      } catch (err) {
        if (force) fail('Update check failed')(err)
      } finally {
        set({ checkingUpdates: { ...get().checkingUpdates, [gameId]: false } })
      }
    },

    async applyUpdates(gameId, list) {
      if (!list.length) return
      if (!(await ensureSignedIn(list.map((u) => u.sourceId), 'Updating mods from this site needs your (free) account there.'))) return
      for (const u of list) {
        const item = await useDownloads.getState().start({
          sourceId: u.sourceId,
          modId: u.sourceModId,
          versionId: u.latestVersionId,
          gameId,
          name: u.name,
          version: u.latestVersion,
          thumbnail: u.thumbnail
        })
        if (item) set({ updating: { ...get().updating, [`${gameId}:${u.modId}`]: true } })
      }
    },

    async load(gameId) {
      try {
        const [mods, { profiles, activeId }] = await Promise.all([invoke('mods:list', gameId), invoke('profiles:list', gameId)])
        patchGame(gameId, { mods, profiles, activeId, loaded: true })
        await Promise.all([get().refreshMeta(gameId), get().integration[gameId] ? Promise.resolve() : get().inspect(gameId)])
      } catch (err) {
        fail('Could not load mods')(err)
      }
    },

    async refreshMeta(gameId) {
      const [conflicts, status] = await Promise.all([invoke('conflicts:get', gameId), invoke('deploy:status', gameId)])
      patchGame(gameId, { conflicts, status })
    },

    async probe(gameId) {
      try {
        patchGame(gameId, { caps: await invoke('deploy:probe', gameId) })
      } catch (err) {
        fail('Link check failed')(err)
      }
    },

    async install(gameId, files) {
      if (!files.length) return
      set({ installing: { ...get().installing, [gameId]: (get().installing[gameId] ?? 0) + files.length } })
      try {
        for (const f of files) {
          try {
            const [mod] = await invoke('mods:installFiles', gameId, [f])
            toast.success(`Installed ${mod.name}`, `${mod.fileCount.toLocaleString()} files${mod.version ? ` · v${mod.version}` : ''}`)
          } catch (err) {
            toast.error(`Couldn't install ${f.split(/[\\/]/).pop()}`, (err as Error).message)
          } finally {
            set({ installing: { ...get().installing, [gameId]: Math.max(0, (get().installing[gameId] ?? 1) - 1) } })
          }
        }
      } finally {
        await get().load(gameId)
      }
    },

    async remove(gameId, modId) {
      const mod = get().byGame[gameId]?.mods.find((m) => m.id === modId)
      try {
        await invoke('mods:remove', gameId, modId)
        toast.success(`Removed ${mod?.name ?? 'mod'}`)
      } catch (err) {
        fail('Could not remove mod')(err)
      }
      await get().load(gameId)
    },

    async saveProfile(gameId, profile) {
      const g = get().byGame[gameId]
      if (!g) return
      // Optimistic: the list reacts immediately, the main process normalizes and persists.
      patchGame(gameId, { profiles: g.profiles.map((p) => (p.id === profile.id ? profile : p)) })
      try {
        const saved = await invoke('profiles:save', profile)
        const latest = get().byGame[gameId]
        patchGame(gameId, { profiles: latest.profiles.map((p) => (p.id === saved.id ? saved : p)) })
        await get().refreshMeta(gameId)
      } catch (err) {
        fail('Could not save profile')(err)
        await get().load(gameId)
      }
    },

    async toggle(gameId, modId, enabled) {
      const p = activeProfileOf(get().byGame[gameId])
      if (!p) return
      const on = enabled ?? !p.enabled.includes(modId)
      const next = on ? [...new Set([...p.enabled, modId])] : p.enabled.filter((id) => id !== modId)
      await get().saveProfile(gameId, { ...p, enabled: next })
    },

    async setAll(gameId, enabled) {
      const p = activeProfileOf(get().byGame[gameId])
      if (!p) return
      await get().saveProfile(gameId, { ...p, enabled: enabled ? [...p.order] : [] })
    },

    async reorder(gameId, from, to) {
      const p = activeProfileOf(get().byGame[gameId])
      if (!p || from === to) return
      const order = [...p.order]
      const [moved] = order.splice(from, 1)
      order.splice(to, 0, moved)
      await get().saveProfile(gameId, { ...p, order })
    },

    async setOverrides(gameId, overrides) {
      const p = activeProfileOf(get().byGame[gameId])
      if (!p) return
      const fileOverrides = { ...p.fileOverrides }
      for (const [k, v] of Object.entries(overrides)) {
        if (v) fileOverrides[k] = v
        else delete fileOverrides[k]
      }
      await get().saveProfile(gameId, { ...p, fileOverrides })
    },

    async deploy(gameId) {
      set({ deploying: { ...get().deploying, [gameId]: 'starting' } })
      try {
        // One click: installs the mod loader the enabled mods need, deploys, verifies. The result card under the
        // toolbar shows the details; failures are also announced by the main process.
        const report = await invoke('deploy:setup', gameId)
        set({ lastReport: { ...get().lastReport, [gameId]: report } })
        const skipped = report.notes.filter((n) => n.includes('was not deployed'))
        if (report.outcome === 'verified') {
          if (skipped.length) toast.warning(report.title, skipped.join(' '))
          else toast.success(report.verification?.loadVerified ? 'Deployed and verified' : 'Deployed', report.title)
        } else if (report.outcome === 'nothing') {
          toast.info(report.title)
        }
        return report
      } catch (err) {
        fail('Deployment failed')(err)
        return undefined
      } finally {
        set({ deploying: { ...get().deploying, [gameId]: undefined } })
        await Promise.all([get().refreshMeta(gameId), get().inspect(gameId, true)])
      }
    },

    async purge(gameId) {
      set({ deploying: { ...get().deploying, [gameId]: 'starting' } })
      try {
        const report = await invoke('deploy:purge', gameId)
        set({ lastReport: { ...get().lastReport, [gameId]: report } })
        if (report.outcome === 'failed' || report.outcome === 'rolled_back') toast.error(report.problem?.title ?? 'Purge failed', report.problem?.detail ?? report.title)
        else if (report.errors.length) toast.warning('Purged with problems', report.errors[0])
        else toast.success('Game restored', report.removed || report.kept ? `${report.removed.toLocaleString()} mod files removed, original files restored.${report.kept ? ` ${report.kept} world/save file(s) you played were kept.` : ''}` : 'Nothing was deployed.')
        return report
      } catch (err) {
        fail('Purge failed')(err)
        return undefined
      } finally {
        set({ deploying: { ...get().deploying, [gameId]: undefined } })
        await Promise.all([get().refreshMeta(gameId), get().inspect(gameId, true)])
      }
    },

    async switchProfile(gameId, profileId) {
      try {
        await invoke('profiles:setActive', gameId, profileId)
        patchGame(gameId, { activeId: profileId })
        await get().refreshMeta(gameId)
      } catch (err) {
        fail('Could not switch profile')(err)
      }
    },

    async createProfile(gameId, name, cloneFrom) {
      try {
        const p = await invoke('profiles:create', gameId, name, cloneFrom)
        await invoke('profiles:setActive', gameId, p.id)
        await get().load(gameId)
        toast.success(`Profile "${p.name}" created`)
      } catch (err) {
        fail('Could not create profile')(err)
      }
    },

    async renameProfile(gameId, profileId, name) {
      try {
        await invoke('profiles:rename', gameId, profileId, name)
        await get().load(gameId)
      } catch (err) {
        fail('Could not rename profile')(err)
      }
    },

    async deleteProfile(gameId, profileId) {
      try {
        await invoke('profiles:delete', gameId, profileId)
        await get().load(gameId)
      } catch (err) {
        fail('Could not delete profile')(err)
      }
    }
  }
})

let subscribed = false
export function subscribeMods(): void {
  if (subscribed) return
  subscribed = true
  on('deploy:progress', (p) => {
    useMods.setState({ deploying: { ...useMods.getState().deploying, [p.gameId]: p } })
    // Deploys started elsewhere (after a download, a mod removal) end with 'done'; clear the indicator then.
    if (p.phase === 'done') {
      setTimeout(() => {
        const current = useMods.getState().deploying[p.gameId]
        if (current && current !== 'starting' && current.phase === 'done') {
          useMods.setState({ deploying: { ...useMods.getState().deploying, [p.gameId]: undefined } })
          void useMods.getState().refreshMeta(p.gameId)
        }
      }, 600)
    }
  })
  on('setup:progress', (p) => {
    const s = useMods.getState()
    useMods.setState({ operation: { ...s.operation, [p.gameId]: p } })
    if (p.done && s.byGame[p.gameId]) {
      void s.refreshMeta(p.gameId)
      void s.inspect(p.gameId, true)
    }
  })
  on('integration:launch', ({ gameId, check }) => {
    useMods.setState({ launchCheck: { ...useMods.getState().launchCheck, [gameId]: check } })
  })
  on('mods:changed', ({ gameId }) => {
    if (!useMods.getState().byGame[gameId]) return
    void useMods.getState().load(gameId)
    // A new mod can make a loader required (BepInEx, tModLoader).
    void useMods.getState().inspect(gameId)
  })
}
