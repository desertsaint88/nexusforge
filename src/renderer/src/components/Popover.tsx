import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/format'

/** Floating panel anchored to a trigger; closes on outside click / Escape. */
export function Popover({
  trigger,
  children,
  align = 'start',
  width = 240,
  open: controlled,
  onOpenChange
}: {
  trigger: (props: { open: boolean; toggle(): void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  width?: number
  open?: boolean
  onOpenChange?(open: boolean): void
}) {
  const [inner, setInner] = useState(false)
  const open = controlled ?? inner
  const setOpen = (v: boolean) => {
    setInner(v)
    onOpenChange?.(v)
  }
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; up: boolean }>({ top: 0, left: 0, up: false })

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const r = anchor.current.getBoundingClientRect()
    const up = r.bottom + 320 > window.innerHeight && r.top > 340
    const left = Math.max(8, Math.min(align === 'end' ? r.right - width : r.left, window.innerWidth - width - 8))
    setPos(up ? { bottom: window.innerHeight - r.top + 6, left, up } : { top: r.bottom + 6, left, up })
  }, [open, align, width])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  })

  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({ open, toggle: () => setOpen(!open) })}
      </span>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panel}
              className="glass-strong fixed z-[60] overflow-hidden rounded-xl p-1"
              style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width, transformOrigin: pos.up ? 'bottom' : 'top' }}
              initial={{ opacity: 0, scale: 0.96, y: pos.up ? 6 : -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            >
              {children(() => setOpen(false))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

export function MenuItem({ icon, children, onClick, danger, active, hint }: { icon?: ReactNode; children: ReactNode; onClick(): void; danger?: boolean; active?: boolean; hint?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
        danger ? 'text-rose-300 hover:bg-rose-500/12' : 'text-ink-200 hover:bg-white/[0.07] hover:text-ink-100',
        active && 'bg-white/[0.06] text-ink-100'
      )}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center opacity-80 [&>svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
      {active && <Check className="size-3.5 text-[color-mix(in_oklab,var(--nf-accent)_70%,white)]" />}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="mx-2 my-1 h-px bg-white/[0.06]" />
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  className,
  width = 260,
  icon
}: {
  value: T | undefined
  options: Array<{ value: T; label: string; hint?: string; icon?: ReactNode }>
  onChange(v: T): void
  placeholder?: string
  className?: string
  width?: number
  icon?: ReactNode
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Popover
      width={width}
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          className={cn(
            'no-drag flex h-9 items-center gap-2 rounded-[10px] border border-white/[0.06] bg-white/[0.035] px-3 text-left text-[13px] text-ink-100 transition-colors hover:border-white/[0.1]',
            open && 'border-white/[0.2] bg-white/[0.05]',
            className
          )}
        >
          {(current?.icon ?? icon) && <span className="text-ink-300 [&>svg]:size-4">{current?.icon ?? icon}</span>}
          <span className={cn('min-w-0 flex-1 truncate', !current && 'text-ink-400')}>{current?.label ?? placeholder}</span>
          <ChevronDown className={cn('size-4 text-ink-400 transition-transform', open && 'rotate-180')} />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-80 overflow-y-auto">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              icon={o.icon}
              active={o.value === value}
              hint={o.hint}
              onClick={() => {
                onChange(o.value)
                close()
              }}
            >
              {o.label}
            </MenuItem>
          ))}
          {!options.length && <div className="px-3 py-2 text-[13px] text-ink-400">Nothing to choose from</div>}
        </div>
      )}
    </Popover>
  )
}
