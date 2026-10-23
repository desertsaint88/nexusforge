import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '../lib/format'
import { useConfirm } from '../store/ui'
import { Button } from './ui'

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  width = 'max-w-lg',
  bodyClassName
}: {
  open: boolean
  onClose(): void
  title?: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
  bodyClassName?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[6px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn('glass-strong relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-3xl', width)}
            initial={{ opacity: 0, scale: 0.94, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            {(title || icon) && (
              <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
                {icon && <div className="accent-gradient flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-lg">{icon}</div>}
                <div className="min-w-0 flex-1">
                  <h3 className="text-[17px] font-semibold tracking-tight text-ink-100">{title}</h3>
                  {subtitle && <p className="mt-0.5 text-[13px] text-ink-300">{subtitle}</p>}
                </div>
                <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-white/[0.07] hover:text-ink-100" aria-label="Close">
                  <X className="size-4.5" />
                </button>
              </div>
            )}
            <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6', !title && !icon && 'pt-6', bodyClassName)}>{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-black/20 px-6 py-4">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export function ConfirmHost() {
  const { request, close } = useConfirm()
  return (
    <Modal
      open={Boolean(request)}
      onClose={() => close(false)}
      title={request?.title}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant={request?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {request?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed whitespace-pre-line text-ink-200">{request?.message}</p>
    </Modal>
  )
}
