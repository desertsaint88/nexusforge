// Cloudflare's bot check on the Nexus login and registration pages inside the real app (built with npm run build).
// Runs the app without an automation driver (see turnstile-app-probe.cjs) in a throwaway profile.
// Usage: node scripts/smoke-cloudflare.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'cloudflare')
rmSync(base, { recursive: true, force: true })
mkdirSync(base, { recursive: true })

let failed = 0
for (const [name, register] of [['login', '0'], ['register', '1']]) {
  const out = join(base, `${name}.txt`)
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require ${join(root, 'scripts', 'turnstile-app-probe.cjs')}`,
    NEXUSFORGE_USER_DATA: join(base, `userdata-${name}`),
    PROBE_OUT: out,
    PROBE_REGISTER: register
  }
  delete env.ELECTRON_RENDERER_URL
  await new Promise((resolve) => {
    const child = spawn(electronPath, [root], { env, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), 100_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const result = existsSync(out) ? readFileSync(out, 'utf8') : 'no result (app did not finish)'
  const ok = result.startsWith('PASSED')
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  Nexus ${name}: Cloudflare check inside the app  (${result})`)
}
process.exit(failed ? 1 : 0)
