import { create } from 'zustand'
import type { AppInfo, Settings } from '@shared/types'
import { invoke, on } from '../lib/api'
import { toast } from './ui'

const SCALE_STEPS = [0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.25, 1.35, 1.5]

/** Ctrl + / Ctrl − / Ctrl 0: interface size, like a browser's zoom. Settings changed in main (Ctrl + wheel) come back as an event. */
export function subscribeAppSettings(): () => void {
  const offEvent = on('settings:changed', (settings) => {
    applyTheme(settings)
    useApp.setState({ settings })
  })
  const onKey = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return
    const s = useApp.getState().settings
    if (!s) return
    const cur = s.uiScale ?? 1
    let next: number | undefined
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') next = SCALE_STEPS.find((x) => x > cur + 0.001) ?? SCALE_STEPS.at(-1)
    else if (e.key === '-' || e.code === 'NumpadSubtract') next = [...SCALE_STEPS].reverse().find((x) => x < cur - 0.001) ?? SCALE_STEPS[0]
    else if (e.key === '0' || e.code === 'Numpad0') next = 1
    if (next === undefined) return
    e.preventDefault()
    if (next !== cur) void useApp.getState().update({ uiScale: next })
  }
  window.addEventListener('keydown', onKey)
  return () => {
    offEvent()
    window.removeEventListener('keydown', onKey)
  }
}

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
