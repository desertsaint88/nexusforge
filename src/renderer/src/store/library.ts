import { create } from 'zustand'
import type { Game, Platform, ScanProgress, ScanResult } from '@shared/types'
import type { IpcInvokeMap } from '@shared/ipc'
import { invoke, on } from '../lib/api'
import { toast } from './ui'

interface LibraryState {
  games: Game[]
  loaded: boolean
  running: string[]
  scanning: boolean
  scanProgress: Partial<Record<Platform, ScanProgress>>
  lastScan?: ScanResult
  modCounts: Record<string, number>
  load(): Promise<void>
  scan(): Promise<ScanResult | undefined>
  launch(id: string): Promise<void>
  update(id: string, patch: Parameters<IpcInvokeMap['library:update']>[1]): Promise<Game | undefined>
  refreshModCount(gameId: string): Promise<void>
}

export const useLibrary = create<LibraryState>((set, get) => ({
  games: [],
  loaded: false,
  running: [],
  scanning: false,
  scanProgress: {},
  modCounts: {},
  async load() {
    const [games, running] = await Promise.all([invoke('library:list'), invoke('library:running')])
    set({ games, running, loaded: true })
    const counts: Record<string, number> = {}
    await Promise.all(games.map(async (g) => (counts[g.id] = (await invoke('mods:list', g.id)).length)))
    set({ modCounts: counts })
  },
  async scan() {
    if (get().scanning) return
    set({ scanning: true, scanProgress: {} })
    try {
      const result = await invoke('library:scan')
      set({ lastScan: result })
      return result
    } catch (err) {
      toast.error('Scan failed', (err as Error).message)
      return undefined
    } finally {
      set({ scanning: false })
    }
  },
  async launch(id) {
    const game = get().games.find((g) => g.id === id)
    try {
      await invoke('library:launch', id)
      toast.success(`Launching ${game?.name ?? 'game'}`)
    } catch (err) {
      toast.error(`Couldn't launch ${game?.name ?? 'game'}`, (err as Error).message)
    }
  },
  async update(id, patch) {
    try {
      return await invoke('library:update', id, patch)
    } catch (err) {
      toast.error('Could not save', (err as Error).message)
      return undefined
    }
  },
  async refreshModCount(gameId) {
    const n = (await invoke('mods:list', gameId)).length
    set({ modCounts: { ...get().modCounts, [gameId]: n } })
  }
}))

let subscribed = false
export function subscribeLibrary(): void {
  if (subscribed) return
  subscribed = true
  on('library:changed', (games) => useLibrary.setState({ games }))
  on('library:running', (running) => useLibrary.setState({ running }))
  on('scan:progress', (p) => useLibrary.setState({ scanProgress: { ...useLibrary.getState().scanProgress, [p.platform]: p } }))
  on('mods:changed', ({ gameId }) => void useLibrary.getState().refreshModCount(gameId))
}

export function visibleGames(games: Game[]): Game[] {
  return games.filter((g) => !g.hidden)
}
