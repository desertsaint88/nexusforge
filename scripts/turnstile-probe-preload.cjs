// Probe preload: gives every frame a window.chrome like Google Chrome's (Electron leaves it empty).
const { contextBridge } = require('electron')

contextBridge.executeInMainWorld({
  func: () => {
    const c = window.chrome || {}
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
        runningState: () => 'cannot_run'
      }
    }
    if (!c.csi) c.csi = () => ({ onloadT: Date.now(), startE: Date.now() - 300, pageT: performance.now(), tran: 15 })
    if (!c.loadTimes) {
      c.loadTimes = () => ({
        requestTime: performance.timeOrigin / 1000,
        startLoadTime: performance.timeOrigin / 1000,
        commitLoadTime: performance.timeOrigin / 1000 + 0.1,
        finishDocumentLoadTime: 0,
        finishLoadTime: 0,
        firstPaintTime: 0,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2'
      })
    }
    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: c, writable: true, configurable: true })
  }
})
