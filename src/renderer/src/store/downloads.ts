import { create } from 'zustand'
import type { DownloadItem, DownloadRequest } from '@shared/types'
import { invoke, on } from '../lib/api'
import { toast } from './ui'

interface DownloadsState {
  items: DownloadItem[]
  load(): Promise<void>
  start(req: DownloadRequest): Promise<DownloadItem | undefined>
  cancel(id: string): Promise<void>
  focus(id: string): Promise<void>
  retry(id: string): Promise<void>
  install(id: string, gameId: string): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export const useDownloads = create<DownloadsState>((set, get) => ({
  items: [],
  async load() {
    set({ items: await invoke('downloads:list') })
  },
  async start(req) {
    try {
      const item = await invoke('downloads:start', req)
      if (item.state === 'waiting') toast.info(`${item.name}: one click left`, 'Click the highlighted button in the download panel; NexusForge installs the file right after.')
      else toast.info(`Downloading ${item.name}`, req.gameId ? 'It will be installed automatically.' : undefined)
      return item
    } catch (err) {
      toast.error('Download not started', (err as Error).message)
      return undefined
    }
  },
  async cancel(id) {
    await invoke('downloads:cancel', id)
  },
  async focus(id) {
    await invoke('downloads:focus', id)
  },
  async retry(id) {
    try {
      await invoke('downloads:retry', id)
    } catch (err) {
      toast.error('Retry failed', (err as Error).message)
    }
  },
  async install(id, gameId) {
    try {
      await invoke('downloads:install', id, gameId)
    } catch (err) {
      toast.error('Install failed', (err as Error).message)
    }
  },
  async remove(id) {
    try {
      set({ items: await invoke('downloads:remove', id) })
    } catch (err) {
      toast.error('Could not remove', (err as Error).message)
    }
  },
  async clear() {
    set({ items: await invoke('downloads:clear') })
    void get().load()
  }
}))

let subscribed = false
export function subscribeDownloads(): void {
  if (subscribed) return
  subscribed = true
  on('downloads:update', (item) => {
    const items = useDownloads.getState().items
    const i = items.findIndex((x) => x.id === item.id)
    useDownloads.setState({ items: i === -1 ? [item, ...items] : items.map((x) => (x.id === item.id ? item : x)) })
  })
}

export const isActive = (d: DownloadItem) => d.state === 'downloading' || d.state === 'installing' || d.state === 'queued' || d.state === 'waiting'
