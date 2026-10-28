import { create } from 'zustand'
import type { Game, GameModInfo, Platform, ScanProgress, ScanResult } from '@shared/types'
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
  /** Installed-mod scan per game (mod support, mods found in the game folders). */
  detected: Record<string, GameModInfo>
  load(): Promise<void>
  scan(): Promise<ScanResult | undefined>
  /** variant: 'modded' through the game's mod loader (tModLoader), 'vanilla' without mods; default = the game's own start. */
  launch(id: string, variant?: 'default' | 'vanilla' | 'modded'): Promise<void>
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
  detected: {},
  async load() {
    const [games, running, detected] = await Promise.all([invoke('library:list'), invoke('library:running'), invoke('mods:detectedAll').catch(() => ({}))])
    set({ games, running, detected, loaded: true })
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
  async launch(id, variant) {
    const game = get().games.find((g) => g.id === id)
    try {
      await invoke('library:launch', id, variant)
      toast.success(`Launching ${game?.name ?? 'game'}${variant === 'modded' ? ' with mods' : variant === 'vanilla' ? ' without mods' : ''}`)
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

const SCANNERS: Platform[] = ['steam', 'epic', 'xbox', 'gog', 'custom']

let subscribed = false
export function subscribeLibrary(): void {
  if (subscribed) return
  subscribed = true
  on('library:changed', (games) => useLibrary.setState({ games }))
  on('library:running', (running) => useLibrary.setState({ running }))
  // Scans also start without a click (at startup), so the progress events drive the "Scanning…" state.
  on('scan:progress', (p) => {
    const progress = { ...useLibrary.getState().scanProgress, [p.platform]: p }
    const busy = p.status === 'scanning' || !SCANNERS.every((s) => progress[s] && progress[s]!.status !== 'scanning')
    useLibrary.setState({ scanProgress: progress, scanning: busy })
  })
  on('mods:changed', ({ gameId }) => void useLibrary.getState().refreshModCount(gameId))
  on('mods:detected', (info) => useLibrary.setState({ detected: { ...useLibrary.getState().detected, [info.gameId]: info } }))
}

export function visibleGames(games: Game[]): Game[] {
  return games.filter((g) => !g.hidden)
}

/** Mods a game has: the ones NexusForge manages plus the ones found in its folders by other means. */
export function installedCount(gameId: string, modCounts: Record<string, number>, detected: Record<string, GameModInfo>): number {
  const outside = detected[gameId]?.mods.filter((m) => m.kind !== 'loader' && !m.managedModId).length ?? 0
  return (modCounts[gameId] ?? 0) + outside
}
