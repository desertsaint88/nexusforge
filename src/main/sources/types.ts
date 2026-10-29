import type { Game, ModDependency, ModDetails, ModSearchOptions, ModSearchResult, ModSort, SourceGameBinding } from '@shared/types'

/**
 * A mod source. Implement this to plug any mod site or feed into NexusForge.
 * `gameId` is a NexusForge game id (e.g. "steam:489830"); use `ctx.getGame()` / `ctx.binding()` to map it
 * to whatever the source calls that game.
 */
export interface ModSourceAdapter {
  id: string
  name: string
  /** `opts.sort` is only set for orders listed in `sorts`; NexusForge sorts the results itself otherwise. */
  search(query: string, gameId?: string, opts?: ModSearchOptions): Promise<ModSearchResult[]>
  getModDetails(modId: string, gameId?: string): Promise<ModDetails>
  getDownloadUrl(modId: string, versionId: string, gameId?: string): Promise<string>

  // Optional extras ----------------------------------------------------------
  /** Orders the source produces on its side (top rated, most downloaded, trending, …). */
  sorts?: ModSort[]
  /** What the site itself calls each of those orders ("Endorsements", "Most Subscribed"), shown in the sort menu. */
  sortLabels?: Partial<Record<ModSort, string>>
  /** Orders the site's search can produce, when that's fewer than `sorts` (default: all of `sorts`). */
  querySorts?: ModSort[]
  /** `search` honours `opts.page` (0-based) for the site's further pages (an empty page ends the list). */
  paged?: boolean
  /** Results per full page; a shorter page is the last one. Leave unset if pages can come back short (filtered). */
  pageSize?: number
  /**
   * Time-limited orders and the windows the site can show them for, in days (0 = all time), the site's own
   * default first. `search` gets the one to use as `opts.windowDays`; NexusForge looks further back when the
   * default window holds only a few mods.
   */
  windows?: Partial<Record<ModSort, number[]>>
  /** Orders that leave mods out (only rated ones, say), and the order the rest follow in when the list is short. */
  fills?: Partial<Record<ModSort, ModSort>>
  description?: string
  homepage?: string
  /** Shown as the label of the per-game binding field ("Thunderstore community"). */
  bindingLabel?: string
  /** Whether the user can (or must) enter an API key in Settings › Sources. */
  apiKey?: 'optional' | 'required'
  /** Where to get a key, shown next to the key field. */
  apiKeyUrl?: string
  /** Suggested values for the per-game binding; the first one is used when the user hasn't chosen. */
  suggestBindings?(game: Game): Promise<SourceGameBinding[]>
  /** Web page for a mod, used when a download needs the browser. */
  getModPageUrl?(modId: string, gameId?: string): string | undefined
  /**
   * Richer alternative to getDownloadUrl for downloads that are not a plain URL:
   * a click on the website (captured by NexusForge's own browser window) or a SteamCMD job.
   */
  getDownload?(modId: string, versionId: string, gameId?: string): Promise<DownloadPlan>
  /** Direct dependencies of one version of a mod. NexusForge resolves them recursively. */
  resolveDependencies?(modId: string, versionId: string | undefined, gameId?: string): Promise<ModDependency[]>
  dispose?(): void
}

export type DownloadPlan =
  | { kind: 'url'; url: string; fileName?: string; headers?: Record<string, string> }
  | {
      kind: 'browser'
      /** Page the user downloads from; the file is captured from NexusForge's window. */
      pageUrl: string
      /** Session partition, so a login on the site is remembered. */
      partition: string
      hint: string
      /** false: the site starts the download by itself, so the page loads in the background (default true). */
      interactive?: boolean
      /** Built-in page helper that highlights the button the user has to press. */
      helper?: 'nexus' | 'moddb'
      /** If the page leads to nxm:// links instead of a file, turn them into a download URL. */
      resolveNxm?: (nxmUrl: string) => Promise<string>
    }
  | { kind: 'steamcmd'; appId: string; itemId: string; title: string }

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
  text(url: string, opts?: HttpOptions): Promise<string>
  /** Loads a page in a real (hidden) browser window, for sites behind bot checks. Returns the final HTML. */
  browserHtml(url: string, partition?: string): Promise<string>
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
}

export type AdapterFactory = (ctx: AdapterContext) => ModSourceAdapter
