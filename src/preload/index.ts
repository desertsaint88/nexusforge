import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type InvokeChannel, type NexusApi } from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventsAllowed = new Set<string>(EVENT_CHANNELS)

const api: NexusApi = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(event: EventChannel, listener: (payload: unknown) => void) {
    if (!eventsAllowed.has(event)) throw new Error(`Blocked IPC event: ${event}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  pathForFile(file: File) {
    return webUtils.getPathForFile(file)
  }
} as NexusApi

contextBridge.exposeInMainWorld('nexus', api)
