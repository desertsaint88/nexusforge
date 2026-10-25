import { app, BrowserWindow, session } from 'electron'
import { initLogger, logger, setLogLevel } from './logger'
import { registerMediaScheme, handleMediaProtocol } from './media-protocol'
import { getSettings, runOnce, setSettings } from './store'
import { registerIpc } from './ipc'
import { createMainWindow, rendererUrl } from './window'
import { loadSources } from './sources/registry'
import { refreshArtwork, refreshGluedNames, scanLibrary } from './library/library'
import { rescanGames } from './mods/detect'
import { clearCloudflareCookies } from './web/browser'
import { NEXUS_PARTITION } from './sources/nexus'

/**
 * Work done after the window is up: one-time upgrade steps, then (unless turned off) a scan for new games
 * followed by a scan of every game's folders for installed mods.
 */
async function startupWork(): Promise<void> {
  // Cloudflare clearances earned with the old fake-Chrome user agent no longer match; drop them once.
  await runOnce('cloudflare-honest-ua', async () => {
    for (const p of [NEXUS_PARTITION, 'persist:modio', 'persist:curseforge-console', 'persist:web']) {
      const n = await clearCloudflareCookies(p).catch(() => 0)
      if (n) logger.info(`cleared ${n} stale Cloudflare cookie(s) in ${p}`)
    }
  })
  const settings = getSettings()
  if (settings.scanOnStartup && settings.firstRunComplete) {
    await scanLibrary().catch((err) => logger.error('startup library scan failed', err))
  } else {
    await refreshArtwork().catch((err) => logger.warn('artwork refresh failed', err))
  }
  if (settings.scanOnStartup) await rescanGames().catch((err) => logger.error('startup mod scan failed', err))
  if (settings.autoFetchArtwork) await runOnce('store-names-glued', refreshGluedNames).catch(() => {})
}

// Lets tests and portable setups keep all data in a separate folder.
if (process.env.NEXUSFORGE_USER_DATA) app.setPath('userData', process.env.NEXUSFORGE_USER_DATA)

// Must happen before the app is ready.
registerMediaScheme()
app.setAppUserModelId('com.nexusforge.app')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    initLogger()
    setLogLevel(getSettings().logLevel)
    handleMediaProtocol()

    // The renderer never needs camera, notifications, geolocation, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

    // 1.2 moved to a darker, muted look; the old default violet becomes graphite once (a chosen accent stays).
    await runOnce('theme-dark-1.2', async () => {
      if (getSettings().accent === 'violet') setSettings({ accent: 'graphite' })
    })

    registerIpc(rendererUrl())
    try {
      await loadSources()
    } catch (err) {
      logger.error('loading mod sources failed', err)
    }
    createMainWindow()
    // Let the window paint first; the scans run in the background and report through events.
    setTimeout(() => void startupWork(), 1500)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
