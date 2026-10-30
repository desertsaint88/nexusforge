import { create } from 'zustand'
import type { ResolvedDependency, Toast } from '@shared/types'

export type GameTab = 'mods' | 'conflicts' | 'profiles' | 'reshade' | 'diagnose' | 'settings'
export type SettingsSection = 'general' | 'library' | 'mods' | 'sources' | 'advanced' | 'about'

export type Route =
  | { name: 'library' }
  | { name: 'game'; gameId: string; tab?: GameTab }
  | { name: 'browse'; gameId?: string; sourceId?: string }
  | { name: 'downloads' }
  | { name: 'accounts' }
  | { name: 'settings'; section?: SettingsSection }

interface NavState {
  route: Route
  history: Route[]
  navigate(route: Route): void
  back(): void
}

export const useNav = create<NavState>((set, get) => ({
  route: { name: 'library' },
  history: [],
  navigate(route) {
    const current = get().route
    if (JSON.stringify(current) === JSON.stringify(route)) return
    set({ route, history: [...get().history.slice(-30), current] })
  },
  back() {
    const h = get().history
    if (!h.length) return
    set({ route: h[h.length - 1], history: h.slice(0, -1) })
  }
}))

interface ToastState {
  toasts: Toast[]
  push(t: Omit<Toast, 'id'>): void
  dismiss(id: string): void
}

let toastSeq = 0
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = `t${++toastSeq}`
    // Every error can be reported from where it shows up.
    const action = t.action ?? (t.kind === 'error' ? { id: 'report' as const, label: 'Report', report: { title: t.title, error: { message: t.message ? `${t.title}: ${t.message}` : t.title }, origin: 'toast' } } : undefined)
    set({ toasts: [...get().toasts.slice(-4), { ...t, action, id }] })
    if (!t.sticky) setTimeout(() => get().dismiss(id), t.kind === 'error' ? 10_000 : 4500)
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) })
  }
}))

export const toast = {
  success: (title: string, message?: string) => useToasts.getState().push({ kind: 'success', title, message }),
  error: (title: string, message?: string) => useToasts.getState().push({ kind: 'error', title, message }),
  info: (title: string, message?: string) => useToasts.getState().push({ kind: 'info', title, message }),
  warning: (title: string, message?: string) => useToasts.getState().push({ kind: 'warning', title, message })
}

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  resolve(ok: boolean): void
}

interface ConfirmState {
  request?: ConfirmRequest
  ask(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>
  close(ok: boolean): void
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  request: undefined,
  ask(opts) {
    return new Promise<boolean>((resolve) => set({ request: { ...opts, resolve } }))
  },
  close(ok) {
    get().request?.resolve(ok)
    set({ request: undefined })
  }
}))

export const confirm = (opts: Omit<ConfirmRequest, 'resolve'>) => useConfirm.getState().ask(opts)

export interface DependencyChoice {
  /** Dependencies to download and install. */
  install: ResolvedDependency[]
  /** Enable required dependencies that are installed but switched off. */
  enableDisabled: boolean
}

interface DependencyRequest {
  modName: string
  gameName: string
  deps: ResolvedDependency[]
  resolve(choice: DependencyChoice | null): void
}

interface DependencyState {
  request?: DependencyRequest
  ask(modName: string, gameName: string, deps: ResolvedDependency[]): Promise<DependencyChoice | null>
  close(choice: DependencyChoice | null): void
}

export const useDependencyDialog = create<DependencyState>((set, get) => ({
  request: undefined,
  ask(modName, gameName, deps) {
    return new Promise((resolve) => set({ request: { modName, gameName, deps, resolve } }))
  },
  close(choice) {
    get().request?.resolve(choice)
    set({ request: undefined })
  }
}))
