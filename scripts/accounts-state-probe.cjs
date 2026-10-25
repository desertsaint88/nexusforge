// Prints the Accounts list as the app sees it at startup (no keys), then quits. For checking that a sign-in
// survives a restart:  NODE_OPTIONS=--require scripts/accounts-state-probe.cjs  NEXUSFORGE_USER_DATA=<profile>  electron .
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  e.app.whenReady().then(async () => {
    await wait(Number(process.env.PROBE_WAIT || 6000))
    const win = e.BrowserWindow.getAllWindows()[0]
    const list = await win.webContents.executeJavaScript(`window.nexus.invoke('accounts:list')`).catch((err) => String(err))
    const out = Array.isArray(list) ? list.map(({ id, signedIn, user, detail }) => ({ id, signedIn, user, detail })) : list
    console.log('[accounts-state] encryption=' + e.safeStorage.isEncryptionAvailable() + ' ' + JSON.stringify(out))
    require('fs').writeFileSync(process.env.PROBE_OUT || '.smoke/accounts-state.json', JSON.stringify(out, null, 2))
    e.app.exit(0)
  })
}, 0)
