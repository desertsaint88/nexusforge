import { useEffect, useState } from 'react'
import { CircleCheck, ExternalLink, Link2, PackagePlus, Power, TriangleAlert } from 'lucide-react'
import type { ResolvedDependency } from '@shared/types'
import { invoke } from '../lib/api'
import { installableMissing } from '../lib/install'
import { cn } from '../lib/format'
import { useDependencyDialog } from '../store/ui'
import { Modal } from './Modal'
import { Badge, Button, Toggle } from './ui'

const SOURCE: Record<string, string> = { nexus: 'Nexus', thunderstore: 'Thunderstore', modrinth: 'Modrinth', steamworkshop: 'Workshop', modio: 'mod.io', curseforge: 'CurseForge', moddb: 'ModDB', beamng: 'BeamNG', frameworks: 'Mod loader' }

export function DependencyRow({ dep, checked, onCheck }: { dep: ResolvedDependency; checked?: boolean; onCheck?(v: boolean): void }) {
  const status = dep.installed ? (dep.disabled ? 'disabled' : 'installed') : dep.installable ? 'missing' : 'external'
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-2.5', status === 'external' ? 'border-amber-400/15 bg-amber-500/[0.05]' : 'border-white/[0.06] bg-white/[0.025]')}>
      {onCheck && status === 'missing' ? <Toggle checked={Boolean(checked)} onChange={onCheck} label={`Install ${dep.name}`} /> : <span className="w-9.5" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink-100">{dep.name}</span>
          {dep.sourceId && <Badge className="h-4.5 text-[10px]">{SOURCE[dep.sourceId] ?? dep.sourceId}</Badge>}
          {!dep.required && <Badge className="h-4.5 text-[10px]">optional</Badge>}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-ink-400">
          {dep.requiredBy ? `needed by ${dep.requiredBy}` : 'needed by this mod'}
          {dep.note ? ` · ${dep.note}` : ''}
        </div>
      </div>
      {status === 'installed' && (
        <span className="flex items-center gap-1 text-[12px] text-emerald-300">
          <CircleCheck className="size-3.5" /> installed
        </span>
      )}
      {status === 'disabled' && (
        <span className="flex items-center gap-1 text-[12px] text-amber-300">
          <Power className="size-3.5" /> installed, disabled
        </span>
      )}
      {status === 'external' && dep.url && (
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('app:openExternal', dep.url!)}>
          Get it
        </Button>
      )}
      {status === 'missing' && !onCheck && <Badge tone="warning">missing</Badge>}
    </div>
  )
}

export function DependencyDialogHost() {
  const { request, close } = useDependencyDialog()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const key = (d: ResolvedDependency) => `${d.sourceId}:${d.modId}`

  useEffect(() => {
    if (request) setPicked(new Set(request.deps.filter((d) => installableMissing(d) && d.required).map(key)))
  }, [request])

  const deps = request?.deps ?? []
  const missing = deps.filter(installableMissing)
  const disabled = deps.filter((d) => d.installed && d.disabled && d.required)
  const external = deps.filter((d) => d.required && !d.installable && !d.installed && d.sourceId === '')
  const selected = missing.filter((d) => picked.has(key(d)))

  return (
    <Modal
      open={Boolean(request)}
      onClose={() => close(null)}
      icon={<Link2 className="size-5" />}
      title={`${request?.modName ?? 'This mod'} needs other mods`}
      subtitle={`For ${request?.gameName}. Required ones are selected; they load before the mod.`}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button onClick={() => close({ install: [], enableDisabled: false })}>Only this mod</Button>
          <Button variant="primary" icon={<PackagePlus className="size-4" />} onClick={() => close({ install: selected, enableDisabled: true })}>
            {selected.length ? `Install ${selected.length + 1} mods` : disabled.length ? 'Enable and install' : 'Install'}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {missing.map((d) => (
          <DependencyRow
            key={key(d)}
            dep={d}
            checked={picked.has(key(d))}
            onCheck={(v) => {
              const next = new Set(picked)
              if (v) next.add(key(d))
              else next.delete(key(d))
              setPicked(next)
            }}
          />
        ))}
        {disabled.map((d) => (
          <DependencyRow key={key(d)} dep={d} />
        ))}
        {deps.filter((d) => d.installed && !d.disabled).map((d) => (
          <DependencyRow key={key(d)} dep={d} />
        ))}
        {external.length > 0 && (
          <div className="pt-2">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-amber-200">
              <TriangleAlert className="size-4" /> Install these yourself (outside NexusForge)
            </div>
            <div className="space-y-2">
              {external.map((d) => (
                <DependencyRow key={`${d.name}`} dep={d} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
