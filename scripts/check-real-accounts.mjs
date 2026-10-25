// Opens the packaged app on the user's real profile, reads the Accounts list (names and status only, no keys)
// and screenshots the Accounts page, then closes it. Read-only.  Usage: node scripts/check-real-accounts.mjs <out.png>
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = process.argv[2] ?? join(root, '.smoke', 'real-accounts.png')
const app = await electron.launch({ executablePath: join(root, 'release', 'win-unpacked', 'NexusForge.exe'), env: { ...process.env, NEXUSFORGE_NO_CLIPBOARD: '1' } })
try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=NexusForge')
  const list = await page.evaluate(() => window.nexus.invoke('accounts:list'))
  console.log(JSON.stringify({ version: await app.evaluate(({ app }) => app.getVersion()), accounts: list.map(({ id, signedIn, user, detail }) => ({ id, signedIn, user, detail })) }))
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: out })
} finally {
  await app.close()
}
