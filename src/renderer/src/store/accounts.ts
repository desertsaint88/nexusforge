import { create } from 'zustand'
import type { AccountId, AccountInfo } from '@shared/types'
import { invoke, on } from '../lib/api'
import { toast } from './ui'

interface AccountsState {
  accounts: AccountInfo[]
  load(): Promise<void>
  /** Opens the site's sign-in in the site panel; resolves true once signed in. */
  signIn(id: AccountId, register?: boolean): Promise<boolean>
  signOut(id: AccountId): Promise<void>
}

export const useAccounts = create<AccountsState>((set) => ({
  accounts: [],
  async load() {
    set({ accounts: await invoke('accounts:list') })
  },
  async signIn(id, register) {
    try {
      await invoke('accounts:signIn', id, register)
      set({ accounts: await invoke('accounts:list') })
      return true
    } catch (err) {
      const msg = (err as Error).message
      if (!/cancel|closed/i.test(msg)) toast.error('Sign-in failed', msg)
      return false
    }
  },
  async signOut(id) {
    set({ accounts: await invoke('accounts:signOut', id) })
  }
}))

let subscribed = false
export function subscribeAccounts(): void {
  if (subscribed) return
  subscribed = true
  on('accounts:changed', (accounts) => useAccounts.setState({ accounts }))
}

/** Sources whose downloads need the user's account on that site. */
const ACCOUNT_FOR_SOURCE: Partial<Record<string, AccountId>> = { nexus: 'nexus', modio: 'modio', curseforge: 'curseforge' }

export function accountForSource(sourceId: string): AccountId | undefined {
  return ACCOUNT_FOR_SOURCE[sourceId]
}

interface PromptRequest {
  account: AccountInfo
  reason: string
  resolve(ok: boolean): void
}

interface PromptState {
  request?: PromptRequest
  ask(account: AccountInfo, reason: string): Promise<boolean>
  close(): void
}

export const useAccountPrompt = create<PromptState>((set) => ({
  request: undefined,
  ask(account, reason) {
    return new Promise<boolean>((resolve) => set({ request: { account, reason, resolve } }))
  },
  close() {
    set({ request: undefined })
  }
}))

/**
 * Makes sure the user is signed in to the sites these sources need, asking (and opening the sign-in) when not.
 * Returns false when the user cancelled.
 */
export async function ensureSignedIn(sourceIds: string[], reason: string): Promise<boolean> {
  if (!useAccounts.getState().accounts.length) await useAccounts.getState().load()
  const needed = [...new Set(sourceIds.map(accountForSource).filter(Boolean))] as AccountId[]
  for (const id of needed) {
    const account = useAccounts.getState().accounts.find((a) => a.id === id)
    if (!account || account.signedIn) continue
    if (!(await useAccountPrompt.getState().ask(account, reason))) return false
  }
  return true
}
