import { useEffect, useMemo, useState } from 'react'
import { Bug, ExternalLink, Eye, FolderOpen, GitBranch, LogIn, PenLine, Save, Send } from 'lucide-react'
import type { BugReportInput, BugReportPreview } from '@shared/types'
import { invoke } from '../lib/api'
import { cn } from '../lib/format'
import { useBugReport } from '../store/bugreport'
import { useLibrary } from '../store/library'
import { toast } from '../store/ui'
import { Modal } from './Modal'
import { Badge, Button, Field, Input, Segmented, Spinner, Toggle } from './ui'

const textarea =
  'selectable w-full resize-y rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2.5 text-[13px] leading-relaxed text-ink-100 placeholder:text-ink-500 outline-none transition-colors focus:border-white/20'

const INCLUDE_LABEL: Record<keyof BugReportInput['include'], { label: string; hint: string }> = {
  system: { label: 'System info', hint: 'NexusForge, Windows and Electron versions, memory' },
  errors: { label: 'Recent errors', hint: 'Errors NexusForge recorded in this session' },
  log: { label: 'Log excerpt', hint: 'The end of NexusForge’s log' },
  diagnostics: { label: 'Diagnose results', hint: 'The checks of the game you are on' },
  screenshot: { label: 'Screenshot', hint: 'Saved with the report; you can drag it into the issue' }
}

export function BugReportDialog() {
  const { open, draft, state, close } = useBugReport()
  const games = useLibrary((s) => s.games)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [expected, setExpected] = useState('')
  const [include, setInclude] = useState<BugReportInput['include']>({ system: true, errors: true, log: true, diagnostics: true, screenshot: true })
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [preview, setPreview] = useState<BugReportPreview | null>(null)
  const [busy, setBusy] = useState<'' | 'preview' | 'panel' | 'browser' | 'save'>('')

  useEffect(() => {
    if (!open) return
    setTitle(draft.title ?? '')
    setDescription(draft.description ?? '')
    setSteps('')
    setExpected('')
    setInclude({ system: true, errors: true, log: true, diagnostics: Boolean(draft.gameId), screenshot: true })
    setTab('write')
    setPreview(null)
  }, [open, draft])

  const game = draft.gameId ? games.find((g) => g.id === draft.gameId) : undefined
  const input = useMemo<BugReportInput>(
    () => ({ title: title.trim(), description: description.trim(), steps: steps.trim() || undefined, expected: expected.trim() || undefined, origin: draft.origin, gameId: draft.gameId, page: draft.page, error: draft.error, include: { ...include, diagnostics: include.diagnostics && Boolean(draft.gameId) } }),
    [title, description, steps, expected, include, draft]
  )
  const canSend = title.trim().length > 0 && (description.trim().length > 0 || Boolean(draft.error))

  const showPreview = async () => {
    setTab('preview')
    setBusy('preview')
    try {
      setPreview(await invoke('bugreport:preview', input))
    } catch (err) {
      toast.error('Could not build the report', (err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const submit = async (target: 'panel' | 'browser' | 'save') => {
    setBusy(target)
    try {
      const r = await invoke('bugreport:submit', input, target)
      if (draft.origin === 'crash') void invoke('bugreport:dismissCrash')
      close()
      if (target === 'save') toast.success('Bug report saved', r.dir)
      else if (target === 'browser') toast.info('Bug report opened in your browser', 'Check it and press "Create" on GitHub.')
    } catch (err) {
      toast.error('Could not open the bug report', (err as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && close()}
      icon={<Bug className="size-5" />}
      title="Report a bug"
      subtitle={
        <>
          Goes to NexusForge’s GitHub as an issue. <span className="text-ink-200">Issues there are public</span>: your user folder, user name, e-mail addresses and keys are taken out. Check the preview.
        </>
      }
      width="max-w-2xl"
      bodyClassName="px-6 pb-2"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('bugreport:openFolder')}>
            Saved reports
          </Button>
          <div className="flex-1" />
          <Button size="sm" icon={<Save className="size-3.5" />} disabled={!canSend || Boolean(busy)} onClick={() => void submit('save')}>
            {busy === 'save' ? 'Saving…' : 'Save only'}
          </Button>
          <Button size="sm" icon={<ExternalLink className="size-3.5" />} disabled={!canSend || Boolean(busy)} onClick={() => void submit('browser')} title="Opens GitHub's issue form in your default browser">
            In my browser
          </Button>
          <Button variant="primary" size="sm" icon={busy === 'panel' ? <Spinner className="size-3.5" /> : <Send className="size-3.5" />} disabled={!canSend || Boolean(busy)} onClick={() => void submit('panel')}>
            Send via GitHub
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <Segmented<'write' | 'preview'>
          size="sm"
          value={tab}
          onChange={(v) => (v === 'preview' ? void showPreview() : setTab('write'))}
          options={[
            { value: 'write', label: <span className="flex items-center gap-1.5"><PenLine className="size-3.5" />Write</span> },
            { value: 'preview', label: <span className="flex items-center gap-1.5"><Eye className="size-3.5" />Preview</span> }
          ]}
        />
        <div className="flex-1" />
        <span className="flex items-center gap-1.5 text-[12px] text-ink-400">
          <GitBranch className="size-3.5" />
          {state?.githubSignedIn ? (
            <>Signed in{state.githubUser ? ` as ${state.githubUser}` : ''}</>
          ) : (
            <button className="flex items-center gap-1 text-ink-300 underline-offset-2 hover:text-ink-100 hover:underline" onClick={() => void invoke('bugreport:githubSignIn')}>
              <LogIn className="size-3.5" />
              Sign in to GitHub in NexusForge
            </button>
          )}
        </span>
      </div>

      {tab === 'write' ? (
        <div className="space-y-3.5">
          {(draft.error || game || draft.page) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-400">
              {draft.page && <Badge>{draft.page}</Badge>}
              {game && <Badge tone="info">{game.name}</Badge>}
              {draft.error && (
                <Badge tone="danger" className="max-w-full truncate">
                  {draft.error.message.slice(0, 120)}
                </Badge>
              )}
            </div>
          )}
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary, e.g. “Deploy fails for GTA V after update”" autoFocus maxLength={140} />
          </Field>
          <Field label="What happened?">
            <textarea className={cn(textarea, 'min-h-[96px]')} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you do, and what went wrong?" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Steps to reproduce (optional)">
              <textarea className={cn(textarea, 'min-h-[72px]')} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'1. Open …\n2. Click …'} />
            </Field>
            <Field label="What did you expect? (optional)">
              <textarea className={cn(textarea, 'min-h-[72px]')} value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-300">Include</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {(Object.keys(INCLUDE_LABEL) as Array<keyof BugReportInput['include']>).map((k) => {
                const disabled = k === 'diagnostics' && !draft.gameId
                return (
                  <label key={k} className={cn('flex items-center justify-between gap-3 py-1', disabled && 'opacity-40')} title={INCLUDE_LABEL[k].hint}>
                    <span className="min-w-0">
                      <span className="text-[13px] text-ink-100">{INCLUDE_LABEL[k].label}</span>
                      <span className="block truncate text-[11.5px] text-ink-500">{disabled ? 'Open a game page to include it' : INCLUDE_LABEL[k].hint}</span>
                    </span>
                    <Toggle checked={include[k] && !disabled} disabled={disabled} onChange={(v) => setInclude({ ...include, [k]: v })} />
                  </label>
                )
              })}
            </div>
            {Boolean(state?.recentErrors.length) && include.errors && <div className="mt-1 text-[11.5px] text-ink-500">{state!.recentErrors.length} error(s) recorded in this session.</div>}
          </div>
        </div>
      ) : (
        <div>
          {busy === 'preview' || !preview ? (
            <div className="flex items-center gap-2 py-10 text-[13px] text-ink-400">
              <Spinner className="size-4" /> Collecting…
            </div>
          ) : (
            <>
              <div className="mb-2 text-[13px] font-semibold text-ink-100">{preview.title || <span className="text-ink-500">(no title)</span>}</div>
              <pre className="selectable max-h-[46vh] overflow-auto rounded-xl border border-white/[0.06] bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-200">{preview.body}</pre>
              {preview.shortened.length > 0 && (
                <div className="mt-2 text-[11.5px] text-ink-400">Shortened to fit GitHub’s link: {preview.shortened.join(', ')}. The saved report has everything.</div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
