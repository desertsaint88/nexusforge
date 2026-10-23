import log from 'electron-log/main'
import { app } from 'electron'
import { join } from 'node:path'

let initialized = false

export function initLogger(): void {
  if (initialized) return
  initialized = true
  log.initialize({ preload: false })
  log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope}{text}'
  log.transports.console.level = app.isPackaged ? false : 'debug'
  log.errorHandler.startCatching({ showDialog: false })
  log.info(`NexusForge ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform} ${process.arch})`)
}

export function setLogLevel(level: 'error' | 'warn' | 'info' | 'debug'): void {
  log.transports.file.level = level
}

export function logFilePath(): string {
  return log.transports.file.getFile().path
}

export const logger = log
export const scoped = (scope: string) => log.scope(scope)
