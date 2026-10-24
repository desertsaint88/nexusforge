import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CircleCheck, KeyRound, LogIn, LogOut, ShieldCheck, UserPlus, UserRound } from 'lucide-react'
import type { AccountInfo } from '@shared/types'
import { invoke, on } from '../lib/api'
import { cn } from '../lib/format'
import { useAccounts } from '../store/accounts'
import { confirm, toast } from '../store/ui'
import { Badge, Button, Card, Input } from '../components/ui'

const LOGO: Record<string, { short: string; color: string }> = {
  nexus: { short: 'N', color: '#d98f40' },
  modio: { short: 'io', color: '#07c1d8' },
  curseforge: { short: 'CF', color: '#f16436' },
  steam: { short: 'S', color: '#66c0f4' }
}

function Avatar({ account }: { account: AccountInfo }) {
  const [failed, setFailed] = useState(false)
  const logo = LOGO[account.id]
  if (account.avatar && !failed) return <img src={account.avatar} alt="" onError={() => setFailed(true)} className="size-11 rounded-xl object-cover" draggable={false} />
  return (
    <div className="flex size-11 items-center justify-center rounded-xl text-[15px] font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${logo.color}, color-mix(in oklab, ${logo.color} 55%, black))` }}>
      {logo.short}
    </div>
  )
}

function KeyFallback({ account }: { account: AccountInfo }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  if (!open)
    return (
      <button className="text-[12px] text-ink-400 hover:text-ink-200 hover:underline" onClick={() => setOpen(true)}>
        I already have an API key
      </button>
    )
  return (
    <div className="mt-3 flex gap-2">
      <div className="relative flex-1">
        <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
        <Input type="password" mono className="pl-9" placeholder={`Paste your ${account.name} API key`} value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
      </div>
      <Button
        loading={saving}
        disabled={!key.trim()}
        onClick={async () => {
          setSaving(true)
          try {
            await invoke('accounts:saveKey', account.id, key)
            toast.success(`Signed in to ${account.name}`)
            setKey('')
            setOpen(false)
          } catch (err) {
            toast.error('Key not accepted', (err as Error).message)
          } finally {
            setSaving(false)
          }
        }}
      >
        Check & save
      </Button>
    </div>
  )
}

function WebAccountCard({ account }: { account: AccountInfo }) {
  const { signIn, signOut } = useAccounts()
  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <Avatar account={account} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-ink-100">{account.name}</h3>
            {account.signedIn ? (
              <Badge tone="success">
                <CircleCheck className="size-3" /> Signed in{account.user ? ` as ${account.user}` : ''}
              </Badge>
            ) : account.required ? (
              <Badge tone="warning">needed to use {account.name}</Badge>
            ) : (
              <Badge>not signed in</Badge>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{account.signedIn && account.detail ? account.detail : account.unlocks}</p>
          {!account.signedIn && <KeyFallback account={account} />}
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2">
          {account.signedIn ? (
            <Button
              variant="ghost"
              icon={<LogOut className="size-4" />}
              onClick={async () => {
                if (await confirm({ title: `Sign out of ${account.name}?`, message: `NexusForge forgets your ${account.name} API key and login. Installed mods stay.`, confirmLabel: 'Sign out', danger: true }))
                  await signOut(account.id)
              }}
            >
              Sign out
            </Button>
          ) : (
            <>
              <Button variant="primary" loading={account.busy} icon={<LogIn className="size-4" />} onClick={() => void signIn(account.id)}>
                Sign in
              </Button>
              <Button variant="ghost" size="sm" disabled={account.busy} icon={<UserPlus className="size-3.5" />} onClick={() => void signIn(account.id, true)}>
                Create free account
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

function SteamCard({ account }: { account: AccountInfo }) {
  const signOut = useAccounts((s) => s.signOut)
  const [user, setUser] = useState(account.user ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState<'email' | 'app' | undefined>()
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => on('accounts:steamStatus', setStatus), [])

  const submit = async () => {
    setBusy(true)
    setError('')
    setStatus('Signing in to Steam…')
    try {
      const res = await invoke('accounts:steamLogin', { user, password, code: needCode ? code : undefined })
      if (res.ok) {
        toast.success('Signed in to Steam', `SteamCMD now downloads Workshop items as ${user}.`)
        setPassword('')
        setCode('')
        setNeedCode(undefined)
      } else {
        setError(res.message)
        if (res.needCode) setNeedCode(res.needCode)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <Avatar account={account} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-ink-100">Steam</h3>
            {account.signedIn ? (
              <Badge tone="success">
                <CircleCheck className="size-3" /> Signed in as {account.user}
              </Badge>
            ) : (
              <Badge>optional</Badge>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{account.unlocks} Without it, NexusForge downloads anonymously, which works for Garry's Mod, People Playground and some others.</p>
        </div>
        {account.signedIn && (
          <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={() => void signOut('steam')}>
            Sign out
          </Button>
        )}
      </div>
      {!account.signedIn && (
        <form
          className="mt-4 grid grid-cols-[1fr_1fr_auto] items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input placeholder="Steam user name" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
          <Input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" loading={busy} disabled={!user.trim() || !password || (needCode && !code.trim())} icon={<LogIn className="size-4" />}>
            Sign in
          </Button>
          {needCode && (
            <div className="col-span-3 flex items-center gap-2">
              <ShieldCheck className="size-4 shrink-0 text-amber-300" />
              <Input
                className="max-w-56 font-mono tracking-[0.3em] uppercase"
                placeholder={needCode === 'app' ? 'Code from the Steam app' : 'Code from the e-mail'}
                value={code}
                maxLength={8}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
              <span className="text-[12px] text-ink-400">{needCode === 'app' ? 'Steam app → Steam Guard' : 'Steam sent it to your e-mail address'}</span>
            </div>
          )}
          {(status || error) && <p className={cn('col-span-3 text-[12.5px]', error ? 'text-rose-300' : 'text-amber-200/90')}>{error || status}</p>}
          <p className="col-span-3 text-[11.5px] text-ink-500">Your password goes straight to SteamCMD once and is never saved; SteamCMD keeps its own login token.</p>
        </form>
      )}
    </Card>
  )
}

export function AccountsPage() {
  const { accounts, load } = useAccounts()
  useEffect(() => {
    void load()
  }, [load])
  const web = accounts.filter((a) => a.web)
  const steam = accounts.find((a) => a.id === 'steam')
  return (
    <div className="h-full overflow-y-auto px-8 pt-6 pb-10">
      <div className="max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="accent-gradient flex size-10 items-center justify-center rounded-xl text-white shadow-lg">
            <UserRound className="size-5" />
          </div>
          <div>
            <h1 className="text-[28px] leading-tight font-bold tracking-tight text-ink-100">Accounts</h1>
            <p className="text-[13px] text-ink-400">Sign in once inside NexusForge; downloads from these sites then work right here, no browser needed.</p>
          </div>
        </div>
        <motion.div className="space-y-3" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {web.map((a) => (
            <WebAccountCard key={a.id} account={a} />
          ))}
          {steam && <SteamCard account={steam} />}
        </motion.div>
        <p className="mt-5 text-[12px] leading-relaxed text-ink-500">
          ModDB, Thunderstore, Modrinth, the BeamNG repository and the mod loaders (BepInEx, MelonLoader) need no account. API keys are stored encrypted with Windows (DPAPI) and only sent to the site they belong to.
        </p>
      </div>
    </div>
  )
}
