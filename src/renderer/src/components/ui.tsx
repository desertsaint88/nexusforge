import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { LoaderCircle, Search, X } from 'lucide-react'
import { cn } from '../lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'accent-gradient text-white shadow-[0_8px_30px_-8px_color-mix(in_oklab,var(--nf-accent)_70%,transparent)] hover:brightness-110 active:brightness-95 border border-white/15',
  secondary: 'bg-white/[0.06] hover:bg-white/[0.1] text-ink-100 border border-white/[0.08]',
  outline: 'bg-transparent hover:bg-white/[0.05] text-ink-100 border border-white/[0.12]',
  ghost: 'bg-transparent hover:bg-white/[0.06] text-ink-200 hover:text-ink-100 border border-transparent',
  danger: 'bg-rose-500/12 hover:bg-rose-500/20 text-rose-300 border border-rose-400/20'
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-2xl font-semibold'
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
        checked ? 'accent-gradient border-white/20' : 'border-white/10 bg-white/[0.08]'
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 700, damping: 35 }}
        className={cn('block size-4 rounded-full bg-white shadow-md', checked ? 'ml-[18px]' : 'ml-[2px]')}
      />
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'no-drag h-9.5 w-full rounded-xl border border-white/[0.08] bg-black/25 px-3.5 text-sm text-ink-100 placeholder:text-ink-400 transition-colors outline-none focus:border-[color-mix(in_oklab,var(--nf-accent)_60%,transparent)] focus:bg-black/35',
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
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
      <Input autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pr-8 pl-9" />
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
    neutral: 'bg-white/[0.06] text-ink-200 border-white/[0.08]',
    accent: 'bg-[color-mix(in_oklab,var(--nf-accent)_18%,transparent)] text-[color-mix(in_oklab,var(--nf-accent)_55%,white)] border-[color-mix(in_oklab,var(--nf-accent)_35%,transparent)]',
    success: 'bg-emerald-500/12 text-emerald-300 border-emerald-400/20',
    warning: 'bg-amber-500/12 text-amber-300 border-amber-400/20',
    danger: 'bg-rose-500/12 text-rose-300 border-rose-400/20',
    info: 'bg-sky-500/12 text-sky-300 border-sky-400/20'
  }
  return <span className={cn('inline-flex h-5.5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-semibold tracking-wide whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function ProgressBar({ value, indeterminate, className }: { value?: number; indeterminate?: boolean; className?: string }) {
  return (
    <div className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]', className)}>
      {indeterminate ? (
        <motion.div
          className="accent-gradient absolute inset-y-0 w-1/3 rounded-full"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <motion.div
          className="accent-gradient absolute inset-y-0 left-0 rounded-full"
          initial={false}
          animate={{ width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        />
      )}
    </div>
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
      <div className="mb-1.5 text-[12.5px] font-medium text-ink-200">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{hint}</div>}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange(v: T): void; size?: 'sm' | 'md' }) {
  return (
    <div className="no-drag inline-flex rounded-xl border border-white/[0.07] bg-black/25 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative rounded-[10px] font-medium transition-colors',
            size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
          )}
        >
          {value === o.value && <motion.span layoutId={`seg-${options.map((x) => x.value).join('-')}`} className="absolute inset-0 rounded-[10px] bg-white/[0.09]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}
