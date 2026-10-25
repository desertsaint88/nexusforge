// Live checks for the mod sources, dependency handling and site-window downloads.
// Usage: npm run build && node scripts/smoke-sources.mjs   (screenshots in .smoke/sources)
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'sources')
const shots = join(base, 'shots')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const env = { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata') }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 900 }))
const shot = async (name, p = page) => {
  await p.waitForTimeout(700)
  await p.screenshot({ path: join(shots, `${name}.png`) })
}
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
const safe = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    const lines = e.message.split('\n')
    const waiting = lines.find((l) => /waiting for/.test(l))?.trim()
    check(name, false, [lines[0], waiting].filter(Boolean).join(' – '))
    await page.screenshot({ path: join(shots, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  }
}
const fake = async (name, exe, extraDirs = []) => {
  const dir = join(base, 'games', name)
  mkdirSync(dir, { recursive: true })
  for (const d of extraDirs) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, exe), Buffer.alloc(400 * 1024))
  const g = await invoke('library:addManual', { name, path: join(dir, exe) })
  await invoke('library:update', g.id, { favorite: true })
  return { ...g, dir }
}
// Closes whatever dialog or panel is open, so the sidebar is clickable again.
const resetUi = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  await invoke('sitepanel:hide').catch(() => {})
}
// The page shown in the in-app site panel (a native view the renderer screenshot doesn't include).
const panelPage = (js) =>
  app.evaluate(async ({ webContents }, js) => {
    const wc = webContents.getAllWebContents().find((w) => /^https?:/.test(w.getURL()) && !w.isDestroyed())
    if (!wc) return undefined
    return js ? wc.executeJavaScript(js) : wc.getURL()
  }, js)
const panelShot = async (name) => {
  const b64 = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /^https?:/.test(w.getURL()) && !w.isDestroyed())
    return wc ? (await wc.capturePage()).toPNG().toString('base64') : ''
  })
  if (b64) writeFileSync(join(shots, `${name}.png`), Buffer.from(b64, 'base64'))
}
// Opens Browse from the game's own page (favorites sit in the sidebar), so the game is preselected.
const openBrowse = async (gameName, sourceName) => {
  await resetUi()
  await page.locator('aside button', { hasText: gameName }).first().click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: sourceName, exact: true }).click()
  await page.waitForTimeout(3500)
}

await page.waitForSelector('text=NexusForge')
await invoke('settings:set', { firstRunComplete: true, customFolders: [] })
await invoke('library:scan')
// The renderer loaded its settings before the change above; reload so the welcome screen is gone.
await page.reload()
await page.waitForSelector('text=Library')
await page.waitForTimeout(800)

// --- Every drive: games outside the launchers are found without any folder in settings (read-only) ----
await safe('drives', async () => {
  const roots = await invoke('library:driveRoots')
  const games = await invoke('library:list')
  const local = games.filter((g) => g.platform === 'custom')
  const drives = [...new Set(local.map((g) => g.installDir.slice(0, 2).toUpperCase()))]
  check('game folders found on every drive', roots.length > 0, roots.join(' | '))
  check('games from more than one drive', drives.length > 1, `${local.length} games on ${drives.join(', ')}: ${local.slice(0, 6).map((g) => g.name).join(', ')}…`)
  const names = games.map((g) => g.name)
  // Titles may already carry the store's spelling ("Hell Let Loose: Vietnam"); punctuation doesn't count.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  check('release folder names cleaned', names.some((n) => norm(n) === 'hellletloosevietnam') && !names.some((n) => /OFME|v\d+ \d+ \d+/.test(n)), names.filter((n) => /hell|people|uplink/i.test(n)).join(', '))
  // Every game installed on this PC (C:\Games, E:\Games incl. "From D", Steam, the PS2 disc for PCSX2).
  const expected = [
    'BeamNG.drive', 'Bodycam', 'Call of Duty - Modern Warfare 4', 'Firewatch', 'GROUND BRANCH', 'Ready Or Not', 'X-Plane 12', 'Jak II - Renegade (PS2)',
    'VRChat', 'Casualties: Unknown Demo', 'Zula Global', 'ALTEREDBLOOD+ Demo', 'Call of Duty®',
    'Call Of Duty Black Ops III', 'GarrysMod', 'Grand Theft Auto V', 'Hell Let Loose Vietnam', 'People Playground', 'Sniper Killer', 'Watch Dogs',
    'Way of the Hunter 2', 'Wolfenstein Youngblood', 'Evil Egg', 'FNAF In Real Time', 'Rolla Demo', 'Terraria', 'Uplink'
  ]
  const missing = expected.filter((n) => !names.some((x) => norm(x) === norm(n)))
  check(`all ${expected.length} games on this PC listed`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${games.length} games in the library`)
  const jak = games.find((g) => /Jak II/.test(g.name))
  check('PS2 game starts in PCSX2', Boolean(jak && /pcsx2/i.test(jak.launch.exe ?? '') && jak.launch.args?.some((a) => /\.iso$/i.test(a))), jak ? `${jak.launch.exe} ${jak.launch.args?.join(' ')}` : 'not found')
  const beam = games.find((g) => g.name === 'BeamNG.drive')
  check('BeamNG deploys into its user folder', Boolean(beam && /BeamNG\.drive[\\/]current[\\/]mods$/i.test(beam.modding.targetDir)), beam?.modding.targetDir)
  await page.getByRole('button', { name: /^Library/ }).first().click()
  await page.waitForTimeout(2500)
  await shot('00-library')
})

// --- Nexus: Casualties: Unknown --------------------------------------------------------
await safe('nexus casualties', async () => {
  const games = await invoke('library:list')
  const cu = games.find((g) => /casualties/i.test(g.name))
  if (!cu) return check('casualties game present', false, 'not in this library')
  await invoke('library:update', cu.id, { favorite: true })
  const b = await invoke('sources:bindings', 'nexus', cu.id)
  check('nexus finds Casualties: Unknown', b[0]?.value === 'scavprototype', b.slice(0, 3).map((x) => `${x.label}=${x.value}`).join(', '))
  const res = await invoke('sources:search', 'nexus', '', cu.id)
  check('nexus lists Casualties mods', res.length > 20, `${res.length} results, top: ${res.slice(0, 3).map((r) => r.name).join(' | ')}`)
  let withReq
  for (const r of res.slice(0, 25)) {
    const d = await invoke('sources:details', 'nexus', r.id, cu.id)
    if (d.requirements?.length) {
      withReq = { r, d }
      break
    }
  }
  check('nexus requirements read', Boolean(withReq), withReq ? `${withReq.r.name} needs ${withReq.d.requirements.map((x) => x.name).join(', ')}` : 'none of the top 25 list requirements')
  if (withReq) {
    const deps = await invoke('sources:dependencies', 'nexus', withReq.r.id, undefined, cu.id)
    const bep = deps.find((d) => /bepinex/i.test(d.name))
    check('BepInEx requirement installable in-app', !bep || (bep.sourceId === 'frameworks' && bep.installable), bep ? `${bep.name} → ${bep.sourceId}/${bep.modId}${bep.installed ? ' (already there)' : ''}` : 'no BepInEx requirement')
  }
  await openBrowse(cu.name, 'Nexus Mods')
  await shot('01-nexus-casualties')
  const target = withReq?.r ?? res[0]
  await page.locator('button', { hasText: target.name }).first().click()
  await page.waitForTimeout(4000)
  await shot('02-nexus-details')
  // Install: dependency dialog first (if any), then the Nexus page opens in the in-app panel and waits for the click.
  // "Only this mod" keeps the real game untouched: nothing here is deployed, but BepInEx isn't needed for the check.
  await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).first().click()
  await page.waitForTimeout(2500)
  if (await page.locator('text=needs other mods').count()) {
    await shot('03-dependency-dialog')
    await page.getByRole('button', { name: 'Only this mod' }).click()
    await page.waitForTimeout(1500)
  }
  // Not signed in yet: NexusForge asks for the (free) account first and opens the Nexus login inside the app.
  const prompt = page.getByRole('dialog').filter({ hasText: 'Sign in to Nexus Mods' })
  await prompt.waitFor({ timeout: 10_000 })
  check('asks to sign in before a Nexus download', true)
  await shot('03b-nexus-sign-in-prompt')
  await prompt.getByRole('button', { name: 'Sign in', exact: true }).click()
  let login
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500)
    login = await invoke('sitepanel:state')
    if (login.open && /nexusmods\.com/.test(login.url) && !login.loading) break
  }
  const loginWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check('Nexus login opens inside the app', login.open && /users\.nexusmods\.com\/auth\/sign_in/.test(login.url) && loginWindows === 1, `title="${login.title}" url=${login.url.slice(0, 70)} windows=${loginWindows}`)
  await page.waitForTimeout(2500)
  const loginForm = await panelPage(`!!document.querySelector('input[name="user[login]"]') && !!document.querySelector('input[name="user[password]"]')`).catch(() => false)
  check('Nexus login form shown in the panel', loginForm === true)
  await shot('03c-nexus-sign-in-frame')
  await panelShot('03d-nexus-login-page')
  await invoke('sitepanel:cancel')
  await page.waitForTimeout(1200)
  check('cancelling the sign-in starts no download', (await invoke('downloads:list')).length === 0 && !(await invoke('sitepanel:state')).open)
  // The download page itself also works without the account step (the user can log in on it): start it directly.
  await resetUi()
  const targetDetails = await invoke('sources:details', 'nexus', target.id, cu.id)
  await invoke('downloads:start', { sourceId: 'nexus', modId: target.id, versionId: targetDetails.versions[0].id, gameId: cu.id, name: target.name })
  let panel
  for (let i = 0; i < 20; i++) {
    panel = await invoke('sitepanel:state')
    if (panel.open) break
    await page.waitForTimeout(500)
  }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check('nexus page opens inside the app', panel.open && windows === 1, `panel=${panel.open} title="${panel.title}" windows=${windows}`)
  await page.waitForTimeout(9000)
  panel = await invoke('sitepanel:state')
  // Nexus renders its buttons inside web components, so look through shadow roots too.
  const marked = await panelPage(
    `(() => { const all = (r, out = []) => { out.push(...r.querySelectorAll('[data-nexusforge]')); for (const h of r.querySelectorAll('*')) if (h.shadowRoot) all(h.shadowRoot, out); return out }; return all(document)[0]?.dataset.nexusforge ?? '' })()`
  ).catch(() => '')
  check('panel points at the button', Boolean(marked) || /log in/i.test(panel.hint), `highlight="${marked}" hint="${panel.hint.slice(0, 90)}"`)
  await shot('04-nexus-panel-frame')
  await panelShot('04b-nexus-panel-page')
  const dl = await invoke('downloads:list')
  check('download waits for the click', dl.some((d) => d.state === 'waiting'), dl.map((d) => `${d.name}:${d.state}`).join(', '))
  await invoke('sitepanel:hide')
  await resetUi()
  await page.getByRole('button', { name: /^Downloads/ }).first().click()
  await shot('05-downloads-waiting')
  for (const d of dl.filter((x) => x.state === 'waiting')) await invoke('downloads:cancel', d.id)
  await page.waitForTimeout(800)
  const after = await invoke('sitepanel:state')
  check('cancel closes the page', !after.open && after.waiting.length === 0, `open=${after.open} waiting=${after.waiting.length}`)
})

// --- Mod loaders: BepInEx straight from GitHub into a throwaway Unity game --------------------------
await safe('mod loaders', async () => {
  const u = await fake('Unity Test', 'UnityTest.exe', ['UnityTest_Data/Managed'])
  const d = await invoke('sources:details', 'frameworks', 'bepinex', u.id)
  check('BepInEx build chosen for the game', /BepInEx_win_x64_5\./.test(d.versions[0]?.fileName ?? ''), d.versions.slice(0, 3).map((v) => v.fileName).join(', '))
  await invoke('downloads:start', { sourceId: 'frameworks', modId: 'bepinex', versionId: d.versions[0].id, gameId: u.id, name: 'BepInEx' })
  let mods = []
  for (let i = 0; i < 60 && !mods.length; i++) {
    await page.waitForTimeout(1000)
    mods = await invoke('mods:list', u.id)
    const item = (await invoke('downloads:list')).find((x) => x.gameId === u.id)
    if (item?.state === 'failed') throw new Error(item.error)
  }
  await invoke('deploy:run', u.id)
  const placed = existsSync(join(u.dir, 'winhttp.dll')) && existsSync(join(u.dir, 'BepInEx', 'core'))
  check('BepInEx downloaded, installed and deployed', mods.length === 1 && placed, mods.map((m) => `${m.name} ${m.version ?? ''}`).join(', '))
  await invoke('deploy:purge', u.id)
  check('purge removes it again', !existsSync(join(u.dir, 'winhttp.dll')))
})

// --- Thunderstore: dependencies auto-installed in order -----------------------------------
await safe('thunderstore deps', async () => {
  const v = await fake('Valheim', 'valheim.exe')
  const res = await invoke('sources:search', 'thunderstore', 'ValheimPlus', v.id)
  const mod = res.find((r) => /valheimplus/i.test(r.id) && !/bepinexpack/i.test(r.id))
  const deps = await invoke('sources:dependencies', 'thunderstore', mod.id, undefined, v.id)
  check('thunderstore dependency resolved', deps.some((d) => /BepInExPack/i.test(d.modId) && !d.installed), deps.map((d) => d.name).join(', '))
  await openBrowse('Valheim', 'Thunderstore')
  await page.getByPlaceholder(/Search Thunderstore/).fill('ValheimPlus')
  await page.waitForTimeout(3500)
  await page.locator('button', { hasText: mod.name }).first().click()
  await page.waitForTimeout(3500)
  await shot('06-thunderstore-details')
  await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).first().click()
  await page.locator('text=needs other mods').waitFor({ timeout: 20_000 })
  await shot('07-thunderstore-dependency-dialog')
  await page.getByRole('button', { name: /^Install \d+ mods/ }).click()
  let mods = []
  for (let i = 0; i < 90 && mods.length < 2; i++) {
    await page.waitForTimeout(1000)
    mods = await invoke('mods:list', v.id)
  }
  check('mod + dependency installed', mods.length >= 2, mods.map((m) => m.name).join(', '))
  await page.waitForTimeout(1500)
  const { profiles, activeId } = await invoke('profiles:list', v.id)
  const order = profiles.find((p) => p.id === activeId).order.map((id) => mods.find((m) => m.id === id)?.name ?? id)
  const libIndex = order.findIndex((n) => /bepinex/i.test(n))
  const modIndex = order.findIndex((n) => /valheimplus/i.test(n))
  check('dependency loads first', libIndex >= 0 && libIndex < modIndex, order.join(' → '))
  await page.keyboard.press('Escape')
  await page.locator('button:has-text("Valheim")').first().click()
  await page.waitForTimeout(1500)
  await shot('08-valheim-mods')
})

// --- Steam Workshop via SteamCMD (Garry's Mod) -------------------------------------------
await safe('workshop', async () => {
  const g = await fake("Garry's Mod", 'gmod.exe', ['garrysmod/addons'])
  const b = await invoke('sources:bindings', 'steamworkshop', g.id)
  check('workshop finds GMod app id', b[0]?.value === '4000', b.map((x) => x.value).join(','))
  const res = await invoke('sources:search', 'steamworkshop', 'nyan cat', g.id)
  check('workshop search', res.length > 0, `${res.length} results, first: ${res[0]?.name}`)
  await openBrowse("Garry's Mod", 'Steam Workshop')
  await shot('09-workshop-browse')
  const details = []
  for (const r of res.slice(0, 8)) details.push(await invoke('sources:details', 'steamworkshop', r.id, g.id))
  // The smallest real addon (dupes and saves are handled too, but an addon covers the .gma unpacking).
  const sized = details.filter((d) => d.versions[0]?.sizeBytes).sort((a, b) => a.versions[0].sizeBytes - b.versions[0].sizeBytes)
  const small = sized.find((d) => d.tags?.includes('Addon')) ?? sized[0]
  await invoke('downloads:start', { sourceId: 'steamworkshop', modId: small.id, versionId: 'latest', gameId: g.id, name: small.name })
  let mods = []
  for (let i = 0; i < 240 && !mods.length; i++) {
    await page.waitForTimeout(1000)
    mods = await invoke('mods:list', g.id)
    const d = (await invoke('downloads:list')).find((x) => x.name === small.name)
    if (d?.state === 'failed') throw new Error(d.error)
  }
  check('workshop item downloaded via SteamCMD', mods.length === 1, `${small.name} (${Math.round(small.versions[0].sizeBytes / 1024)} KB)`)
  const files = await invoke('mods:files', g.id, mods[0].id)
  check('GMod addon unpacked into its own folder', files.length > 0 && files.every((f) => f.rel.split('/').length > 1), files.slice(0, 3).map((f) => f.rel).join(', '))
  await invoke('deploy:run', g.id)
  const addons = readdirSync(join(g.dir, 'garrysmod', 'addons'))
  check('deployed into garrysmod/addons/<addon>', addons.length === 1, addons.join(', '))
  await invoke('deploy:purge', g.id)
})

// --- ModDB through the hidden browser -------------------------------------------------------
await safe('moddb', async () => {
  const g = await fake('Half-Life 2', 'hl2.exe')
  const b = await invoke('sources:bindings', 'moddb', g.id)
  check('moddb finds Half-Life 2', b[0]?.value === 'half-life-2', b.slice(0, 3).map((x) => x.value).join(','))
  const res = await invoke('sources:search', 'moddb', 'minerva', g.id)
  check('moddb search', res.length > 0, `${res.length} results: ${res.slice(0, 3).map((r) => r.name).join(' | ')}`)
  const d = await invoke('sources:details', 'moddb', 'minerva', g.id)
  check('moddb files listed', d.versions.length > 0, `${d.versions.length} files`)
  await openBrowse('Half-Life 2', 'ModDB')
  await page.getByPlaceholder(/Search ModDB/).fill('minerva')
  await page.waitForTimeout(9000)
  await shot('10-moddb-browse')
  // A real file, downloaded in the background without any click: the smallest one MINERVA offers.
  const sized = d.versions
    .map((v) => ({ v, mb: Number(/([\d.]+)\s*mb/i.exec(v.description ?? '')?.[1] ?? NaN) * (/kb/i.test(v.description ?? '') ? 0.001 : 1) }))
    .filter((x) => x.mb > 0)
    .sort((a, b) => a.mb - b.mb)
  const pick = sized[0]?.v ?? d.versions[d.versions.length - 1]
  await invoke('downloads:start', { sourceId: 'moddb', modId: 'minerva', versionId: pick.id, gameId: g.id, name: pick.name })
  let item
  let sawPanel = false
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000)
    item = (await invoke('downloads:list')).find((x) => x.gameId === g.id)
    if ((await invoke('sitepanel:state')).open) sawPanel = true
    if (item && ['completed', 'failed', 'cancelled'].includes(item.state)) break
  }
  check('moddb file downloads by itself', item?.state === 'completed' && !sawPanel, `${pick.name} (${sized[0]?.mb ?? '?'} MB): ${item?.state}${item?.error ? ` – ${item.error}` : ''}${sawPanel ? ', panel had to open' : ''}`)
  await shot('10b-moddb-downloaded')
})

// --- BeamNG repository: zip mods kept packed, deployed into the (throwaway) user folder ------------------
await safe('beamng', async () => {
  const userDir = join(base, 'beamng-user')
  const gdir = join(base, 'games', 'BeamNG.drive')
  mkdirSync(join(userDir, 'current'), { recursive: true })
  mkdirSync(gdir, { recursive: true })
  // startup.ini moves the user folder into .smoke, so the real BeamNG mods folder is never touched.
  writeFileSync(join(gdir, 'startup.ini'), `[filesystem]\nUserPath = ${userDir}\n`)
  const g = await fake('BeamNG.drive', 'BeamNG.drive.exe')
  check('test BeamNG deploys into its user folder', g.modding.targetDir === join(userDir, 'current', 'mods'), g.modding.targetDir)
  const b = await invoke('sources:bindings', 'beamng', g.id)
  check('BeamNG repository bound to BeamNG.drive', b[0]?.value === 'beamng', b.map((x) => x.value).join(','))
  const popular = await invoke('sources:search', 'beamng', '', g.id)
  check('BeamNG repository lists mods', popular.length >= 10, `${popular.length} results: ${popular.slice(0, 3).map((r) => r.name).join(' | ')}`)
  const found = await invoke('sources:search', 'beamng', 'hirochi', g.id)
  check('BeamNG repository search', found.length > 0, `${found.length} results: ${found.slice(0, 3).map((r) => r.name).join(' | ')}`)
  let pick
  for (const r of popular.slice(0, 20)) {
    const d = await invoke('sources:details', 'beamng', r.id, g.id).catch(() => undefined)
    const size = d?.versions[0]?.sizeBytes
    if (size && (!pick || size < pick.versions[0].sizeBytes)) pick = d
  }
  check('BeamNG mod details and file', Boolean(pick), pick ? `${pick.name} ${pick.version ?? ''} (${Math.round(pick.versions[0].sizeBytes / 1024 / 1024)} MB)` : '')
  await openBrowse('BeamNG.drive', 'BeamNG Repository')
  await shot('11-beamng-browse')
  await invoke('downloads:start', { sourceId: 'beamng', modId: pick.id, versionId: pick.versions[0].id, gameId: g.id, name: pick.name })
  let mods = []
  for (let i = 0; i < 240 && !mods.length; i++) {
    await page.waitForTimeout(1000)
    mods = await invoke('mods:list', g.id)
    const d = (await invoke('downloads:list')).find((x) => x.gameId === g.id)
    if (d?.state === 'failed') throw new Error(d.error)
  }
  const files = await invoke('mods:files', g.id, mods[0].id)
  check('BeamNG mod downloaded and kept as a zip', files.length === 1 && /\.zip$/i.test(files[0].rel), files.map((f) => f.rel).join(', '))
  await invoke('deploy:run', g.id)
  const deployed = readdirSync(join(userDir, 'current', 'mods'))
  check('zip deployed into BeamNG\'s mods folder', deployed.length === 1 && /\.zip$/i.test(deployed[0]), deployed.join(', '))
  await invoke('deploy:purge', g.id)
})

// --- Accounts: sign-in pages inside the app, keys checked against the site -------------------------
await safe('accounts', async () => {
  await resetUi()
  await page.getByRole('button', { name: /^Accounts/ }).first().click()
  await page.waitForTimeout(1500)
  await shot('13-accounts')
  const list = await invoke('accounts:list')
  check('accounts for Nexus, mod.io, CurseForge and Steam', ['nexus', 'modio', 'curseforge', 'steam'].every((id) => list.some((a) => a.id === id)) && (await page.locator('text=Create free account').count()) >= 3, list.map((a) => `${a.name}: ${a.signedIn ? 'signed in' : 'signed out'}`).join(', '))
  const bad = await invoke('accounts:saveKey', 'nexus', 'not-a-real-key--abc--def').then(() => 'accepted', (e) => e.message)
  check('a wrong API key is refused', /did not accept/i.test(bad), bad.replace(/^.*Error: /, '').slice(0, 80))
  // mod.io's card is the second one.
  await page.getByRole('button', { name: 'Sign in', exact: true }).nth(1).click()
  let st
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500)
    st = await invoke('sitepanel:state')
    if (st.open && /mod\.io\/login/.test(st.url) && !st.loading) break
  }
  check('mod.io login opens inside the app', st.open && /mod\.io\/login/.test(st.url), `title="${st.title}" url=${st.url}`)
  await page.waitForTimeout(2000)
  await panelShot('14-modio-login-page')
  await invoke('sitepanel:cancel')
  await page.waitForTimeout(800)
  check('steam sign-in form shown', (await page.getByPlaceholder('Steam user name').count()) === 1)
})

// --- Key-only sources explain themselves ------------------------------------------------------
await safe('key sources', async () => {
  const games = await invoke('library:list')
  const err = await invoke('sources:search', 'modio', '', games[0].id).then(() => '', (e) => e.message)
  check('mod.io asks for its free API key', /api key/i.test(err), err.replace(/^.*Error: /, '').slice(0, 90))
  await openBrowse(games.find((x) => x.favorite)?.name ?? games[0].name, 'mod.io')
  check('mod.io offers the in-app sign-in', (await page.getByRole('button', { name: 'Sign in to mod.io' }).count()) === 1)
  await shot('15-modio-needs-sign-in')
})

const versions = (await invoke('library:list')).filter((g) => g.version).map((g) => `${g.name}=${g.version}`)
check('game versions read from executables', true, versions.join(', ') || 'none of these games carry a version resource')
await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
await page.getByRole('button', { name: 'Mods', exact: true }).click()
await shot('12-settings-mods')
check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '))
await app.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`)
process.exit(failed.length ? 1 : 0)
