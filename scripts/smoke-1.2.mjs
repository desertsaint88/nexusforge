// Live checks for NexusForge 1.2 against this PC's real library (read-only: nothing is installed, deployed or
// signed in; a separate profile in .smoke/v12 is used). Covers artwork, installed-mod detection, mod sorting,
// the Cloudflare check on the in-app Nexus login and the new look.
// Usage: npm run build && node scripts/smoke-1.2.mjs   (screenshots in .smoke/v12/shots)
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'v12')
const shots = join(base, 'shots')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const info = (line) => console.log(`      ${line}`)

const env = { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata') }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 940 }))
const shot = async (name) => {
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
const safe = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    check(name, false, e.message.split('\n')[0])
    await page.screenshot({ path: join(shots, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  }
}
const head = async (url) => {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    return r.ok
  } catch {
    return false
  }
}
const n = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const find = (games, name) => games.find((g) => n(g.name) === n(name) || n(g.name).startsWith(n(name)))

await page.waitForSelector('text=NexusForge')
await invoke('settings:set', { firstRunComplete: true, customFolders: [] })
await invoke('library:scan')
await page.reload()
await page.waitForSelector('text=Library')

// --- Artwork: every game looked up once; the broken ones from 1.1 get pictures that load ------------
await safe('artwork', async () => {
  let games = []
  for (let i = 0; i < 150; i++) {
    games = await invoke('library:list')
    if (games.length && games.every((g) => g.artRev === 2 || g.userEdited?.includes('art'))) break
    await page.waitForTimeout(1000)
  }
  const done = games.filter((g) => g.artRev === 2).length
  check('artwork lookup ran for every game', done === games.length, `${done}/${games.length}`)
  const wanted = ['Evil Egg', 'Hell Let Loose', 'Way of the Hunter 2', 'GROUND BRANCH', 'Call of Duty: Modern Warfare 4', 'Rolla', 'Uplink', 'Sniper Killer']
  for (const name of wanted) {
    const g = find(games, name)
    const first = g?.art.capsule[0] ?? g?.art.header[0]
    const ok = Boolean(first) && (first.startsWith('nexus-media:') || (await head(first)))
    check(`cover loads: ${name}`, ok, g ? `${g.name} -> ${first ?? 'none'}` : 'not in library')
  }
  const ground = find(games, 'GROUND BRANCH')
  check('GROUND BRANCH uses the current (hashed) store art', /\/apps\/16900\/[0-9a-f]{40}\//.test(ground?.art.capsule[0] ?? ''), ground?.art.capsule[0])
  const withArt = games.filter((g) => g.art.capsule.length || g.art.header.length || g.customArt?.capsule)
  check('games with artwork', withArt.length >= games.length - 2, `${withArt.length}/${games.length}; without: ${games.filter((g) => !withArt.includes(g)).map((g) => g.name).join(', ') || 'none'}`)
  const renamed = games.filter((g) => g.storeName).map((g) => g.name)
  info(`titles from the store: ${renamed.join(', ') || 'none'}`)
  await shot('01-library')
})

// --- Installed mods: found in the real game folders ---------------------------------------------------
await safe('detection', async () => {
  const all = await invoke('mods:rescanInstalled')
  const games = await invoke('library:list')
  const byName = (name) => all[find(games, name)?.id ?? '']
  for (const g of games) {
    const d = all[g.id]
    if (!d) continue
    const kinds = {}
    for (const m of d.mods) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
    info(`${g.name.padEnd(34)} ${d.supported ? 'mod support' : 'no support '} ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ') || '-'}  [${d.support.join('; ')}]`)
  }
  const gmod = byName("Garry's Mod")
  check("Garry's Mod addons found", (gmod?.mods.filter((m) => m.kind === 'gmod-addon').length ?? 0) >= 40, `${gmod?.mods.length ?? 0} found, e.g. ${gmod?.mods.slice(0, 3).map((m) => m.name).join(', ')}`)
  const beam = byName('BeamNG.drive')
  const arena = beam?.mods.find((m) => /car jump arena/i.test(m.name))
  check('BeamNG mods read from db.json', Boolean(arena?.source?.modId === '1362'), `${beam?.mods.length ?? 0} found, e.g. ${beam?.mods.slice(0, 4).map((m) => `${m.name}${m.version ? ` ${m.version}` : ''}`).join(', ')}`)
  check('BeamNG junk files ignored', !beam?.mods.some((m) => /\.(exe|msi|jar)$/i.test(m.path)))
  const xp = byName('X-Plane 12')
  check('X-Plane add-on sceneries (not the default ones)', xp?.mods.filter((m) => m.kind === 'scenery').length === 2, xp?.mods.map((m) => m.name).join(', '))
  const ppg = byName('People Playground')
  check('People Playground contraptions', (ppg?.mods.filter((m) => m.kind === 'contraption').length ?? 0) >= 150, `${ppg?.mods.length ?? 0} found`)
  const unity = ['Firewatch', 'Sniper Killer'].map(byName)
  check('Unity games marked as moddable', unity.every((d) => d?.supported), unity.map((d) => d?.support.join('; ')).join(' | '))
  const cod = all[games.find((g) => g.platformId === '1938090')?.id ?? '']
  check('Call of Duty HQ: no mod support claimed', cod ? !cod.supported : true, cod?.support.join('; ') || 'nothing found')
})

// --- Sorting: every order on several sources ----------------------------------------------------------
await safe('sorting', async () => {
  const games = await invoke('library:list')
  const beam = find(games, 'BeamNG.drive')
  const gmod = find(games, "Garry's Mod")
  const sorts = ['endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated']
  const time = (s) => (s ? Date.parse(s) : 0)
  const desc = (list, f) => list.every((x, i) => i === 0 || f(list[i - 1]) >= f(x))
  for (const [source, game] of [['nexus', beam], ['beamng', beam], ['steamworkshop', gmod], ['moddb', beam]]) {
    if (!game) continue
    const line = []
    for (const sort of sorts) {
      const r = await invoke('sources:query', source, '', game.id, { sort }).catch((e) => ({ error: e.message, results: [] }))
      const list = r.results
      let ordered = true
      if (!r.error && list.length > 2) {
        if (sort === 'downloads' && source !== 'steamworkshop' && source !== 'moddb') ordered = desc(list, (x) => x.downloads ?? 0)
        if (sort === 'endorsed' && source === 'nexus') ordered = desc(list, (x) => x.endorsements ?? 0)
        if (sort === 'newest' && source === 'nexus') ordered = desc(list, (x) => time(x.createdAt))
        if (sort === 'updated' && source === 'nexus') ordered = desc(list, (x) => time(x.updatedAt))
      }
      check(`${source}: ${sort}`, !r.error && list.length > 0 && ordered, r.error ? r.error.slice(0, 100) : `${list.length} mods${r.approximate ? ' (sorted by NexusForge)' : ''}, top: ${list.slice(0, 2).map((x) => x.name).join(' | ')}`)
      line.push(sort)
    }
  }
  // Searching keeps working with an order.
  if (beam) {
    const q = await invoke('sources:query', 'nexus', 'car', beam.id, { sort: 'relevance' })
    check('nexus: search by best match', q.results.length > 0, q.results.slice(0, 3).map((x) => x.name).join(' | '))
  }
})

// --- Installed markers in Browse ----------------------------------------------------------------------
await safe('installed markers', async () => {
  const games = await invoke('library:list')
  const beam = find(games, 'BeamNG.drive')
  await invoke('library:update', beam.id, { favorite: true })
  await page.locator('aside button', { hasText: 'BeamNG.drive' }).first().click()
  await page.waitForTimeout(1200)
  await shot('02-game-beamng')
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'BeamNG Repository', exact: true }).click()
  await page.getByPlaceholder(/Search BeamNG Repository/).fill('Car Jump Arena')
  await page.waitForTimeout(5000)
  const marked = await page.locator('text=Installed').count()
  check('installed mod marked in search results', marked >= 2, `${marked} "Installed" labels (incl. the filter button)`)
  await shot('03-browse-installed')
  await page.getByPlaceholder(/Search BeamNG Repository/).fill('')
  await page.waitForTimeout(4000)
  await shot('04-browse-sorted')
})

// --- Cloudflare: the Nexus login inside the app passes the bot check ---------------------------------
await safe('cloudflare', async () => {
  const signIn = invoke('accounts:signIn', 'nexus').catch((e) => e.message)
  let token = ''
  let ua = ''
  let url = ''
  for (let i = 0; i < 40 && !token; i++) {
    await page.waitForTimeout(1000)
    const r = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /nexusmods\.com/.test(w.getURL()) && !w.isDestroyed())
      if (!wc) return undefined
      const token = await wc.executeJavaScript(`(document.querySelector('[name="cf-turnstile-response"]') || {}).value || ''`).catch(() => '')
      return { token, ua: wc.getUserAgent(), url: wc.getURL() }
    })
    if (r) ({ token, ua, url } = r)
  }
  // Playwright's DevTools connection makes Cloudflare ask for a click, so the token itself is checked by
  // scripts/smoke-cloudflare.mjs (the app without a driver); here: the page and widget load in the panel.
  const widget = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /nexusmods\.com/.test(w.getURL()) && !w.isDestroyed())
    return wc ? wc.mainFrame.framesInSubtree.some((f) => /challenges\.cloudflare\.com/.test(f.url)) : false
  })
  check('Nexus login opens in the panel with the Cloudflare widget', /users\.nexusmods\.com\/auth\/sign_in/.test(url) && widget, `${url}${token ? `, token ${token.length} chars` : ''}`)
  check('site pages identify honestly (no fake Chrome)', /Electron\//.test(ua) && !/Chrome\/140/.test(ua), ua)
  await shot('05-nexus-login-panel')
  const b64 = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /nexusmods\.com/.test(w.getURL()) && !w.isDestroyed())
    return wc ? (await wc.capturePage()).toPNG().toString('base64') : ''
  })
  if (b64) writeFileSync(join(shots, '06-nexus-login-page.png'), Buffer.from(b64, 'base64'))
  await invoke('sitepanel:cancel')
  info(`sign-in ended: ${await signIn}`)
})

// --- The look -----------------------------------------------------------------------------------------
await safe('theme', async () => {
  const s = await invoke('settings:get')
  check('dark graphite accent by default', s.accent === 'graphite', s.accent)
  await page.getByRole('button', { name: /^Library/ }).first().click()
  await page.waitForTimeout(1500)
  const play = page.getByRole('button', { name: /^Play$/ }).first()
  const bg = await play.evaluate((el) => getComputedStyle(el).backgroundColor)
  const [r, g, b] = (bg.match(/\d+(\.\d+)?/g) ?? []).map(Number)
  check('Play button is dark', Math.max(r, g, b) < 40, bg)
  await page.getByRole('button', { name: /^Accounts/ }).first().click()
  await page.waitForTimeout(1200)
  check('accounts offer the own-browser sign-in', (await page.locator('text=Use it instead').count()) >= 1)
  await shot('07-accounts')
  await page.getByRole('button', { name: /^Library/ }).first().click()
  await page.getByRole('button', { name: /^Mod support \(\d+\)$/ }).click()
  await page.waitForTimeout(1200)
  await shot('08-library-mod-support-filter')
})

check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '))
await app.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`)
process.exit(failed.length ? 1 : 0)
