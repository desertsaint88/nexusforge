import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { on } from './lib/api'
import { useApp } from './store/app'
import { subscribeLibrary, useLibrary } from './store/library'
import { subscribeMods } from './store/mods'
import { subscribeDownloads, useDownloads } from './store/downloads'
import { useNav, useToasts } from './store/ui'
import { Sidebar, TitleBar, Toasts } from './components/Chrome'
import { ConfirmHost } from './components/Modal'
import { LibraryPage } from './pages/LibraryPage'
import { GamePage } from './pages/GamePage'
import { BrowsePage } from './pages/BrowsePage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { Onboarding } from './pages/Onboarding'

function Page() {
  const route = useNav((s) => s.route)
  const key = route.name === 'game' ? `game:${route.gameId}` : route.name
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
    const off = on('toast', (t) => useToasts.getState().push(t))
    void Promise.all([useApp.getState().load(), useLibrary.getState().load(), useDownloads.getState().load()]).finally(() => setReady(true))
    return off
  }, [])

  return (
    <MotionConfig reducedMotion={settings?.reduceMotion ? 'always' : 'never'}>
      <div className="app-backdrop noise relative flex h-full flex-col overflow-hidden">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="relative min-w-0 flex-1 overflow-hidden rounded-tl-3xl border-t border-l border-white/[0.06] bg-ink-900/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            {ready && <Page />}
          </main>
        </div>
        <AnimatePresence>{ready && settings && !settings.firstRunComplete && <Onboarding />}</AnimatePresence>
        <Toasts />
        <ConfirmHost />
      </div>
    </MotionConfig>
  )
}
