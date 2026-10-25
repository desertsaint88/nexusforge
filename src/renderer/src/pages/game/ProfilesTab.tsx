import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, Pencil, Plus, Star, Trash } from 'lucide-react'
import type { Game, Profile } from '@shared/types'
import { useMods } from '../../store/mods'
import { confirm } from '../../store/ui'
import { cn, relativeTime } from '../../lib/format'
import { Badge, Button, Card, IconButton, Input } from '../../components/ui'
import { Modal } from '../../components/Modal'

export function ProfilesTab({ game }: { game: Game }) {
  const state = useMods((s) => s.byGame[game.id])
  const { switchProfile, createProfile, renameProfile, deleteProfile } = useMods()
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename' | 'clone'; profile?: Profile } | undefined>()
  const [name, setName] = useState('')

  if (!state) return null
  const open = (mode: 'create' | 'rename' | 'clone', profile?: Profile) => {
    setName(mode === 'rename' ? (profile?.name ?? '') : mode === 'clone' ? `${profile?.name} copy` : '')
    setDialog({ mode, profile })
  }
  const submit = async () => {
    if (!dialog) return
    if (dialog.mode === 'rename' && dialog.profile) await renameProfile(game.id, dialog.profile.id, name)
    else await createProfile(game.id, name, dialog.mode === 'clone' ? dialog.profile?.id : undefined)
    setDialog(undefined)
  }

  return (
    <div>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-[15px] font-semibold text-ink-100">Profiles</div>
          <p className="mt-0.5 text-[13px] text-ink-300">
            Each profile keeps its own enabled mods, load order and conflict choices, saved to its own file. Switch profiles and deploy to change setups.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('create')}>
          New profile
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {state.profiles.map((p, i) => {
          const active = p.id === state.activeId
          const deployedHere = state.status?.deployed && state.status.profileId === p.id
          return (
            <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <Card className={cn('p-5 transition-all', active && 'border-[color-mix(in_oklab,var(--nf-accent)_45%,transparent)] shadow-[0_0_50px_-20px_var(--nf-accent)]')}>
                <div className="flex items-start gap-3">
                  <div className={cn('flex size-10 items-center justify-center rounded-xl', active ? 'accent-gradient text-white' : 'bg-white/[0.06] text-ink-300')}>
                    <Star className={cn('size-4.5', active && 'fill-current')} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-ink-100">{p.name}</div>
                    <div className="mt-0.5 text-[12px] text-ink-400">
                      {p.enabled.length} of {p.order.length} mods enabled · edited {relativeTime(p.updatedAt)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {active && <Badge tone="accent">Active</Badge>}
                  {deployedHere && <Badge tone="success">Deployed</Badge>}
                  {Object.keys(p.fileOverrides).length > 0 && <Badge>{Object.keys(p.fileOverrides).length} pinned files</Badge>}
                </div>
                {/* One main action plus compact icon actions, so the row fits the narrowest card. */}
                <div className="mt-4 flex items-center gap-1">
                  <Button size="sm" variant={active ? 'secondary' : 'primary'} disabled={active} icon={<Check className="size-3.5" />} onClick={() => void switchProfile(game.id, p.id)}>
                    {active ? 'Active' : 'Activate'}
                  </Button>
                  <div className="flex-1" />
                  <IconButton label="Rename" onClick={() => open('rename', p)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Duplicate" onClick={() => open('clone', p)}>
                    <Copy className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={state.profiles.length <= 1 ? 'The last profile cannot be deleted' : 'Delete profile'}
                    className="text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
                    disabled={state.profiles.length <= 1}
                    onClick={async () => {
                      if (await confirm({ title: `Delete "${p.name}"?`, message: 'The profile file is deleted. Installed mods are not affected.', confirmLabel: 'Delete', danger: true }))
                        void deleteProfile(game.id, p.id)
                    }}
                  >
                    <Trash className="size-3.5" />
                  </IconButton>
                </div>
              </Card>
            </motion.div>
          )
        })}
      </div>

      <Modal
        open={Boolean(dialog)}
        onClose={() => setDialog(undefined)}
        title={dialog?.mode === 'rename' ? 'Rename profile' : dialog?.mode === 'clone' ? 'Duplicate profile' : 'New profile'}
        subtitle={dialog?.mode === 'create' ? 'Starts with every mod disabled.' : dialog?.mode === 'clone' ? 'Copies enabled mods, order and pinned files.' : undefined}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={!name.trim()}>
              {dialog?.mode === 'rename' ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void submit()} placeholder="Profile name" />
      </Modal>
    </div>
  )
}
