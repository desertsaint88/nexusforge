import { spawn } from 'node:child_process'
import { createWriteStream, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extractZip from 'extract-zip'
import { getSettings } from '../store'
import { paths } from '../paths'
import { exists, isDir } from '../util/fs'
import { scoped } from '../logger'

const log = scoped('steamcmd')
const STEAMCMD_ZIP = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'

/** steamcmd.exe from settings, a standard install, or NexusForge's own copy (downloaded on first use). */
export async function steamCmdPath(onStatus?: (s: string) => void): Promise<string> {
  const configured = getSettings().steamcmdPath
  for (const p of [configured, 'C:\\SteamCMD\\steamcmd.exe', join(paths.userData(), 'steamcmd', 'steamcmd.exe')]) {
    if (p && (await exists(p))) return p
  }
  const dir = join(paths.userData(), 'steamcmd')
  await fsp.mkdir(dir, { recursive: true })
  onStatus?.('Installing SteamCMD (one time)…')
  log.info('downloading SteamCMD')
  const zip = join(dir, 'steamcmd.zip')
  const res = await fetch(STEAMCMD_ZIP, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok || !res.body) throw new Error(`Could not download SteamCMD (${res.status})`)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(zip))
  await extractZip(zip, { dir })
  await fsp.rm(zip, { force: true })
  return join(dir, 'steamcmd.exe')
}

function runSteamCmd(exe: string, args: string[], onLine: (l: string) => void, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('SteamCMD timed out'))
    }, timeoutMs)
    const onData = (b: Buffer) => {
      const s = b.toString('utf8')
      out += s
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line.trim())
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

export class WorkshopAccessError extends Error {}

const BASE_ARGS = ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1']

/** The Steam account SteamCMD is signed in with (its login is cached by SteamCMD itself), if any. */
export function steamAccount(): string | undefined {
  return getSettings().steamAccount || undefined
}

export type SteamLoginResult = { ok: true } | { ok: false; needCode?: 'email' | 'app'; message: string }

/**
 * Signs SteamCMD in once with the user's password (and Steam Guard code). SteamCMD keeps a login token, so later
 * downloads only pass the user name; NexusForge never stores the password.
 */
export async function steamLogin(user: string, password: string, code: string | undefined, onStatus: (s: string) => void): Promise<SteamLoginResult> {
  const exe = await steamCmdPath(onStatus)
  onStatus('Signing in to Steam…')
  const out = await runSteamCmd(
    exe,
    [...BASE_ARGS, '+login', user, password, ...(code ? [code] : []), '+quit'],
    (l) => {
      if (/confirm the login|steam mobile app/i.test(l)) onStatus('Confirm the sign-in in the Steam app on your phone…')
    },
    3 * 60_000
  )
  if (/Waiting for user info\.\.\.OK|Logged in OK/i.test(out)) return { ok: true }
  if (/Invalid Password|InvalidPassword/i.test(out)) return { ok: false, message: 'Wrong user name or password.' }
  if (/Rate Limit/i.test(out)) return { ok: false, message: 'Steam blocked sign-ins for a while after too many attempts. Try again later.' }
  if (/Invalid Login Auth Code|Two-factor code mismatch/i.test(out) && code) return { ok: false, needCode: /Two-factor/i.test(out) ? 'app' : 'email', message: 'That code was wrong or has expired. Enter the current one.' }
  if (/Two-factor|mobile authenticator/i.test(out)) return { ok: false, needCode: 'app', message: 'Enter the Steam Guard code from the Steam app on your phone.' }
  if (/Account Logon Denied|Steam Guard|AccountLogonDenied/i.test(out)) return { ok: false, needCode: 'email', message: 'Steam e-mailed you a Steam Guard code. Enter it here.' }
  const last = out.trim().split(/\r?\n/).filter((l) => /fail|error/i.test(l)).pop()
  return { ok: false, message: last ? last.replace(/^.*?(FAILED|ERROR)/i, '$1').slice(0, 160) : 'Steam did not confirm the sign-in.' }
}

/** Drops SteamCMD's cached login for the account. */
export async function steamLogout(user: string): Promise<void> {
  const exe = await steamCmdPath()
  await runSteamCmd(exe, [...BASE_ARGS, '+login', user, '+logout', '+quit'], () => {}, 60_000).catch(() => '')
}

/**
 * Downloads a Workshop item and returns the folder it landed in. Anonymous first: Steam allows that for games
 * whose Workshop is public (Garry's Mod, People Playground, …). If it refuses and a Steam account is signed in,
 * SteamCMD retries with that account (works for games the account owns).
 */
export async function downloadWorkshopItem(appId: string, itemId: string, onStatus: (s: string) => void): Promise<string> {
  const exe = await steamCmdPath(onStatus)
  const account = steamAccount()
  let lastError = ''
  let user = 'anonymous'
  for (let attempt = 1; attempt <= 3; attempt++) {
    onStatus(attempt === 1 ? 'SteamCMD is downloading the item…' : user !== 'anonymous' ? `Trying with your Steam account (${user})…` : `Retrying (attempt ${attempt})…`)
    const out = await runSteamCmd(
      exe,
      [...BASE_ARGS, '+login', user, '+workshop_download_item', appId, itemId, 'validate', '+quit'],
      (l) => {
        if (/update|verif|download/i.test(l)) onStatus(l.slice(0, 120))
      },
      15 * 60_000
    )
    const ok = out.match(new RegExp(`Success\\. Downloaded item ${itemId} to\\s+"([^"]+)"`))
    // Legacy items are a single file and SteamCMD names the file instead of the item folder.
    if (ok) return (await isDir(ok[1])) ? ok[1] : dirname(ok[1])
    if (user !== 'anonymous' && /cached credentials|password|Logon Denied|Two-factor/i.test(out)) {
      throw new WorkshopAccessError(`Your Steam sign-in in NexusForge has expired. Sign in again under Accounts, then retry.`)
    }
    const err = out.match(/ERROR! Download item \d+ failed \(([^)]+)\)/)
    lastError = err?.[1] ?? out.trim().split(/\r?\n/).slice(-2).join(' ')
    log.warn(`workshop ${appId}/${itemId} attempt ${attempt} (${user === 'anonymous' ? 'anonymous' : 'account'}): ${lastError}`)
    const denied = err && /access denied|no subscription|failure/i.test(err[1])
    if (denied && account && user === 'anonymous') user = account
    else if (denied && attempt >= 2) break
  }
  throw new WorkshopAccessError(
    account
      ? `Steam refused the download, also with your account ${account} (${lastError}). Steam only allows Workshop downloads for games the account owns.`
      : `Steam refused the anonymous download (${lastError}). Steam only allows that for some games. If you own this game on Steam, sign in with your Steam account under Accounts and retry.`
  )
}
