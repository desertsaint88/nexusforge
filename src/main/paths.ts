import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { db } from './store'

export function gameKey(gameId: string): string {
  return gameId.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function ensure(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}

export const paths = {
  userData: () => app.getPath('userData'),
  cache: (...parts: string[]) => ensure(join(app.getPath('userData'), 'cache', ...parts)),
  downloads: () => ensure(join(app.getPath('userData'), 'downloads')),
  plugins: () => ensure(join(app.getPath('userData'), 'plugins')),
  profiles: (gameId: string) => ensure(join(app.getPath('userData'), 'profiles', gameKey(gameId))),
  deployManifest: (gameId: string) => join(ensure(join(app.getPath('userData'), 'deployments')), `${gameKey(gameId)}.json`),
  backups: (gameId: string) => join(app.getPath('userData'), 'backups', gameKey(gameId)),
  overwrite: (gameId: string) => join(app.getPath('userData'), 'overwrite', gameKey(gameId)),
  modStaging: (gameId: string) => ensure(join(db().get('settings').modStorageDir, gameKey(gameId)))
}
