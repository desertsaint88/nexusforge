// Did NexusForge close properly last time? A small marker file is written at start, touched every minute and
// marked clean when the app quits (also on Windows shutdown and before an update installs). A marker that is not
// clean at the next start means a crash, a killed process or a power loss: the user is offered a bug report.

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SessionMarker {
  startedAt: number
  lastSeen: number
  version: string
  pid: number
  clean: boolean
}

export interface LastSessionCrash {
  startedAt: number
  lastSeen: number
  version: string
  lastErrors: string[]
}

let file = ''
let marker: SessionMarker | undefined
let crash: LastSessionCrash | undefined
let timer: NodeJS.Timeout | undefined

function write(): void {
  if (!marker || !file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(marker))
  } catch {
    // A marker that can't be written only costs the crash prompt.
  }
}

/** Reads the previous session's marker (pure, for tests). */
export function previousCrash(previous: SessionMarker | undefined, logTail: string[]): LastSessionCrash | undefined {
  if (!previous || previous.clean) return undefined
  const lastErrors = logTail.filter((l) => /\[error\]/i.test(l)).slice(-8)
  return { startedAt: previous.startedAt, lastSeen: previous.lastSeen, version: previous.version, lastErrors }
}

/** Starts this session's marker. `logTail` is the end of the log before this session wrote to it. */
export function startSession(logTail: string[], dir = app.getPath('userData')): void {
  file = join(dir, 'session.json')
  let previous: SessionMarker | undefined
  try {
    previous = JSON.parse(readFileSync(file, 'utf8')) as SessionMarker
  } catch {
    previous = undefined
  }
  crash = previousCrash(previous, logTail)
  marker = { startedAt: Date.now(), lastSeen: Date.now(), version: app.getVersion(), pid: process.pid, clean: false }
  write()
  timer = setInterval(() => {
    if (!marker) return
    marker.lastSeen = Date.now()
    write()
  }, 60_000)
  timer.unref()
  const done = () => endSession()
  app.on('before-quit', done)
  app.on('will-quit', done)
  // Windows logs off / shuts down: windows get 'session-end' instead of a normal quit.
  app.on('browser-window-created', (_e, win) => win.on('session-end', done))
}

export function endSession(): void {
  if (!marker || marker.clean) return
  marker.clean = true
  marker.lastSeen = Date.now()
  if (timer) clearInterval(timer)
  write()
}

export function lastSessionCrash(): LastSessionCrash | undefined {
  return crash
}

export function dismissLastSessionCrash(): void {
  crash = undefined
}
