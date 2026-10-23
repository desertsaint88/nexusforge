import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, FolderPlus, LoaderCircle, Minus, Radar, Trash, CircleAlert } from 'lucide-react'
import type { Platform } from '@shared/types'
import { invoke } from '../lib/api'
import { cn, PLATFORM_COLOR, PLATFORM_LABEL } from '../lib/format'
import { useApp } from '../store/app'
import { useLibrary } from '../store/library'
import { Button } from '../components/ui'
import { Logo } from '../components/Chrome'

const ORDER: Platform[] = ['steam', 'epic', 'xbox', 'gog', 'custom']

export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.update)
  const { scan, scanProgress, lastScan } = useLibrary()
  const [step, setStep] = useState<'welcome' | 'folders' | 'scanning' | 'done'>('welcome')

  if (!settings) return null

  const start = async () => {
    setStep('scanning')
    await scan()
    setStep('done')
  }

  const finish = () => void update({ firstRunComplete: true })

  const addFolder = async () => {
    const dir = await invoke('app:pickFolder', { title: 'Folder that contains your games' })
    if (dir && !settings.customFolders.includes(dir)) await update({ customFolders: [...settings.customFolders, dir] })
  }

  const total = lastScan?.total ?? 0

  return (
    <motion.div className="app-backdrop noise fixed inset-0 z-[45] flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.35 }}>
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <div className="relative w-full max-w-xl px-6">
        <AnimatePresence mode="wait">
          {step === 'welcome' && (
            <motion.div key="welcome" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="text-center">
              <motion.div initial={{ scale: 0.6, rotate: -20, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 160, damping: 14 }} className="relative mx-auto mb-8 w-fit">
                <div className="accent-gradient absolute inset-0 rounded-full opacity-50 blur-3xl" />
                <div className="relative">
                  <Logo size={96} />
                </div>
              </motion.div>
              <h1 className="text-gradient text-5xl font-black tracking-tight">NexusForge</h1>
              <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-ink-300">
                One place for every game you own and every mod you run. Let's find your games first.
              </p>
              <div className="mt-10 flex justify-center gap-3">
                <Button variant="primary" size="lg" icon={<Radar className="size-4.5" />} onClick={() => setStep('folders')}>
                  Get started
                </Button>
              </div>
            </motion.div>
          )}

          {step === 'folders' && (
            <motion.div key="folders" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <h2 className="text-3xl font-bold tracking-tight text-ink-100">Where are your games?</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-300">
                Steam, Epic, Xbox and GOG are found automatically. If you keep other games in folders of your own, add those folders here. You can change this later in Settings.
              </p>
              <div className="glass mt-6 rounded-2xl p-2">
                {settings.customFolders.map((f) => (
                  <div key={f} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/[0.03]">
                    <FolderPlus className="size-4 text-ink-400" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-200">{f}</span>
                    <button className="rounded-md p-1 text-ink-400 hover:text-rose-300" onClick={() => void update({ customFolders: settings.customFolders.filter((x) => x !== f) })} aria-label="Remove">
                      <Trash className="size-3.5" />
                    </button>
                  </div>
                ))}
                <button onClick={() => void addFolder()} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[13px] font-medium text-ink-300 transition-colors hover:bg-white/[0.04] hover:text-ink-100">
                  <span className="flex size-7 items-center justify-center rounded-lg border border-dashed border-white/20">+</span>
                  Add a game folder
                </button>
              </div>
              <div className="mt-8 flex justify-between">
                <Button variant="ghost" onClick={() => setStep('welcome')}>
                  Back
                </Button>
                <Button variant="primary" size="lg" icon={<Radar className="size-4.5" />} onClick={() => void start()}>
                  Scan my PC
                </Button>
              </div>
            </motion.div>
          )}

          {(step === 'scanning' || step === 'done') && (
            <motion.div key="scan" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <div className="mb-8 flex items-center gap-5">
                <div className="relative flex size-20 items-center justify-center">
                  {step === 'scanning' ? (
                    <>
                      <motion.div className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--nf-accent)_60%,transparent)]" animate={{ scale: [1, 1.6], opacity: [0.8, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
                      <motion.div className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--nf-accent-2)_60%,transparent)]" animate={{ scale: [1, 1.6], opacity: [0.8, 0] }} transition={{ duration: 1.6, repeat: Infinity, delay: 0.8 }} />
                      <div className="accent-gradient flex size-14 items-center justify-center rounded-full text-white shadow-[0_0_40px_-5px_var(--nf-accent)]">
                        <Radar className="size-6 animate-spin-slow" />
                      </div>
                    </>
                  ) : (
                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 15 }} className="flex size-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_0_40px_-5px_#10b981]">
                      <Check className="size-7" />
                    </motion.div>
                  )}
                </div>
                <div>
                  <h2 className="text-3xl font-bold tracking-tight text-ink-100">{step === 'scanning' ? 'Scanning your PC…' : `Found ${total} game${total === 1 ? '' : 's'}`}</h2>
                  <p className="mt-1 text-[14px] text-ink-300">{step === 'scanning' ? 'Reading launcher libraries and your folders. Nothing is changed.' : `Took ${((lastScan?.durationMs ?? 0) / 1000).toFixed(1)} s.`}</p>
                </div>
              </div>
              <div className="glass space-y-1 rounded-2xl p-2">
                {ORDER.map((p, i) => {
                  const prog = scanProgress[p]
                  return (
                    <motion.div key={p} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }} className="flex items-center gap-3 rounded-xl px-4 py-3">
                      <span className="size-2 rounded-full" style={{ background: PLATFORM_COLOR[p], boxShadow: `0 0 10px ${PLATFORM_COLOR[p]}` }} />
                      <span className="flex-1 text-[14px] font-medium text-ink-100">{p === 'custom' ? 'Your folders' : PLATFORM_LABEL[p]}</span>
                      <span className={cn('flex items-center gap-2 text-[13px] tabular-nums', prog?.status === 'done' && prog.found ? 'text-ink-100' : 'text-ink-400')}>
                        {!prog || prog.status === 'scanning' ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : prog.status === 'skipped' ? (
                          <>
                            <Minus className="size-4" /> off
                          </>
                        ) : prog.status === 'error' ? (
                          <>
                            <CircleAlert className="size-4 text-rose-400" /> error
                          </>
                        ) : (
                          <>
                            {prog.found} found <Check className="size-4 text-emerald-400" />
                          </>
                        )}
                      </span>
                    </motion.div>
                  )
                })}
              </div>
              <div className="mt-8 flex justify-end">
                <Button variant="primary" size="lg" disabled={step === 'scanning'} icon={<ArrowRight className="size-4.5" />} onClick={finish}>
                  Open my library
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
