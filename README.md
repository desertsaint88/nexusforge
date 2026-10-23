# NexusForge

Universal game mod manager & launcher for Windows. Electron 45 · Vite 8 · React 19 · TypeScript · Tailwind CSS 4 · Framer Motion · Zustand.

## Features

**Library & launcher**
- First-run scan of Steam (every `libraryfolders.vdf` library, playtime and last played from your Steam profile, cached artwork), Epic Games Store manifests, Xbox / Microsoft Store games (`.GamingRoot`, launched by package AUMID), GOG (registry), and your own game folders. A folder of folders is expanded once.
- Manual add by `.exe` or folder, with exe detection that skips uninstallers, crash handlers and redistributables.
- Library grid with cover art (Steam cache → Steam CDN → Steam store lookup by name → generated art), playtime, mod count, favorites, filters, sort, and a Continue Playing banner. Playtime is tracked for games NexusForge starts directly.

**Mod deployment (VFS)**
- Mods are staged in NexusForge's storage and deployed as **symlinks → hardlinks → copies**, falling back per file with a plain-language reason (Developer Mode / admin for symlinks, same drive for hardlinks). A per-game capability check shows what's available.
- Incremental: only changed files are touched. Original game files are moved to a backup and restored on purge. A deployed file the game changed afterwards is moved to an *overwrite* folder instead of being deleted. Paths can't escape the target folder. Every deploy is tracked in a manifest.
- Archives: zip, 7z (bundled 7-Zip), rar/tar (Windows' libarchive), folders, single files. Wrapper folders and `Data/` roots are detected, and the content folder can be changed per mod. Thunderstore packages are re-laid out for BepInEx.
- Drag-and-drop load order (`@hello-pangea/dnd`); later mods win. Profiles per game, each saved as its own JSON file.
- **Conflict resolver**: groups of mods that overwrite the same files, a winner picker per file, and "prefer this mod for the whole group". Pinned choices survive reordering.

**Mod sources**
- Adapter interface (`ModSourceAdapter`) with Nexus Mods (search without a key; direct downloads with a Premium API key, otherwise the file page opens), Thunderstore and Modrinth built in.
- Custom JSON feeds (URL or local file) and trusted JavaScript plugins. See [docs/PLUGINS.md](docs/PLUGINS.md).
- Download manager with progress, speed, cancel, retry, and auto-install into the chosen game.

**Security & logging**
- Context isolation, sandboxed renderer, no Node in the renderer, an allow-listed preload bridge, IPC sender checks, a production CSP, denied permission requests, external links opened in the browser, and images served through a scheme that returns image files only.
- API keys are encrypted with Windows DPAPI (`safeStorage`). Plugins only load after you trust them, and trust resets when their code changes.
- `electron-log` writes to `%APPDATA%\NexusForge\logs\main.log`.

## Develop

```powershell
npm install          # also downloads the Electron binary
npm run dev          # hot-reloading app
npm run typecheck
npm test             # unit tests (deploy engine, conflicts, scanners, archive layouts)
npm run build
npm run smoke        # end-to-end run of the built app with screenshots in .smoke/shots
npm run dist         # NSIS installer + portable exe in release/
```

`npm run smoke` uses a throwaway data folder and a fake game under `.smoke/`; it never deploys into real games.
Set `NEXUSFORGE_SMOKE_FOLDERS="C:\Games;E:\Games"` to also scan those folders (read-only).
`NEXUSFORGE_USER_DATA` points the app at a different data folder (testing / portable use).

## Layout

```
src/main        Electron main process
  library/      scanners (steam, epic, xbox, gog, custom), artwork, presets, launching
  mods/         archive install, layout detection, plan/conflicts, deploy engine, profiles
  sources/      adapter interface, Nexus/Thunderstore/Modrinth, feeds, plugin loader
  downloads/    download manager
src/preload     context bridge (allow-listed channels)
src/shared      types + typed IPC contract
src/renderer    React UI (pages, components, zustand stores)
tests/          vitest
```

## Data

Everything lives in `%APPDATA%\NexusForge`: `nexusforge.json` (library, settings, mod metadata), `mods/` (staging, configurable), `profiles/<game>/<profile>.json`, `deployments/<game>.json` (manifests), `backups/`, `overwrite/`, `downloads/`, `plugins/`, `logs/`.
