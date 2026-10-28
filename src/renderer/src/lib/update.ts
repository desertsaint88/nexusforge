import { useDownloads, isActive } from '../store/downloads'
import { useUpdater } from '../store/bugreport'
import { confirm, toast } from '../store/ui'

/** Asks, then downloads and installs the waiting update (NexusForge restarts by itself). */
export async function startUpdate(): Promise<void> {
  const status = useUpdater.getState().status
  if (!status?.version) return
  const running = useDownloads.getState().items.filter(isActive).length
  const ok = await confirm({
    title: `Update to NexusForge ${status.version}?`,
    message:
      (status.mode === 'auto'
        ? 'NexusForge downloads the update, installs it and restarts by itself. Your library, mods, profiles and settings stay as they are.'
        : 'NexusForge downloads the installer of the new version, checks it and starts it. After that, NexusForge updates itself inside the app.') +
      (running ? ` ${running} download(s) are still running and will stop.` : ''),
    confirmLabel: 'Update now'
  })
  if (!ok) return
  try {
    await useUpdater.getState().install()
  } catch (err) {
    toast.error('The update failed', (err as Error).message)
  }
}
