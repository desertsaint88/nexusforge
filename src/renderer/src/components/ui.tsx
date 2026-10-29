import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { LoaderCircle, Search, X } from 'lucide-react'
import { cn } from '../lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  // The main action is light on dark; everything else is a quiet surface that lightens on hover.
  primary: 'btn-light border border-transparent font-semibold hover:brightness-[1.06] active:brightness-95',
  secondary: 'bg-white/[0.065] hover:bg-white/[0.1] text-ink-100 border border-transparent',
  outline: 'bg-transparent hover:bg-white/[0.05] text-ink-100 border border-white/[0.1] hover:border-white/[0.16]',
  ghost: 'bg-transparent hover:bg-white/[0.06] text-ink-300 hover:text-ink-100 border border-transparent',
  danger: 'bg-rose-500/10 hover:bg-rose-500/[0.16] text-rose-300 border border-transparent'
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-[13px] gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[14px] gap-2.5 rounded-xl font-semibold'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'no-drag relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-all duration-200 ease-[var(--ease-spring)] select-none disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'no-drag inline-flex size-8 items-center justify-center rounded-lg text-ink-300 transition-colors hover:bg-white/[0.07] hover:text-ink-100 disabled:opacity-40',
        active && 'bg-white/[0.08] text-ink-100',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        'no-drag relative inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-40',
        checked ? 'accent-line border-transparent' : 'border-transparent bg-white/[0.1]'
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 700, damping: 35 }}
        className={cn('block size-4 rounded-full shadow-md', checked ? 'ml-[18px] bg-ink-950' : 'ml-[2px] bg-ink-200')}
      />
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'no-drag h-9 w-full rounded-[10px] border border-white/[0.06] bg-white/[0.035] px-3 text-[13px] text-ink-100 placeholder:text-ink-400 transition-colors outline-none hover:border-white/[0.1] focus:border-white/[0.2] focus:bg-white/[0.05]',
        mono && 'font-mono text-[12.5px]',
        className
      )}
      {...rest}
    />
  )
})

export function SearchInput({ value, onChange, placeholder, className, autoFocus }: { value: string; onChange(v: string): void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-400" />
      <Input autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pr-8 pl-8.5" />
      {value && (
        <button className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-ink-400 hover:text-ink-100" onClick={() => onChange('')} aria-label="Clear">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; className?: string }) {
  const tones = {
    neutral: 'bg-white/[0.07] text-ink-200',
    accent: 'bg-[color-mix(in_oklab,var(--nf-accent)_18%,transparent)] text-[color-mix(in_oklab,var(--nf-accent)_50%,white)]',
    success: 'bg-emerald-500/[0.13] text-emerald-300',
    warning: 'bg-amber-500/[0.13] text-amber-300',
    danger: 'bg-rose-500/[0.13] text-rose-300',
    info: 'bg-sky-500/[0.13] text-sky-300'
  }
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded-[6px] px-1.5 text-[11px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function ProgressBar({ value, indeterminate, className }: { value?: number; indeterminate?: boolean; className?: string }) {
  return (
    <div className={cn('relative h-1 w-full overflow-hidden rounded-full bg-white/[0.08]', className)}>
      {indeterminate ? (
        <motion.div
          className="accent-line absolute inset-y-0 w-1/3 rounded-full"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <motion.div
          className="accent-line absolute inset-y-0 left-0 rounded-full"
          initial={false}
          animate={{ width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        />
      )}
    </div>
  )
}

/** NexusForge's play mark: a soft-cornered triangle, optically centered. */
export function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-4', className)}>
      <path d="M8.6 5.2c-.8-.5-1.85.08-1.85 1.03v11.54c0 .95 1.05 1.53 1.85 1.03l9.3-5.77a1.2 1.2 0 0 0 0-2.06z" fill="currentColor" />
    </svg>
  )
}

/** The Play button: the one light, solid button on a page. Disabled (running, missing) it turns into a quiet chip. */
export function PlayButton({
  label = 'Play',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  const s = {
    sm: { box: 'h-8 gap-1.5 rounded-lg px-3 text-[12.5px]', glyph: 'size-3' },
    md: { box: 'h-10 gap-2 rounded-[10px] px-4.5 text-[13.5px]', glyph: 'size-3.5' },
    lg: { box: 'h-11 gap-2.5 rounded-xl px-6 text-[14px]', glyph: 'size-3.5' }
  }[size]
  return (
    <button
      className={cn(
        'no-drag btn-light inline-flex shrink-0 items-center justify-center font-semibold shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)] transition-all duration-200 hover:brightness-[1.06] active:scale-[0.98] disabled:pointer-events-none disabled:bg-white/[0.08] disabled:text-ink-300 disabled:shadow-none disabled:backdrop-blur-md',
        s.box,
        className
      )}
      {...rest}
    >
      <PlayGlyph className={cn('-ml-0.5', s.glyph)} />
      {label}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('size-4 animate-spin text-ink-300', className)} />
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('glass rounded-2xl', className)} {...rest}>
      {children}
    </div>
  )
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink-100">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-300">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-ink-300">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{hint}</div>}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange(v: T): void; size?: 'sm' | 'md' }) {
  return (
    <div className="no-drag inline-flex rounded-[10px] bg-white/[0.04] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative rounded-lg font-medium transition-colors',
            size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
          )}
        >
          {value === o.value && <motion.span layoutId={`seg-${options.map((x) => x.value).join('-')}`} className="absolute inset-0 rounded-lg bg-white/[0.09] shadow-[0_1px_2px_rgba(0,0,0,0.4)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}
