// Accounts: signing in to the mod sites from inside NexusForge. The site's own login page opens in the site panel
// (in the same persistent session the download pages use, so a login there also counts for downloads). Once the
// user is signed in, NexusForge reads their personal API key from the site's key page and checks it against the
// site's API, so nobody has to copy keys around. Steam is different: SteamCMD signs in with name + password once.

import { clipboard, session, shell } from 'electron'
import type { AccountId, AccountInfo, SteamLoginRequest, SteamLoginResponse } from '@shared/types'
import { db, getApiKey, getSettings, setSettings } from '../store'
import { emit, toast } from '../events'
import { scoped } from '../logger'
import { HttpError, httpJson } from '../sources/http'
import { NEXUS_PARTITION } from '../sources/nexus'
import { clearSiteSession, siteView } from '../web/browser'
import { addPanelEntry, removePanelEntry, setPanelHint } from '../web/panel'
import { steamLogin, steamLogout } from '../steam/steamcmd'
import { keyProbe, type KeyPageDef, type KeyPageState } from './key-probe'

const log = scoped('accounts')

export interface AccountProfile {
  user?: string
  avatar?: string
  detail?: string
}

interface WebAccount extends KeyPageDef {
  id: Exclude<AccountId, 'steam'>
  name: string
  unlocks: string
  required: boolean
  partition: string
  /** Where sign-in starts; it should lead to the key page afterwards. */
  signInUrl: string
  registerUrl: string
  keyPageUrl: string
  isKeyPage(url: URL): boolean
  /** Pages that belong to the sign-in itself (never navigated away from). */
  isAuthPage(url: URL): boolean
  /** Signed in and somewhere on the site, but not on the key page: go there. */
  isSitePage(url: URL): boolean
  /** Press the create button for the user (once per sign-in) instead of only pointing at it. */
  autoCreate?: boolean
  /**
   * Login cookie of the site: when the session has it, sign-in opens the key page directly instead of the login
   * form (the user is already logged in there and only the key is missing).
   */
  sessionCookie?: string
  validate(key: string): Promise<AccountProfile>
  hints: { signIn: string; register: string; keyPage: string; noKey: string }
}

const WEB_ACCOUNTS: WebAccount[] = [
  {
    id: 'nexus',
    name: 'Nexus Mods',
    unlocks: 'Download buttons inside NexusForge for Nexus Mods files (a free account is enough; Premium skips the extra click).',
    required: false,
    partition: NEXUS_PARTITION,
    signInUrl: `https://users.nexusmods.com/auth/sign_in?redirect_url=${encodeURIComponent('https://www.nexusmods.com/settings/api-keys')}`,
    registerUrl: 'https://users.nexusmods.com/register',
    keyPageUrl: 'https://www.nexusmods.com/settings/api-keys',
    isKeyPage: (u) => /(^|\.)nexusmods\.com$/i.test(u.hostname) && /^\/settings\/api-keys/i.test(u.pathname),
    isAuthPage: (u) => /^users\.nexusmods\.com$/i.test(u.hostname) || /accounts\.google|discord\.com|steamcommunity\.com\/openid|appleid\.apple/i.test(u.href),
    isSitePage: (u) => /^(www\.|next\.)?nexusmods\.com$/i.test(u.hostname),
    keyPattern: '[A-Za-z0-9+/]{16,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}',
    section: 'personal api key',
    sectionHeading: '^personal api key$',
    createButton: '^(request|generate|create)( an?| new)?( personal)?( api)? key$',
    autoCreate: true,
    sessionCookie: 'nexusmods_session',
    loggedOutText: 'please log in again|your session has expired|log in to continue',
    async validate(key) {
      const v = await httpJson<{ name: string; is_premium?: boolean; is_supporter?: boolean; profile_url?: string }>('https://api.nexusmods.com/v1/users/validate.json', {
        headers: { apikey: key }
      })
      return { user: v.name, avatar: v.profile_url, detail: v.is_premium ? 'Premium: downloads start without a click' : v.is_supporter ? 'Supporter (free downloads)' : 'Free account' }
    },
    hints: {
      signIn: 'Log in to Nexus Mods (or create a free account). NexusForge picks up your API key by itself afterwards.',
      register: 'Create your free Nexus Mods account. After confirming your e-mail, log in here; NexusForge does the rest.',
      keyPage: 'Reading your personal API key…',
      noKey: 'Click the highlighted “Request Api Key” under “Personal API Key” (at the bottom); NexusForge reads the key as soon as it appears.'
    }
  },
  {
    id: 'modio',
    name: 'mod.io',
    unlocks: 'Searching and downloading mod.io mods (Ready Or Not, Ground Branch, SnowRunner, …).',
    required: true,
    partition: 'persist:modio',
    // The key page sends visitors to the login; a new e-mail address creates the account there too.
    signInUrl: 'https://mod.io/me/access',
    registerUrl: 'https://mod.io/me/access',
    keyPageUrl: 'https://mod.io/me/access',
    isKeyPage: (u) => /(^|\.)mod\.io$/i.test(u.hostname) && /^\/me\/access/i.test(u.pathname),
    isAuthPage: (u) => /\/(login|register|signin|auth)/i.test(u.pathname) || /accounts\.google|discord\.com|steamcommunity\.com\/openid|appleid\.apple|login\.live\.com/i.test(u.href),
    isSitePage: (u) => /^(www\.)?mod\.io$/i.test(u.hostname),
    keyPattern: '\\b[a-f0-9]{32}\\b',
    section: 'api key',
    createButton: '^(request|generate|create)( an?| new)?( read-only)?( api)? key$',
    loggedOutText: 'log ?in to continue|sign in to continue',
    async validate(key) {
      await httpJson(`https://api.mod.io/v1/games?api_key=${encodeURIComponent(key)}&_limit=1`)
      return { detail: 'API key active' }
    },
    hints: {
      signIn: 'Sign in to mod.io (an e-mail code, Google, Steam or Discord). NexusForge reads your API key afterwards.',
      register: 'Enter your e-mail to create a mod.io account (it sends a code). NexusForge reads your API key afterwards.',
      keyPage: 'Reading your mod.io API key…',
      noKey: 'Under "API key", accept the terms and click the highlighted button to create your key; NexusForge reads it right away.'
    }
  },
  {
    id: 'curseforge',
    name: 'CurseForge',
    unlocks: 'Searching and downloading CurseForge mods (Minecraft, The Sims 4, Stardew Valley, …).',
    required: true,
    partition: 'persist:curseforge-console',
    signInUrl: 'https://console.curseforge.com/#/api-keys',
    registerUrl: 'https://console.curseforge.com/#/signup',
    keyPageUrl: 'https://console.curseforge.com/#/api-keys',
    isKeyPage: (u) => /^console\.curseforge\.com$/i.test(u.hostname) && /api-keys/i.test(u.hash + u.pathname),
    isAuthPage: (u) => /login|signin|sign-in|signup|sign-up|auth|register/i.test(u.hash + u.pathname) || !/curseforge\.com$/i.test(u.hostname),
    isSitePage: (u) => /^console\.curseforge\.com$/i.test(u.hostname),
    keyPattern: '\\$2a\\$10\\$[A-Za-z0-9./]{53}',
    section: 'api key',
    createButton: '^(generate|create|request)( an?| new)?( api)? key$',
    loggedOutText: 'sign in to continue|log ?in to continue',
    async validate(key) {
      await httpJson('https://api.curseforge.com/v1/games?pageSize=1', { headers: { 'x-api-key': key } })
      return { detail: 'API key active' }
    },
    hints: {
      signIn: 'Log in to the CurseForge console with Google (or sign up, it is free). NexusForge reads your API key from the "API keys" page.',
      register: 'Sign up for the free CurseForge console with Google. NexusForge reads your API key from the "API keys" page afterwards.',
      keyPage: 'Reading your CurseForge API key…',
      noKey: 'Open "API keys" (or click the highlighted button); NexusForge reads the key as soon as it is shown.'
    }
  }
]

// ---------------------------------------------------------------------------
// Stored profiles

function profiles(): Partial<Record<AccountId, AccountProfile>> {
  return db().get('accounts') ?? {}
}

function saveProfile(id: AccountId, p: AccountProfile | undefined): void {
  const all = { ...profiles() }
  if (p) all[id] = p
  else delete all[id]
  db().set('accounts', all)
}

const busy = new Set<AccountId>()

function info(def: WebAccount | 'steam'): AccountInfo {
  if (def === 'steam') {
    const user = getSettings().steamAccount
    return {
      id: 'steam',
      name: 'Steam',
      unlocks: 'Steam Workshop downloads for games your account owns (most Workshops refuse anonymous downloads).',
      signedIn: Boolean(user),
      user: user || undefined,
      detail: user ? 'SteamCMD is signed in' : undefined,
      busy: busy.has('steam'),
      web: false,
      required: false
    }
  }
  const key = getApiKey(def.id)
  const p = profiles()[def.id]
  return {
    id: def.id,
    name: def.name,
    unlocks: def.unlocks,
    signedIn: Boolean(key),
    user: key ? p?.user : undefined,
    avatar: key ? p?.avatar : undefined,
    detail: key ? (p?.detail ?? 'API key saved') : undefined,
    busy: busy.has(def.id),
    web: true,
    registerUrl: def.registerUrl,
    required: def.required
  }
}

export function listAccounts(): AccountInfo[] {
  return [...WEB_ACCOUNTS.map((d) => info(d)), info('steam')]
}

function publish(): void {
  emit('accounts:changed', listAccounts())
}

function webDef(id: AccountId): WebAccount {
  const d = WEB_ACCOUNTS.find((x) => x.id === id)
  if (!d) throw new Error(`Unknown account: ${id}`)
  return d
}

/** Saves a key someone pasted (or the sign-in found) after checking it against the site. */
async function acceptKey(def: WebAccount, key: string): Promise<AccountProfile> {
  const profile = await def.validate(key)
  const enabled = getSettings().sources[def.id]?.enabled ?? true
  setSettings({ sources: { [def.id]: { enabled, apiKey: key } } })
  saveProfile(def.id, profile)
  return profile
}

export async function saveAccountKey(id: AccountId, key: string): Promise<AccountInfo> {
  const def = webDef(id)
  const k = key.trim()
  if (!k) throw new Error('Paste the key first.')
  try {
    await acceptKey(def, k)
  } catch (err) {
    throw new Error(err instanceof HttpError && (err.status === 401 || err.status === 403) ? `${def.name} did not accept that key.` : (err as Error).message)
  }
  publish()
  return info(def)
}

// ---------------------------------------------------------------------------
// Web sign-in

/**
 * Watches the clipboard for something that looks like the site's API key (copied from the user's own browser)
 * and hands each new candidate to `onKey`. Only strings matching the key pattern are looked at.
 */
function watchClipboard(def: WebAccount, onKey: (key: string) => Promise<boolean>): () => void {
  // Tests switch it off: a key the user copied would otherwise finish every test sign-in at once.
  if (process.env.NEXUSFORGE_NO_CLIPBOARD === '1') return () => {}
  const pattern = new RegExp(`^\\s*(${def.keyPattern})\\s*$`)
  const seen = new Set<string>()
  let checking = false
  const timer = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      const text = String(await clipboard.readText()).slice(0, 600)
      const key = text.match(pattern)?.[1]
      if (!key || seen.has(key)) return
      seen.add(key)
      await onKey(key)
    } catch {
      // clipboard busy; next tick
    } finally {
      checking = false
    }
  }, 900)
  return () => clearInterval(timer)
}

const browserFlows = new Map<AccountId, { cancel(): void; promise: Promise<AccountInfo> }>()

/**
 * Sign-in through the user's own browser, for when a site's bot check refuses NexusForge's window (or the user is
 * already signed in there): opens the key page externally and finishes as soon as the key is copied.
 */
export function browserKeySignIn(id: AccountId): Promise<AccountInfo> {
  if (id === 'steam') throw new Error('Steam signs in with your user name and password.')
  const running = browserFlows.get(id)
  if (running) return running.promise
  const def = webDef(id)
  let cancel = () => {}
  const promise = new Promise<AccountInfo>((resolve, reject) => {
    const stop = watchClipboard(def, async (key) => {
      try {
        const profile = await acceptKey(def, key)
        finish()
        log.info(`${def.name}: signed in through the browser${profile.user ? ` as ${profile.user}` : ''}`)
        toast('success', `Signed in to ${def.name}`, profile.user ? `as ${profile.user}. ${profile.detail ?? ''}` : profile.detail)
        resolve(info(def))
        return true
      } catch (err) {
        log.warn(`${def.name}: copied key not accepted (${(err as Error).message})`)
        toast('warning', `${def.name} did not accept the copied key`, 'Copy the whole key (the copy button next to it), or create a new one.')
        return false
      }
    })
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('No API key was copied within 10 minutes.'))
    }, 10 * 60_000)
    const finish = () => {
      stop()
      clearTimeout(timeout)
      browserFlows.delete(id)
      busy.delete(id)
      publish()
    }
    cancel = () => {
      finish()
      reject(new Error('Sign-in cancelled'))
    }
  })
  browserFlows.set(id, { cancel: () => cancel(), promise })
  busy.add(id)
  publish()
  void shell.openExternal(def.keyPageUrl)
  return promise
}

export function cancelBrowserKeySignIn(id: AccountId): void {
  browserFlows.get(id)?.cancel()
}

const pending = new Map<AccountId, Promise<AccountInfo>>()

/**
 * Opens the site's sign-in (or registration) page in the site panel and finishes once a working API key has been
 * read from the site. Rejects when the user cancels.
 */
export function signIn(id: AccountId, register = false): Promise<AccountInfo> {
  if (id === 'steam') throw new Error('Steam signs in with your user name and password; use the form under Accounts.')
  const running = pending.get(id)
  if (running) return running
  const def = webDef(id)
  const p = runWebSignIn(def, register).finally(() => {
    pending.delete(id)
    busy.delete(id)
    publish()
  })
  pending.set(id, p)
  return p
}

function runWebSignIn(def: WebAccount, register: boolean): Promise<AccountInfo> {
  return new Promise<AccountInfo>((resolve, reject) => {
    const panelId = `account:${def.id}`
    const view = siteView(def.partition, panelId)
    const wc = view.webContents
    let done = false
    const tried = new Set<string>()
    let keyPageVisits = 0
    let lastSiteRedirect = 0
    let autoCreated = false
    let probing = false
    busy.add(def.id)
    publish()

    // If the user finishes in their own browser instead ("Open in my browser"), the copied key completes this too.
    const stopClipboard = watchClipboard(def, async (key) => {
      if (done) return false
      try {
        const profile = await acceptKey(def, key)
        log.info(`${def.name}: signed in with a copied key${profile.user ? ` as ${profile.user}` : ''}`)
        toast('success', `Signed in to ${def.name}`, profile.user ? `as ${profile.user}. ${profile.detail ?? ''}` : profile.detail)
        finish(undefined, info(def))
        return true
      } catch {
        return false
      }
    })

    const finish = (err?: Error, result?: AccountInfo) => {
      if (done) return
      done = true
      clearInterval(timer)
      stopClipboard()
      removePanelEntry(panelId)
      if (err) reject(err)
      else resolve(result!)
    }

    const probe = async () => {
      if (done || probing || wc.isDestroyed()) return
      probing = true
      try {
        let url: URL
        try {
          url = new URL(wc.getURL())
        } catch {
          return
        }
        if (def.isKeyPage(url)) {
          const click = Boolean(def.autoCreate) && !autoCreated
          const state = (await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: keyProbe(def, def.hints.noKey, click) }]).catch(() => undefined)) as KeyPageState | undefined
          if (!state) return
          if (state.clicked) {
            // Signing in is the user's go-ahead for a key; the page shows it right after (read on the next probe).
            autoCreated = true
            log.info(`${def.name}: requested the personal API key`)
            setPanelHint(panelId, def.hints.keyPage)
            return
          }
          if (state.loggedOut) {
            // The key page doesn't redirect visitors itself; send them to the login once per visit.
            if (keyPageVisits++ < 3) {
              setPanelHint(panelId, register ? def.hints.register : def.hints.signIn)
              void wc.loadURL(def.signInUrl)
            }
            return
          }
          for (const key of state.keys) {
            if (tried.has(key)) continue
            tried.add(key)
            try {
              const profile = await acceptKey(def, key)
              log.info(`${def.name}: signed in with the key from the key page${profile.user ? ` as ${profile.user}` : ''}`)
              toast('success', `Signed in to ${def.name}`, profile.user ? `as ${profile.user}. ${profile.detail ?? ''}` : profile.detail)
              finish(undefined, info(def))
              return
            } catch (err) {
              log.warn(`${def.name}: a key on the page was not accepted (${(err as Error).message})`)
            }
          }
          setPanelHint(panelId, state.canCreate ? def.hints.noKey : state.keys.length ? `${def.name} did not accept the key shown on this page. Create a new one here.` : def.hints.keyPage)
          return
        }
        // Signed in and back on the site (after login, registration or a social login): go to the key page.
        if (!def.isAuthPage(url) && def.isSitePage(url) && Date.now() - lastSiteRedirect > 8000) {
          lastSiteRedirect = Date.now()
          void wc.loadURL(def.keyPageUrl)
        }
      } finally {
        probing = false
      }
    }

    const timer = setInterval(() => void probe(), 1200)
    wc.on('did-finish-load', () => void probe())
    wc.once('destroyed', () => finish(new Error('Sign-in closed')))

    addPanelEntry({
      id: panelId,
      title: register ? `Create a ${def.name} account` : `Sign in to ${def.name}`,
      hint: register ? def.hints.register : def.hints.signIn,
      view,
      show: true,
      onCancel: () => finish(new Error('Sign-in cancelled'))
    })
    void (async () => {
      const loggedIn = !register && def.sessionCookie ? (await session.fromPartition(def.partition).cookies.get({ name: def.sessionCookie }).catch(() => [])).length > 0 : false
      if (!done) void wc.loadURL(register ? def.registerUrl : loggedIn ? def.keyPageUrl : def.signInUrl)
    })()
  })
}

export async function signOut(id: AccountId): Promise<AccountInfo[]> {
  if (id === 'steam') {
    const user = getSettings().steamAccount
    setSettings({ steamAccount: '' })
    if (user) await steamLogout(user).catch(() => {})
  } else {
    const def = webDef(id)
    const enabled = getSettings().sources[def.id]?.enabled ?? true
    setSettings({ sources: { [def.id]: { enabled, apiKey: '' } } })
    saveProfile(def.id, undefined)
    await clearSiteSession(def.partition).catch(() => {})
  }
  log.info(`signed out of ${id}`)
  publish()
  return listAccounts()
}

export async function signInSteam(req: SteamLoginRequest, onStatus: (s: string) => void): Promise<SteamLoginResponse> {
  const user = req.user?.trim()
  if (!user || !req.password) return { ok: false, message: 'Enter your Steam user name and password.' }
  busy.add('steam')
  publish()
  try {
    const res = await steamLogin(user, req.password, req.code?.trim() || undefined, onStatus)
    if (!res.ok) return res
    setSettings({ steamAccount: user })
    log.info('SteamCMD signed in')
    return { ok: true, account: info('steam') }
  } finally {
    busy.delete('steam')
    publish()
  }
}
