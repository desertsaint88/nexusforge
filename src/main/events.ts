import { BrowserWindow } from 'electron'
import type { EventChannel, IpcEventMap } from '@shared/ipc'

/** Pushes an event to every renderer window. */
export function emit<E extends EventChannel>(event: E, payload: IpcEventMap[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}

export function toast(kind: IpcEventMap['toast']['kind'], title: string, message?: string): void {
  emit('toast', { kind, title, message })
}
