import { create } from 'zustand'
import type { AppInfo, Settings } from '@shared/types'
import { invoke } from '../lib/api'
import { toast } from './ui'

interface AppState {
  settings?: Settings
  info?: AppInfo
  load(): Promise<void>
  update(patch: Partial<Settings>): Promise<void>
}

function applyTheme(s: Settings): void {
  document.documentElement.dataset.accent = s.accent
  document.documentElement.dataset.reduceMotion = String(s.reduceMotion)
}

export const useApp = create<AppState>((set, get) => ({
  settings: undefined,
  info: undefined,
  async load() {
    const [settings, info] = await Promise.all([invoke('settings:get'), invoke('app:info')])
    applyTheme(settings)
    set({ settings, info })
  },
  async update(patch) {
    const prev = get().settings
    if (prev) {
      const optimistic = { ...prev, ...patch }
      applyTheme(optimistic)
      set({ settings: optimistic })
    }
    try {
      const settings = await invoke('settings:set', patch)
      applyTheme(settings)
      set({ settings })
    } catch (err) {
      if (prev) {
        applyTheme(prev)
        set({ settings: prev })
      }
      toast.error('Could not save settings', (err as Error).message)
    }
  }
}))
