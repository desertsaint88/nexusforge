import type { Game, ModDetails, ModSearchResult, SourceGameBinding } from '@shared/types'

/**
 * A mod source. Implement this to plug any mod site or feed into NexusForge.
 * `gameId` is a NexusForge game id (e.g. "steam:489830"); use `ctx.getGame()` / `ctx.binding()` to map it
 * to whatever the source calls that game.
 */
export interface ModSourceAdapter {
  id: string
  name: string
  search(query: string, gameId?: string): Promise<ModSearchResult[]>
  getModDetails(modId: string, gameId?: string): Promise<ModDetails>
  getDownloadUrl(modId: string, versionId: string, gameId?: string): Promise<string>

  // Optional extras ----------------------------------------------------------
  description?: string
  homepage?: string
  /** Shown as the label of the per-game binding field ("Thunderstore community"). */
  bindingLabel?: string
  /** Whether the user can (or must) enter an API key in Settings › Sources. */
  apiKey?: 'optional' | 'required'
  /** Suggested values for the per-game binding; the first one is used when the user hasn't chosen. */
  suggestBindings?(game: Game): Promise<SourceGameBinding[]>
  /** Web page for a mod, used when a download needs the browser. */
  getModPageUrl?(modId: string, gameId?: string): string | undefined
  dispose?(): void
}

export interface HttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** What NexusForge hands to every adapter (built-in or plugin). */
export interface AdapterContext {
  getGame(gameId: string): Game | undefined
  /** The game's identifier for this source: the user's choice, else the adapter's best suggestion. */
  binding(gameId: string | undefined): Promise<string | undefined>
  apiKey(): string | undefined
  json<T>(url: string, opts?: HttpOptions): Promise<T>
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
}

export type AdapterFactory = (ctx: AdapterContext) => ModSourceAdapter
