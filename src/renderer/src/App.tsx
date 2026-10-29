import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { on } from './lib/api'
import { subscribeAppSettings, useApp } from './store/app'
import { subscribeLibrary, useLibrary } from './store/library'
import { subscribeMods } from './store/mods'
import { subscribeDownloads, useDownloads } from './store/downloads'
import { useNav, useToasts, type Route } from './store/ui'
import { describeRoute, subscribeBugReports, useBugReport } from './store/bugreport'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BugReportDialog } from './components/BugReportDialog'

let crashOffered = false
import { Sidebar, TitleBar, Toasts } from './components/Chrome'
import { ConfirmHost } from './components/Modal'
import { DependencyDialogHost } from './components/DependencyDialog'
import { SitePanelHost } from './components/SitePanel'
import { CommandPalette } from './components/CommandPalette'
import { LibraryPage } from './pages/LibraryPage'
import { GamePage } from './pages/GamePage'
import { BrowsePage } from './pages/BrowsePage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AccountsPage } from './pages/AccountsPage'
import { AccountPromptHost } from './components/AccountPrompt'
import { subscribeAccounts, useAccounts } from './store/accounts'
import { Onboarding } from './pages/Onboarding'

function Page() {
  const route = useNav((s) => s.route)
  const key = route.name === 'game' ? `game:${route.gameId}` : route.name
  return (
    <ErrorBoundary area={describeRoute(route).page} resetKey={JSON.stringify(route)}>
      <PageInner route={route} pageKey={key} />
    </ErrorBoundary>
  )
}

function PageInner({ route, pageKey: key }: { route: Route; pageKey: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={key}
        className="absolute inset-0"
        initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {route.name === 'library' && <LibraryPage />}
        {route.name === 'game' && <GamePage gameId={route.gameId} tab={route.tab} />}
        {route.name === 'browse' && <BrowsePage gameId={route.gameId} sourceId={route.sourceId} />}
        {route.name === 'downloads' && <DownloadsPage />}
        {route.name === 'accounts' && <AccountsPage />}
        {route.name === 'settings' && <SettingsPage section={route.section} />}
      </motion.div>
    </AnimatePresence>
  )
}

export function App() {
  const settings = useApp((s) => s.settings)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    subscribeLibrary()
    subscribeMods()
    subscribeDownloads()
    subscribeAccounts()
    const offSettings = subscribeAppSettings()
    const offReports = subscribeBugReports()
    const off = on('toast', (t) => useToasts.getState().push(t))
    void Promise.all([useApp.getState().load(), useLibrary.getState().load(), useDownloads.getState().load(), useAccounts.getState().load()]).finally(() => setReady(true))
    return () => {
      off()
      offSettings()
      offReports()
    }
  }, [])

  // NexusForge did not close properly last time: offer a report (once).
  const crash = useBugReport((s) => s.state?.lastSessionCrash)
  useEffect(() => {
    if (!ready || !crash || crashOffered) return
    crashOffered = true
    useToasts.getState().push({
      kind: 'warning',
      title: 'NexusForge did not close properly last time',
      message: `Version ${crash.version}, last seen ${new Date(crash.lastSeen).toLocaleString()}. If it crashed, a report helps fix it.`,
      sticky: true,
      // The report's "Last session" section carries the time and the last errors.
      action: { id: 'report', label: 'Report it', report: { title: 'NexusForge closed unexpectedly', origin: 'crash', description: 'NexusForge closed by itself (or froze and had to be closed). What were you doing?\n' } }
    })
  }, [ready, crash])

  return (
    <MotionConfig reducedMotion={settings?.reduceMotion ? 'always' : 'never'}>
      <div className="app-backdrop relative flex h-full flex-col overflow-hidden">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="content-panel relative min-w-0 flex-1 overflow-hidden rounded-tl-2xl">
            {ready && <Page />}
          </main>
        </div>
        <AnimatePresence>{ready && settings && !settings.firstRunComplete && <Onboarding />}</AnimatePresence>
        <SitePanelHost />
        <CommandPalette />
        <Toasts />
        <ConfirmHost />
        <DependencyDialogHost />
        <AccountPromptHost />
        <BugReportDialog />
      </div>
    </MotionConfig>
  )
}
