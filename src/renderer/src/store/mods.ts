import { create } from 'zustand'
import type { ConflictReport, DeployProgress, DeployReport, DeployStatus, InstalledMod, LinkCapabilities, Profile } from '@shared/types'
import { invoke, on } from '../lib/api'
import { toast } from './ui'

export interface GameMods {
  mods: InstalledMod[]
  profiles: Profile[]
  activeId: string
  conflicts?: ConflictReport
  status?: DeployStatus
  caps?: LinkCapabilities
  loaded: boolean
}

interface ModsState {
  byGame: Record<string, GameMods>
  deploying: Record<string, DeployProgress | 'starting' | undefined>
  installing: Record<string, number>
  lastReport: Record<string, DeployReport | undefined>
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

    async load(gameId) {
      try {
        const [mods, { profiles, activeId }] = await Promise.all([invoke('mods:list', gameId), invoke('profiles:list', gameId)])
        patchGame(gameId, { mods, profiles, activeId, loaded: true })
        await get().refreshMeta(gameId)
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
        const report = await invoke('deploy:run', gameId)
        set({ lastReport: { ...get().lastReport, [gameId]: report } })
        const total = report.methods.symlink + report.methods.hardlink + report.methods.copy
        if (report.errors.length) toast.warning(`Deployed with ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`, report.errors[0])
        else toast.success('Mods deployed', `${total.toLocaleString()} files live · ${report.placed} placed, ${report.removed} removed in ${(report.durationMs / 1000).toFixed(1)} s`)
        for (const f of report.fallbacks) toast.info('Deployment fallback', f)
        if (report.rescued) toast.warning(`${report.rescued} changed file${report.rescued === 1 ? '' : 's'} kept`, 'Files the game changed after deployment were moved to the overwrite folder instead of being deleted.')
        return report
      } catch (err) {
        fail('Deployment failed')(err)
        return undefined
      } finally {
        set({ deploying: { ...get().deploying, [gameId]: undefined } })
        await get().refreshMeta(gameId)
      }
    },

    async purge(gameId) {
      set({ deploying: { ...get().deploying, [gameId]: 'starting' } })
      try {
        const report = await invoke('deploy:purge', gameId)
        if (report.errors.length) toast.warning('Purged with problems', report.errors[0])
        else toast.success('Game restored', `${report.removed.toLocaleString()} mod files removed, original files restored.`)
        return report
      } catch (err) {
        fail('Purge failed')(err)
        return undefined
      } finally {
        set({ deploying: { ...get().deploying, [gameId]: undefined } })
        await get().refreshMeta(gameId)
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
    // Deploys started elsewhere (another view, a mod removal) end with 'finishing'; clear the indicator then.
    if (p.phase === 'finishing') {
      setTimeout(() => {
        const current = useMods.getState().deploying[p.gameId]
        if (current && current !== 'starting' && current.phase === 'finishing') {
          useMods.setState({ deploying: { ...useMods.getState().deploying, [p.gameId]: undefined } })
          void useMods.getState().refreshMeta(p.gameId)
        }
      }, 600)
    }
  })
  on('mods:changed', ({ gameId }) => {
    if (useMods.getState().byGame[gameId]) void useMods.getState().load(gameId)
  })
}
