// Which integration handles a game: the first one that matches, most specific first.

import type { Game } from '@shared/types'
import type { GameIntegration, IntegrationEnv } from './types'
import { terrariaIntegration } from './terraria'
import { casualtiesIntegration } from './casualties'
import { BEPINEX_GAMES, bepinexIntegration } from './bepinex'
import { gta5Integration } from './gta5'
import { cyberpunkIntegration } from './cyberpunk'
import { unityIntegration } from './unity'
import { unrealIntegration } from './unreal'
import { genericIntegration } from './generic'
import { withReshade } from '../reshade/core'

// Specific games first, then every game of an engine (any Unity / Unreal game folder), then the generic one.
export const INTEGRATIONS: GameIntegration[] = [
  terrariaIntegration,
  casualtiesIntegration,
  ...BEPINEX_GAMES.map((s) => bepinexIntegration(s)),
  gta5Integration,
  cyberpunkIntegration,
  unityIntegration,
  unrealIntegration,
  genericIntegration
]

const cache = new Map<string, { at: number; key: string; integration: GameIntegration }>()

/** The integration for a game, with ReShade (which every game with an executable can have) added. */
export async function integrationFor(game: Game, env: IntegrationEnv): Promise<GameIntegration> {
  const key = `${game.name}|${game.exePath ?? ''}|${game.installDir}|${game.platformId ?? ''}`
  const hit = cache.get(game.id)
  if (hit && hit.key === key && Date.now() - hit.at < 15_000) return hit.integration
  for (const i of INTEGRATIONS) {
    if (await i.matches(game, env).catch(() => false)) {
      const integration = withReshade(i)
      cache.set(game.id, { at: Date.now(), key, integration })
      return integration
    }
  }
  return withReshade(genericIntegration)
}

export function forgetIntegration(gameId: string): void {
  cache.delete(gameId)
}
