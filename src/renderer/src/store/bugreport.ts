import { create } from 'zustand'
import type { AppUpdateStatus, BugReportInput, BugReportState } from '@shared/types'
import { invoke, on } from '../lib/api'
import { useNav, type Route } from './ui'
import { useLibrary } from './library'

/** "game:Grand Theft Auto V / diagnose": where the user is, for the report. */
export function describeRoute(route: Route): { page: string; gameId?: string } {
  if (route.name === 'game') {
    const g = useLibrary.getState().games.find((x) => x.id === route.gameId)
    return { page: `game: ${g?.name ?? route.gameId}${route.tab ? ` / ${route.tab}` : ''}`, gameId: route.gameId }
  }
  if (route.name === 'browse') return { page: `browse${route.sourceId ? `: ${route.sourceId}` : ''}`, gameId: route.gameId }
  if (route.name === 'settings') return { page: `settings${route.section ? `: ${route.section}` : ''}` }
  return { page: route.name }
}

interface BugReportStore {
  open: boolean
  draft: Partial<BugReportInput>
  state?: BugReportState
  /** Opens the report dialog (a picture of the window is taken first). */
  openReport(prefill?: Partial<BugReportInput>): Promise<void>
  close(): void
  refresh(): Promise<void>
}

export const useBugReport = create<BugReportStore>((set) => ({
  open: false,
  draft: {},
  state: undefined,
  async openReport(prefill = {}) {
    await invoke('bugreport:capture').catch(() => false)
    const where = describeRoute(useNav.getState().route)
    set({ open: true, draft: { origin: 'manual', ...where, ...prefill } })
    void useBugReport.getState().refresh()
  },
  close() {
    set({ open: false })
  },
  async refresh() {
    const state = await invoke('bugreport:state').catch(() => undefined)
    if (state) set({ state })
  }
}))

export const reportBug = (prefill?: Partial<BugReportInput>) => void useBugReport.getState().openReport(prefill)

interface UpdaterStore {
  status?: AppUpdateStatus
  check(): Promise<void>
  install(): Promise<void>
}

export const useUpdater = create<UpdaterStore>((set) => ({
  status: undefined,
  async check() {
    set({ status: await invoke('updater:check') })
  },
  async install() {
    await invoke('updater:install')
  }
}))

let errorsInstalled = false

/** Errors in the window go to the main process (recorded for bug reports, written to the log). */
function installRendererErrorCapture(): void {
  if (errorsInstalled) return
  errorsInstalled = true
  const send = (message: string, detail?: string) => {
    const { page } = describeRoute(useNav.getState().route)
    void invoke('bugreport:rendererError', { message, detail, page }).catch(() => {})
  }
  window.addEventListener('error', (e) => send(e.message || 'Script error', e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    send(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined)
  })
}

/** Keeps the report and update state current. */
export function subscribeBugReports(): () => void {
  installRendererErrorCapture()
  void useBugReport.getState().refresh()
  void invoke('updater:state').then((status) => useUpdater.setState({ status }), () => {})
  const off1 = on('bugreport:changed', (state) => useBugReport.setState({ state }))
  const off2 = on('updater:state', (status) => useUpdater.setState({ status }))
  return () => {
    off1()
    off2()
  }
}
