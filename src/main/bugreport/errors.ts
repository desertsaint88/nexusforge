// Every error NexusForge sees, kept in memory for bug reports: anything logged as an error by any part of the app
// (the logger hook), uncaught exceptions and rejections in the main process, errors in the window, and crashed
// processes (renderer, GPU). Crashes and uncaught errors also show a toast with a Report button.

import { app } from 'electron'
import type { RecordedError } from '@shared/types'
import { logger } from '../logger'
import { emit } from '../events'

const MAX = 60
const recent: RecordedError[] = []
const listeners = new Set<() => void>()

export function recentErrors(): RecordedError[] {
  return [...recent]
}

/** Called when the list changes (the renderer gets the new count). */
export function onErrorsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function text(v: unknown): string {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function stackOf(values: unknown[]): string | undefined {
  const err = values.find((v): v is Error => v instanceof Error)
  return err?.stack?.split('\n').slice(0, 12).join('\n')
}

export function recordError(e: Omit<RecordedError, 'at'> & { at?: number }): void {
  const entry: RecordedError = { at: e.at ?? Date.now(), source: e.source, scope: e.scope, message: e.message.slice(0, 2000), detail: e.detail?.slice(0, 6000) }
  const last = recent.at(-1)
  // The same error twice in a row (a retry loop) is kept once.
  if (last && last.message === entry.message && last.scope === entry.scope && entry.at - last.at < 5000) return
  recent.push(entry)
  if (recent.length > MAX) recent.splice(0, recent.length - MAX)
  for (const fn of listeners) fn()
}

let lastToast = 0
/** A toast for errors nobody handled (rate-limited: at most one every 20 s). */
function unexpected(title: string, message: string): void {
  if (Date.now() - lastToast < 20_000) return
  lastToast = Date.now()
  emit('toast', {
    kind: 'error',
    title,
    message,
    sticky: true,
    action: { id: 'report', label: 'Report', report: { title, error: { message }, origin: 'crash' } }
  })
}

let installed = false

/** Hooks into the logger, the process and Electron's crash events. Call once, after the logger is set up. */
export function installErrorCapture(): void {
  if (installed) return
  installed = true

  // Each log message passes every transport; it is recorded once.
  const seen = new WeakSet<object>()
  logger.hooks.push((message) => {
    if (message.level === 'error' && !seen.has(message)) {
      seen.add(message)
      const data = message.data ?? []
      recordError({ source: 'main', scope: message.scope, message: data.map(text).join(' ') || 'error', detail: stackOf(data), at: message.date?.getTime() })
    }
    return message
  })

  process.on('uncaughtException', (err) => {
    // electron-log logs it (and the hook records it); the toast tells the user something went wrong.
    unexpected('Something went wrong in NexusForge', err?.message ?? String(err))
  })
  process.on('unhandledRejection', (reason) => {
    unexpected('Something went wrong in NexusForge', reason instanceof Error ? reason.message : String(reason))
  })

  app.on('render-process-gone', (_e, _wc, details) => {
    if (details.reason === 'clean-exit') return
    const message = `A page process ended: ${details.reason} (exit code ${details.exitCode})`
    logger.error(message)
    unexpected('A NexusForge window crashed', message)
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    const message = `${details.type} process ended: ${details.reason} (exit code ${details.exitCode})${details.name ? ` [${details.name}]` : ''}`
    logger.error(message)
    if (details.type === 'GPU') unexpected('The graphics process of NexusForge crashed', `${message}. NexusForge restarted it; if the window looks wrong, restart NexusForge.`)
  })
}
