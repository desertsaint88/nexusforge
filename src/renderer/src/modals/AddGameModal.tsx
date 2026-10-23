import { useEffect, useState } from 'react'
import { FileCode, FolderOpen, Gamepad2, Plus } from 'lucide-react'
import { invoke } from '../lib/api'
import { Modal } from '../components/Modal'
import { Button, Field, Input } from '../components/ui'
import { toast, useNav } from '../store/ui'

export function AddGameModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const navigate = useNav((s) => s.navigate)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [args, setArgs] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setName('')
      setPath('')
      setArgs('')
      setCandidates([])
    }
  }, [open])

  const nameFrom = (p: string) => {
    const parts = p.split(/[\\/]/).filter(Boolean)
    const last = parts[parts.length - 1] ?? ''
    return last.toLowerCase().endsWith('.exe') ? (parts[parts.length - 2] ?? last.replace(/\.exe$/i, '')) : last
  }

  const pickExe = async () => {
    const file = await invoke('app:pickFile', { title: 'Choose the game executable', filters: [{ name: 'Programs', extensions: ['exe'] }] })
    if (!file) return
    setPath(file)
    setCandidates([])
    if (!name) setName(nameFrom(file))
  }

  const pickFolder = async () => {
    const dir = await invoke('app:pickFolder', { title: 'Choose the game folder' })
    if (!dir) return
    if (!name) setName(nameFrom(dir))
    const exes = await invoke('library:detectExecutables', dir)
    setCandidates(exes)
    setPath(exes[0] ?? dir)
    if (!exes.length) toast.warning('No executable found', 'Pick the game .exe directly.')
  }

  const submit = async () => {
    setBusy(true)
    try {
      const game = await invoke('library:addManual', { name, path, args })
      toast.success(`Added ${game.name}`)
      onClose()
      navigate({ name: 'game', gameId: game.id })
    } catch (err) {
      toast.error('Could not add game', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<Gamepad2 className="size-5" />}
      title="Add a game"
      subtitle="For games NexusForge didn't find automatically."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={submit} loading={busy} disabled={!path}>
            Add to library
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <button onClick={pickExe} className="glass group flex flex-col items-start gap-2 rounded-2xl p-4 text-left transition-all hover:border-white/15 hover:bg-white/[0.06]">
            <FileCode className="size-5 text-[color-mix(in_oklab,var(--nf-accent)_65%,white)]" />
            <div className="text-[13.5px] font-semibold text-ink-100">Pick the .exe</div>
            <div className="text-[12px] leading-relaxed text-ink-400">Best when you know which file starts the game.</div>
          </button>
          <button onClick={pickFolder} className="glass group flex flex-col items-start gap-2 rounded-2xl p-4 text-left transition-all hover:border-white/15 hover:bg-white/[0.06]">
            <FolderOpen className="size-5 text-[color-mix(in_oklab,var(--nf-accent-2)_70%,white)]" />
            <div className="text-[13.5px] font-semibold text-ink-100">Pick the game folder</div>
            <div className="text-[12px] leading-relaxed text-ink-400">NexusForge finds the most likely executable for you.</div>
          </button>
        </div>

        {path && (
          <>
            <Field label="Executable">
              <Input mono value={path} onChange={(e) => setPath(e.target.value)} />
            </Field>
            {candidates.length > 1 && (
              <div className="-mt-2 flex flex-wrap gap-1.5">
                {candidates.slice(0, 6).map((c) => (
                  <button
                    key={c}
                    onClick={() => setPath(c)}
                    className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors ${c === path ? 'border-white/25 bg-white/10 text-ink-100' : 'border-white/[0.07] text-ink-400 hover:text-ink-200'}`}
                  >
                    {c.split(/[\\/]/).slice(-2).join('\\')}
                  </button>
                ))}
              </div>
            )}
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Game name" />
            </Field>
            <Field label="Launch arguments" hint="Optional, e.g. -windowed -skipintro">
              <Input mono value={args} onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
