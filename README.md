# NexusForge

Universal game mod manager & launcher for Windows. Electron 45 · Vite 8 · React 19 · TypeScript · Tailwind CSS 4 · Framer Motion · Zustand.

## Features

**Library & launcher**
- First-run scan of Steam (every `libraryfolders.vdf` library, playtime and last played from your Steam profile, cached artwork), Epic Games Store manifests, Xbox / Microsoft Store games (`.GamingRoot`, launched by package AUMID), GOG (registry), and your own game folders. A folder of folders is expanded once.
- **Every drive**: "Games"-style folders at each local drive's root, Steam libraries Steam doesn't know about, and the launcher folders in Program Files are scanned without any setup. Release folder names are cleaned ("Hell.Let.Loose.Vietnam.v1.4.1-OFME" → "Hell Let Loose Vietnam").
- **Console games**: disc images in folders without a PC game (e.g. `C:\Games\PS2`) and in PCSX2's game list start in the installed emulator (PCSX2, DuckStation, PPSSPP, Dolphin), with box art from libretro-thumbnails.
- Manual add by `.exe` or folder, with exe detection that skips uninstallers, crash handlers and redistributables.
- Library grid with cover art, playtime, mod count, mod-support badges, favorites, filters (incl. "Mod support" and "Modded"), sort, and a Continue Playing banner. Playtime is tracked for games NexusForge starts, also when a launcher (PlayGTAV.exe, a .bat, steam://) exits right away: the game's own process is followed in its folder (`library/tracker.ts`).
- **Quick search**: Ctrl + K (or the box in the title bar) jumps to any game or page; Ctrl + Enter starts the selected game.
- **Interface size** (Settings � General, Ctrl + / Ctrl - / Ctrl 0, Ctrl + mouse wheel) for small windows and TVs.
- **Artwork**: Steam's local cache first, then the Steam store's *current* pictures from `IStoreBrowseService/GetItems` (newer games keep them under hashed paths; the old plain CDN paths 404), each checked to load before it's used. Games outside Steam are matched by folder name, the exe's product name and Unity's `app.info`, with abbreviations ("FNAF", "GTA", "HLL") and demo/edition suffixes handled; an exact match also fixes the title's spelling ("Hell Let Loose: Vietnam"). Pictures shipped in the game folder (`cover.jpg`, `banner.png`) are the fallback. Every game is re-checked once whenever the lookup improves (`ART_REV`).
- **Startup scan**: every launch looks for new games, then reads every game's folders for installed mods (can be turned off in Settings › Library).
- **Installed-mod detection** (`mods/detect-core.ts`): BepInEx (Thunderstore `manifest.json`, DLL version info), MelonLoader, UE4SS (`mods.txt`), Unreal `.pak` mods (`~mods`, `LogicMods`, `_P.pak`), Garry's Mod addons (`addon.json`, GMA headers), BeamNG (`db.json` with repository ids), Steam Workshop subscriptions (`appworkshop_<id>.acf` + titles), mod.io, Bethesda plugins (`plugins.txt`), BO3 mods/maps (`workshop.json`), X-Plane add-ons, People Playground contraptions, script hooks/ASI/ReShade and plain `Mods` folders. Files NexusForge deployed are recognized from its manifests. Whether a game can be modded comes from presets, loaders, the engine (Unity, Unreal, Source, BeamNG, Bethesda) and anti-cheat (EasyAntiCheat/BattlEye lower the verdict).

**Mod deployment (VFS)**
- Mods are staged in NexusForge's storage and deployed as **symlinks → hardlinks → copies**, falling back per file with a plain-language reason (Developer Mode / admin for symlinks, same drive for hardlinks). A per-game capability check shows what's available.
- Incremental: only changed files are touched. Original game files are moved to a backup and restored on purge. A deployed file the game changed afterwards is moved to an *overwrite* folder instead of being deleted. Paths can't escape the target folder. Every deploy is tracked in a manifest.
- Archives: zip, 7z (bundled 7-Zip), rar/tar (Windows' libarchive), folders, single files. Wrapper folders and `Data/` roots are detected, and the content folder can be changed per mod. Thunderstore packages are re-laid out for BepInEx.
- Drag-and-drop load order (`@hello-pangea/dnd`); later mods win. Profiles per game, each saved as its own JSON file.
- **Conflict resolver**: groups of mods that overwrite the same files, a winner picker per file, and "prefer this mod for the whole group". Pinned choices survive reordering.

**Mod sources**
- Adapter interface (`ModSourceAdapter`) with Nexus Mods, Steam Workshop (SteamCMD), Thunderstore, mod.io, CurseForge, ModDB, Modrinth, the BeamNG repository and mod loaders (BepInEx, MelonLoader from GitHub) built in. Requirements are resolved recursively and installed first.
- **Sorting**: Best match, Top rated, Most downloaded (all time and recent), Trending and Recently added/updated. Each source sorts on its side where it can (Nexus GraphQL with date windows for trending/recent, mod.io `_sort`, CurseForge `sortField`, Workshop `browsesort` + `days`, Thunderstore/Modrinth orderings, BeamNG and ModDB list orders); otherwise NexusForge sorts the results and says so. Mods already installed in the game are marked in the list and the details, with an "Installed" filter.
- **Accounts**: Nexus Mods, mod.io and CurseForge sign-in happens inside the app (the site's login page in the site panel). Afterwards NexusForge reads the personal API key from the site's key page, checks it against the site's API and stores it encrypted. Pressing Download while signed out asks to sign in first. Steam: SteamCMD signs in once with name + password (+ Steam Guard); the password is never stored.
- **Cloudflare**: site pages use Electron's own user agent. Posing as Google Chrome made Cloudflare Turnstile fail (error 600010) because the rest of the fingerprint is Electron's; honest, the check passes by itself. If a check still fails, NexusForge clears that site's Cloudflare cookies and retries once, then offers "Open in my browser". Accounts can also be signed in through the user's own browser: the key page opens there and the copied key is picked up from the clipboard (only while that sign-in is running, only strings shaped like the site's key).
- Downloads never leave the app: pages that need a click (Nexus "Slow download" for free accounts, bot checks) open in the in-app site panel with the button highlighted, and the file installs as soon as it lands.
- BeamNG.drive mods stay zipped and go to BeamNG's user folder (`startup.ini` `UserPath` respected).
- Custom JSON feeds (URL or local file) and trusted JavaScript plugins. See [docs/PLUGINS.md](docs/PLUGINS.md).
- Download manager with progress, speed, time left, cancel, retry, per-entry remove, and auto-install into the chosen game. Page downloads (Nexus "Slow download") keep their page open in the background until the file is complete, and a dropped connection resumes where it stopped. Progress shows on the taskbar button (yellow + flashing when a download waits for your click); finished installs notify while NexusForge is in the background.
- **Mod updates** (`mods/updates.ts`): mods installed from a source are checked against the site's files (cached 30 min, "Check for updates" in the Mods menu). Files only replace files of the same channel (a Nexus main file the newest main file, an optional file only newer uploads of itself). "Update all" or the version badge downloads the new file, which replaces the old copy in place (same load-order position and enabled state).
- **Load more**: Nexus, Steam Workshop, Thunderstore, mod.io, CurseForge, ModDB, Modrinth and the BeamNG repository continue their lists page by page in the site's own order.

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
node scripts/smoke-sources.mjs   # live checks against the real mod sites (.smoke/sources/shots)
node scripts/smoke-1.2.mjs       # artwork, installed-mod detection, sorting, look (this PC's library, read-only)
node scripts/smoke-cloudflare.mjs  # Nexus login/registration pass Cloudflare inside the app (no automation driver)
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
