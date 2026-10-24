import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Ban, Globe, Lock, MousePointerClick, RotateCw } from 'lucide-react'
import type { SitePanelState } from '@shared/types'
import { invoke, on } from '../lib/api'
import { cn } from '../lib/format'
import { Button } from './ui'

const CLOSED: SitePanelState = { open: false, title: '', hint: '', url: '', loading: false, canGoBack: false, waiting: [] }

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The in-app browser panel. The page itself is a native view that the main process lays over the
 * placeholder below; this component draws the frame around it and reports where the placeholder is.
 */
export function SitePanelHost() {
  const [state, setState] = useState<SitePanelState>(CLOSED)
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void invoke('sitepanel:state').then(setState, () => {})
    return on('sitepanel:state', setState)
  }, [])

  // Keep the native page exactly over the slot, through window resizes and the open animation.
  useLayoutEffect(() => {
    if (!state.open) return
    const el = slot.current
    if (!el) return
    let frame = 0
    const send = () => {
      const r = el.getBoundingClientRect()
      void invoke('sitepanel:bounds', { x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => {})
    }
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    // The card scales in; follow it for the length of the animation.
    const started = performance.now()
    const tick = () => {
      send()
      if (performance.now() - started < 450) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
      cancelAnimationFrame(frame)
    }
  }, [state.open, state.id])

  const host = hostOf(state.url)
  const others = state.waiting.filter((w) => w.id !== state.id)

  return (
    <AnimatePresence>
      {state.open && (
        <motion.div
          key="sitepanel"
          className="fixed inset-x-0 top-10 bottom-0 z-[60] flex items-stretch justify-center p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[5px]" />
          <motion.div
            className="glass-strong relative flex w-full max-w-[1280px] flex-col overflow-hidden rounded-3xl"
            initial={{ scale: 0.97, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <div className="flex items-start gap-3.5 px-5 pt-4 pb-3">
              <div className="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-xl text-white shadow-lg">
                <MousePointerClick className="size-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-[15.5px] font-semibold tracking-tight text-ink-100">{state.title}</h3>
                  {/* Other downloads waiting for a click; the page area below is native, so no drop-downs here. */}
                  {others.slice(0, 3).map((w) => (
                    <button
                      key={w.id}
                      onClick={() => void invoke('sitepanel:show', w.id)}
                      className="max-w-40 truncate rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-300 hover:bg-white/[0.1] hover:text-ink-100"
                      title={`Also waiting: ${w.title}`}
                    >
                      {w.title}
                    </button>
                  ))}
                  {others.length > 3 && <span className="text-[11px] text-ink-400">+{others.length - 3} more</span>}
                </div>
                <p className="mt-0.5 text-[13px] leading-snug text-amber-200/90">{state.hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="ghost" className="px-2" aria-label="Back" disabled={!state.canGoBack} onClick={() => void invoke('sitepanel:navigate', 'back')}>
                  <ArrowLeft className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" className="px-2" aria-label="Reload" onClick={() => void invoke('sitepanel:navigate', 'reload')}>
                  <RotateCw className={cn('size-3.5', state.loading && 'animate-spin')} />
                </Button>
                <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => void invoke('sitepanel:cancel')}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void invoke('sitepanel:hide')}>
                  Hide
                </Button>
              </div>
            </div>
            <div className="mx-5 mb-2 flex items-center gap-2 rounded-lg bg-black/25 px-3 py-1.5 font-mono text-[11.5px] text-ink-400">
              {state.url.startsWith('https:') ? <Lock className="size-3 text-emerald-400/80" /> : <Globe className="size-3" />}
              <span className="truncate">{host || 'loading…'}</span>
            </div>
            <div ref={slot} className="relative mx-5 mb-5 min-h-0 flex-1 rounded-[14px] bg-black/30">
              <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-500">Loading {host || 'page'}…</div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
