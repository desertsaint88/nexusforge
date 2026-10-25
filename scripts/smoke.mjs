// End-to-end smoke test: launches the built app with a throwaway data folder, walks every screen,
// installs + deploys + purges mods into a fake game, and saves screenshots to .smoke/shots.
// Usage: npm run build && npm run smoke  (extra custom game folders: NEXUSFORGE_SMOKE_FOLDERS="C:\Games;E:\Games")
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const smoke = join(root, '.smoke')
const shots = join(smoke, 'shots')
const userData = join(smoke, 'userdata')
const gamesRoot = join(smoke, 'games')
const game = join(gamesRoot, 'Test Game')
const fixtures = join(smoke, 'fixtures')

rmSync(smoke, { recursive: true, force: true })
for (const d of [shots, userData, game, fixtures]) mkdirSync(d, { recursive: true })

// --- fixtures -------------------------------------------------------------
writeFileSync(join(game, 'TestGame.exe'), Buffer.alloc(400 * 1024))
mkdirSync(join(game, 'Data'), { recursive: true })
writeFileSync(join(game, 'Data', 'original.txt'), 'ORIGINAL GAME FILE')

function makeZip(name, files) {
  const dir = join(fixtures, `src-${name}`)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const zip = join(fixtures, `${name}.zip`)
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dir, '.'])
  return zip
}

const zipA = makeZip('Better Textures v1.2', {
  'Better Textures v1.2/readme.txt': 'docs',
  'Better Textures v1.2/Data/textures/rock.dds': 'A ROCK',
  'Better Textures v1.2/Data/original.txt': 'MODDED BY A'
})
const zipB = makeZip('Sharp Rocks', { 'Data/textures/rock.dds': 'B ROCK', 'Data/textures/tree.dds': 'B TREE' })
makeZip('Night Sky', { 'Data/sky/stars.dds': 'STARS' })
writeFileSync(
  join(fixtures, 'feed.json'),
  JSON.stringify({
    name: 'Smoke feed',
    mods: [
      {
        id: 'night-sky',
        name: 'Night Sky Overhaul',
        summary: 'Replaces the sky box with a hand-painted night sky.',
        description: 'A test mod served from a local JSON feed.',
        author: 'NexusForge',
        games: ['Test Game'],
        versions: [{ id: '2.0', name: 'Main file', version: '2.0', url: 'Night Sky.zip', size: 120, date: '2026-10-01' }]
      }
    ]
  })
)

const extraFolders = (process.env.NEXUSFORGE_SMOKE_FOLDERS ?? '').split(';').filter((f) => f && existsSync(f))

// --- run --------------------------------------------------------------------
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const env = { ...process.env, NEXUSFORGE_USER_DATA: userData, NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL // always test the production bundle
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const errors = []
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ width: 1440, height: 900 })
  w.center()
})
const shot = async (name) => {
  await page.waitForTimeout(650)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [channel, args])

await page.waitForSelector('text=NexusForge')
check('sandboxed renderer has no Node access', await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'))
check('preload bridge blocks unknown channels', await page.evaluate(() => window.nexus.invoke('evil:channel').then(() => false, () => true)))
await shot('01-welcome')

await page.getByRole('button', { name: 'Get started' }).click()
await invoke('settings:set', { customFolders: [gamesRoot, ...extraFolders] })
await page.waitForTimeout(300)
await shot('02-folders')

await page.getByRole('button', { name: 'Scan my PC' }).click()
await page.locator('button:has-text("Open my library"):not([disabled])').waitFor({ timeout: 180_000 })
await shot('03-scan-done')
await page.getByRole('button', { name: 'Open my library' }).click()
await page.waitForTimeout(2500) // let artwork load
await shot('04-library')
await page.getByRole('button', { name: 'Local', exact: true }).click()
await page.waitForTimeout(6000) // store artwork lookups for local games run in the background
await shot('04b-library-local')
await page.getByRole('button', { name: 'All games', exact: true }).click()

const games = await invoke('library:list')
const test = games.find((g) => g.name === 'Test Game')
check('custom folder game detected', Boolean(test), test?.exePath)
// Favorites are pinned to the top of the sidebar, so the test game is always one click away.
await invoke('library:update', test.id, { favorite: true })
check('scanner found games', games.length > 0, `${games.length} games: ${[...new Set(games.map((g) => g.platform))].join(', ')}`)

// --- mods --------------------------------------------------------------------
await page.locator('button:has-text("Test Game")').first().click()
await page.waitForTimeout(800)
await shot('05-game-empty')
await invoke('mods:installFiles', test.id, [zipA, zipB])
await page.waitForTimeout(1200)
const mods = await invoke('mods:list', test.id)
check('two archives installed', mods.length === 2, mods.map((m) => `${m.name}@${m.rootPath || '/'}`).join(', '))
check('wrapper folder detected', mods.some((m) => m.rootPath === 'Better Textures v1.2'))
await shot('06-mods')

const conflicts = await invoke('conflicts:get', test.id)
check('conflict detected', conflicts.totalFiles === 1, `${conflicts.totalFiles} file(s)`)

await page.getByRole('button', { name: /^Deploy/ }).click()
await page.waitForTimeout(2500)
await shot('07-deployed')
const read = (p) => readFileSync(join(game, ...p.split('/')), 'utf8')
check('later mod wins conflict', read('Data/textures/rock.dds') === 'B ROCK')
check('mod replaced original file', read('Data/original.txt') === 'MODDED BY A')
const status = await invoke('deploy:status', test.id)
check('deploy status in sync', status.deployed && status.inSync, JSON.stringify(status.methods))

await page.getByRole('button', { name: /^Conflicts/ }).click()
await page.waitForTimeout(500)
await shot('08-conflicts')
// Pin the losing mod's rock.dds via the resolver UI.
await page.locator('button[title^="Use Better Textures"]').first().click()
await page.waitForTimeout(800)
const statusAfterPin = await invoke('deploy:status', test.id)
check('pinning a file marks deployment out of date', !statusAfterPin.inSync)
await invoke('deploy:run', test.id)
check('pinned file deployed', read('Data/textures/rock.dds') === 'A ROCK')
await shot('09-conflicts-pinned')

await page.getByRole('button', { name: /^Profiles/ }).click()
await shot('10-profiles')
await page.getByRole('button', { name: 'Settings', exact: true }).nth(1).click()
await page.waitForTimeout(1500)
await shot('11-game-settings')

// --- browse: local feed -> download -> install --------------------------------
await invoke('sources:setFeeds', [{ id: '', name: 'Smoke feed', url: join(fixtures, 'feed.json'), enabled: true }])
await page.getByRole('button', { name: 'Browse mods' }).first().click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Modrinth', exact: true }).click()
await page.waitForTimeout(2500)
await shot('12-browse-modrinth')
// Open Browse from the game's own mod list so the game is preselected.
await page.locator('button:has-text("Test Game")').first().click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Browse', exact: true }).click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Smoke feed' }).click()
await page.waitForTimeout(800)
await page.locator('text=Night Sky Overhaul').first().click()
await page.waitForTimeout(1200)
await shot('13-mod-details')
await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).first().click()
await page.waitForTimeout(2500)
await page.keyboard.press('Escape')
await page.getByRole('button', { name: 'Downloads' }).first().click()
await page.waitForTimeout(800)
await shot('14-downloads')
const after = await invoke('mods:list', test.id)
check('feed download installed into game', after.some((m) => m.name === 'Night Sky Overhaul'))

// --- online sources (best effort) -------------------------------------------
try {
  const ms = await invoke('sources:search', 'modrinth', 'sodium')
  check('modrinth search', ms.length > 0, `${ms.length} results`)
} catch (e) {
  check('modrinth search', false, e.message)
}
try {
  const ts = await invoke('sources:search', 'thunderstore', '', undefined).catch((e) => e.message)
  check('thunderstore asks for a game when none given', typeof ts === 'string' && /pick a game/i.test(ts))
} catch (e) {
  check('thunderstore check', false, e.message)
}

// --- live sources against fake installs ---------------------------------------
const fakeInstall = async (name, exe) => {
  const dir = join(smoke, 'other', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, exe), Buffer.alloc(400 * 1024))
  return invoke('library:addManual', { name, path: join(dir, exe) })
}
try {
  const valheim = await fakeInstall('Valheim', 'valheim.exe')
  check('preset applied to Valheim', valheim.modding.sources.thunderstore === 'valheim')
  const ts = await invoke('sources:search', 'thunderstore', 'ValheimPlus', valheim.id)
  check('thunderstore search', ts.length > 0, `${ts.length} results, first: ${ts[0]?.id}`)
  const small = ts.find((r) => !/bepinexpack/i.test(r.id)) ?? ts[0]
  const details = await invoke('sources:details', 'thunderstore', small.id, valheim.id)
  await invoke('downloads:start', { sourceId: 'thunderstore', modId: small.id, versionId: details.versions[0].id, gameId: valheim.id, name: details.name })
  let installed
  for (let i = 0; i < 90 && !installed; i++) {
    await page.waitForTimeout(1000)
    installed = (await invoke('mods:list', valheim.id))[0]
  }
  check('thunderstore package downloaded + installed', Boolean(installed), installed ? `${installed.name} v${installed.version}, root ${installed.rootPath}` : 'timed out')
  if (installed) {
    const files = await invoke('mods:files', valheim.id, installed.id)
    check('thunderstore package mapped into BepInEx', files.every((f) => /^BepInEx\//i.test(f.rel)), files.slice(0, 3).map((f) => f.rel).join(', '))
  }
} catch (e) {
  check('thunderstore flow', false, e.message)
}
try {
  const skyrim = await fakeInstall('Skyrim Special Edition', 'SkyrimSE.exe')
  const nx = await invoke('sources:search', 'nexus', 'SkyUI', skyrim.id)
  check('nexus search', nx.length > 0, `${nx.length} results, first: ${nx[0]?.name}`)
  const d = await invoke('sources:details', 'nexus', nx[0].id, skyrim.id)
  check('nexus files listed (browser download without key)', d.versions.length > 0 && d.versions.every((v) => v.manualOnly), `${d.versions.length} files`)
} catch (e) {
  check('nexus flow', false, e.message)
}

// --- purge restores everything ------------------------------------------------
await invoke('profiles:list', test.id)
await invoke('deploy:purge', test.id)
check('purge restored original', read('Data/original.txt') === 'ORIGINAL GAME FILE')
check('purge removed mod files', !existsSync(join(game, 'Data', 'textures')) && !existsSync(join(game, 'Data', 'sky')))

await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
await page.waitForTimeout(600)
await shot('15-settings')
await page.getByRole('button', { name: 'Sources & plugins' }).click()
await page.waitForTimeout(800)
await shot('16-settings-sources')

// A real game page with artwork, if the scan found one.
const showcase = games.find((g) => g.platform === 'steam') ?? games.find((g) => g.art.capsule.length)
if (showcase) {
  await page.getByRole('button', { name: /^Library/ }).first().click()
  await page.waitForTimeout(500)
  await page.locator(`button:has-text(${JSON.stringify(showcase.name)})`).first().click().catch(() => {})
  await page.waitForTimeout(2000)
  await shot('17-real-game')
}

// Artwork falls back through several CDN URLs, so some image 404s are expected and harmless.
const missingArt = errors.filter((e) => /Failed to load resource.*404/.test(e)).length
const realErrors = errors.filter((e) => !/Failed to load resource.*404/.test(e))
check('no renderer errors', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(' | ') : `${missingArt} artwork fallbacks`)
await app.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`)
process.exit(failed.length ? 1 : 0)
