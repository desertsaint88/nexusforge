// Offline check of the sign-in key probe against a copy of the Nexus "API Keys" page layout (2026-10-25): many
// third-party apps with their own "Request Api Key" buttons first, the "Personal API Key" box last. The probe must
// press only the personal button, and then read the key that appears in that box (and not keys of other apps).
//   node scripts/key-probe-check.cjs  (bundles src/main/accounts/key-probe.ts, then runs Electron)
const { execFileSync } = require('child_process')
const { join } = require('path')
const { writeFileSync, mkdirSync } = require('fs')

const root = join(__dirname, '..')
const smoke = join(root, '.smoke')

if (!process.versions.electron) {
  mkdirSync(smoke, { recursive: true })
  execFileSync(process.execPath, ['-e', `require('rolldown').build({ input: ${JSON.stringify(join(root, 'src/main/accounts/key-probe.ts'))}, output: { file: ${JSON.stringify(join(smoke, 'key-probe.bundle.cjs'))}, format: 'cjs' } }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })`], { cwd: root, stdio: 'inherit' })
  execFileSync(require('electron'), [__filename], { cwd: root, stdio: 'inherit' })
  process.exit(0)
}

const { app, BrowserWindow } = require('electron')
const { keyProbe } = require(join(smoke, 'key-probe.bundle.cjs'))
const NEXUS = {
  keyPattern: '[A-Za-z0-9+/]{16,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}',
  section: 'personal api key',
  sectionHeading: '^personal api key$',
  createButton: '^(request|generate|create)( an?| new)?( personal)?( api)? key$',
  loggedOutText: 'please log in again|your session has expired|log in to continue'
}
const FAKE = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHU=--MTIzNDU2Nzg5MGFi--YWJjZGVmZ2hpamtsbW5vcA=='
const OTHER = 'T1RIRVJPVEhFUk9USEVST1RIRVJPVEhFUg==--T1RIRVJPVEhFUg==--T1RIRVJPVEhFUg=='
const app3 = (name, key) => `<div class="w-full space-y-4"><p class="text-heading-xs">${name}</p><p>An app.</p><div class="flex">${key ? `<input readonly value="${key}">` : `<button class="nxm-button" type="button" onclick="window.pressed.push('${name}')"><span>Request Api Key</span></button>`}</div></div>`
const page = `<!doctype html><html><body><h1>API Keys</h1><p>Manage the API keys for all your third-party apps.</p><p>Integrations</p>
${app3('Kortex Mod Manager')}${app3('Mod Organizer 2', OTHER)}${app3('Vortex (v1.8 and older)')}
<div class="w-full space-y-4"><p class="text-heading-xs text-neutral-strong">Personal API Key</p><p><span>If you are developing a new application, you can also access the API using your personal API key.</span></p>
<p class="font-semibold">Warning: Do not enter your personal API key into an application you do not trust.</p>
<div class="flex flex-wrap gap-3" id="personal"><button class="nxm-button nxm-button-primary" type="button" onclick="window.pressed.push('Personal'); document.getElementById('personal').innerHTML = '<div class=w-full><label class=sr-only><span>api key</span></label><input readonly type=text value=${FAKE}></div><button aria-label=&quot;Copy Api Key&quot;></button>'"><span>Request Api Key</span></button></div></div>
<script>window.pressed = []</script></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  writeFileSync(join(smoke, 'key-probe-page.html'), page)
  await win.loadFile(join(smoke, 'key-probe-page.html'))
  const run = (click) => win.webContents.executeJavaScriptInIsolatedWorld(1002, [{ code: keyProbe(NEXUS, 'tip', click) }])
  const first = await run(true)
  const pressed = await win.webContents.executeJavaScript('window.pressed')
  const second = await run(true)
  const ok = first.clicked && first.section === true && first.keys.length === 0 && pressed.join() === 'Personal' && second.keys.length === 1 && second.keys[0] === FAKE && !second.clicked
  console.log(`[key-probe-check] ${ok ? 'PASS' : 'FAIL'} first=${JSON.stringify({ ...first, keys: first.keys.length })} pressed=${JSON.stringify(pressed)} second=${JSON.stringify({ ...second, keys: second.keys.map((k) => (k === FAKE ? 'personal' : 'OTHER')) })}`)
  app.exit(ok ? 0 : 1)
})
