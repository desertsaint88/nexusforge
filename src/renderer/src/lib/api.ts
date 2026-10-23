import type { EventChannel, IpcEventMap, IpcInvokeMap, InvokeChannel } from '@shared/ipc'

/** Electron prefixes rejected invokes with "Error invoking remote method 'x': Error: ". */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

export function invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<IpcInvokeMap[C]>): Promise<Awaited<ReturnType<IpcInvokeMap[C]>>> {
  return (window.nexus.invoke(channel, ...args) as Promise<Awaited<ReturnType<IpcInvokeMap[C]>>>).catch((err: unknown) => {
    throw new Error(cleanError(err))
  })
}

export function on<E extends EventChannel>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void {
  return window.nexus.on(event, listener)
}

export function pathForFile(file: File): string {
  return window.nexus.pathForFile(file)
}
