import { app, BrowserWindow, session } from 'electron'
import { initLogger, logger, setLogLevel } from './logger'
import { registerMediaScheme, handleMediaProtocol } from './media-protocol'
import { getSettings } from './store'
import { registerIpc } from './ipc'
import { createMainWindow, rendererUrl } from './window'
import { loadSources } from './sources/registry'

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

    registerIpc(rendererUrl())
    try {
      await loadSources()
    } catch (err) {
      logger.error('loading mod sources failed', err)
    }
    createMainWindow()

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
