# Mod sources: plugins and feeds

NexusForge talks to every mod site through one interface (`src/main/sources/types.ts`):

```ts
interface ModSourceAdapter {
  id: string
  name: string
  search(query: string, gameId?: string): Promise<ModSearchResult[]>
  getModDetails(modId: string, gameId?: string): Promise<ModDetails>
  getDownloadUrl(modId: string, versionId: string, gameId?: string): Promise<string>

  // optional
  description?: string
  homepage?: string
  bindingLabel?: string            // e.g. "Thunderstore community"; enables the per-game binding field
  apiKey?: 'optional' | 'required' // shows an API key field in Settings
  suggestBindings?(game: Game): Promise<SourceGameBinding[]>
  getModPageUrl?(modId: string, gameId?: string): string | undefined
  dispose?(): void
}
```

`gameId` is a NexusForge id such as `steam:489830`. Adapters get an `AdapterContext`:

| member | what it does |
| --- | --- |
| `getGame(gameId)` | the full `Game` record (name, install folder, platform ids) |
| `binding(gameId)` | the game's id *for this source*: what the user picked in Game › Settings, else your first `suggestBindings` result |
| `apiKey()` | the key the user saved (encrypted at rest with Windows DPAPI) |
| `json(url, opts)` | fetch + JSON with timeout and readable errors |
| `log` | scoped electron-log logger |

`getDownloadUrl` may return `https://…` or `file://…` URLs. Downloads go through the built-in download
manager, and the archive is installed into the game when the user started the download from a game.

## Built-in adapters

| source | search | download |
| --- | --- | --- |
| Nexus Mods | GraphQL v2, no key needed | Premium API key → direct; otherwise the file page opens in the browser |
| Thunderstore | cyberstorm listing API per community | direct; packages are re-laid out for BepInEx (`BepInEx/plugins/<Namespace-Name>/…`) |
| Modrinth | public v2 API | direct |

## Plugins

1. Create `%APPDATA%\NexusForge\plugins\<folder>\` (Settings › Sources & plugins › *Open folder*).
2. Add `index.js` (or `package.json` with `main`). Export `createAdapter(ctx)` returning an adapter, or the adapter object itself.
3. Click **Reload**, then **Trust & load**.

Plugins run in the main process with full rights, so they are never loaded until trusted. Trust is pinned to the
SHA-256 of the entry file: if the file changes, the plugin is unloaded and shows *code changed, re-approve*.
The registered id is always `plugin:<folder>`; ids your plugin returns are rewritten to that.

See `examples/plugins/local-folder` for a complete plugin that serves archives from a folder on disk.

## JSON feeds

No code needed: add a feed URL (or a local `.json` path) in Settings › Sources & plugins › Custom feeds.

```json
{
  "name": "My mods",
  "mods": [{
    "id": "better-ui",
    "name": "Better UI",
    "summary": "One line",
    "description": "Long text",
    "author": "me",
    "thumbnail": "https://…/icon.png",
    "url": "https://…/page",
    "games": ["steam:489830", "Skyrim Special Edition"],
    "versions": [{ "id": "1.2.0", "name": "Main file", "version": "1.2.0", "url": "files/better-ui.zip", "size": 1234, "date": "2026-10-01" }]
  }]
}
```

`games` matches NexusForge game ids or game names (leave it out to show the mod for every game). Version `url`s
can be relative to the feed. See `examples/feed.json`.
