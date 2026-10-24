import { LogIn, UserPlus, UserRound } from 'lucide-react'
import { useAccountPrompt, useAccounts } from '../store/accounts'
import { Modal } from './Modal'
import { Button } from './ui'

/** "Sign in to Nexus Mods to download this" — opens the site's sign-in in the panel and continues when done. */
export function AccountPromptHost() {
  const { request, close } = useAccountPrompt()
  const signIn = useAccounts((s) => s.signIn)
  const account = request?.account

  const cancel = () => {
    request?.resolve(false)
    close()
  }
  // The sign-in page opens in the site panel, which this dialog would cover; it closes first.
  const start = async (register: boolean) => {
    if (!request || !account) return
    close()
    request.resolve(await signIn(account.id, register))
  }

  return (
    <Modal
      open={Boolean(request)}
      onClose={cancel}
      icon={<UserRound className="size-5" />}
      title={account ? `Sign in to ${account.name}` : ''}
      subtitle={request?.reason}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button icon={<UserPlus className="size-4" />} onClick={() => void start(true)}>
            Create free account
          </Button>
          <Button variant="primary" icon={<LogIn className="size-4" />} onClick={() => void start(false)} autoFocus>
            Sign in
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-200">{account?.unlocks}</p>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-400">
        The {account?.name} login page opens right here in NexusForge. You only do this once: NexusForge remembers the login and picks up your API key by itself.
      </p>
    </Modal>
  )
}
