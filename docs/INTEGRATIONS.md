# Game integrations, verification and diagnostics

How NexusForge decides where a mod goes, how it checks the result, what it can and can't confirm, and how to add a
game. Source: `src/main/integrations/`, `src/main/mods/classify.ts`, `src/main/mods/runtime.ts`,
`src/main/diagnostics/`.

## The mod lifecycle

| Stage | Where | What is checked |
| --- | --- | --- |
| Download | `downloads/`, `util/download.ts` | HTTPS only, allowed hosts per source, SHA-256 / size when the publisher states them, resume after drops |
| Extract | `mods/archive.ts` | Paths can't leave the extraction folder (zip-slip), links in archives are refused |
| Classify | `mods/classify.ts` → `GameIntegration.classify` | Shared strategies first (below), then the game's own rules; result: kind, routes, skipped files, checks, needed loaders |
| Plan | `mods/plan.ts`, `mods/routes.ts` | Load order, conflicts (later mod wins unless pinned), one owner per file |
| Deploy | `mods/deploy.ts` | Journal first (an interrupted run is undone on the next one), originals moved to a backup, symlink → hardlink → copy per file, user-data targets (saves) always copied, paths can't escape their target, every file checked afterwards; a failure rolls back to the previous state |
| Configure | `GameIntegration.configure` | Loader lists (tModLoader `enabled.json`, UE4SS `enabled.txt`); idempotent; files it created are recorded |
| Verify | `GameIntegration.verify` | Integration's own checks: loader present and enabled, files where the game reads them |
| Runtime | `GameIntegration.checkLaunch`, `mods/runtime.ts` | The loader's log after a start, matched to the mods that own the named files |
| Diagnose / repair | `diagnostics/` | Read-only checks; repairs only after confirmation, then the checks run again |
| Remove | deploy engine purge | Only files in the manifest; replaced originals come back; a file the game changed after deployment is moved to `overwrite/`, never deleted |

### What the states mean

A deployment ends as one of:

- **verified**: every file is in place *and* the integration checked that the game will load them (loader installed,
  mod enabled in the loader's list, launch target right). Only integrations with `loadVerifiable: true` can say this.
- **deployed**: every file is in place and checked, but NexusForge can't tell whether the game loads them. The UI
  says "deployed, loading not confirmed".
- **failed** / **rolled_back**: something went wrong; with rolled_back the previous setup was restored.

Neither verified nor deployed says the mod *ran*. That only comes from the loader's log after a start, per mod:

- **loaded**: the log names the mod's file (or its plugin name and version) as loaded.
- **failed**: the log names it with an error, with the log lines as evidence and, where the log says so, what it
  needs (`needs: shvdn 3.7.0`).
- **unknown**: no line about it, or the log is older than the mod's last install/update. Never shown as "loaded".

Per mod, the UI also shows `needs_loader` (a loader it needs is missing), `blocked` (a package that is never
deployed: installer, framework mod, unplaceable save; the check says what you have to do) and `disabled`.

## Shared install strategies

They run before any game's rules, so they apply to every game (`STRATEGIES` in `mods/classify.ts`). Each states its
prerequisites, destination, validation and rollback; the diagnostic report lists them too.

| Strategy | Recognized by | Destination | If it can't be placed |
| --- | --- | --- | --- |
| Setup program | Only `.exe`/`.msi` files (besides read-mes) and the file is an installer: Inno Setup, NSIS, InstallShield, WiX, Setup Factory, Advanced Installer signatures, `.msi`, or a setup/install name | Nowhere. Kept in storage; *Run installer* (asks first) starts it | Never deployed; check `installer` |
| Save game | Save-file shapes (`looksLikeSave`) | The game's `saves` target, via `GameIntegration.saveRoutes`: always a copy, a free slot, never over an existing save | Not deployed (`savegame`): a save next to the .exe is never read |
| Framework mod | NexusTools `modconfig.json` (`minTntVersion`) | Unknown: NexusTools doesn't document a mods folder, so nothing is guessed | Not deployed (`needs_framework`); add it in NexusTools' own manager |
| ReShade preset | `.ini` with `Techniques=` and `[*.fx]` sections | Next to the game's .exe | Deployed, warning `needs_reshade` when no ReShade proxy DLL / `ReShade.ini` is there |

A package is only treated as one of these when its contents say so (installer signatures, file structure, manifest
keys), not by its name alone; an ordinary `.exe` (a trainer, a tool) is left to the game's rules.

## Integration contract

`GameIntegration` (`integrations/types.ts`). Integrations are plain Node; anything that needs Electron or the network
comes in through `IntegrationEnv`, so every integration can run against fake game folders in tests.

| Member | Required | Purpose |
| --- | --- | --- |
| `id`, `revision` | yes | Raising `revision` re-lays-out mods classified by older rules |
| `matches(game, env)` | yes | Does this integration handle the game (first match wins, `registry.ts`, most specific first) |
| `inspect(game, env, state, mods)` | yes | Edition/distribution, version, deploy targets (`game`, `saves`, `documents`, …), loader status, problems |
| `classify(pkg, game, info, env)` | yes | Routes for the package's files, skipped files with reasons, checks, needed loaders |
| `loaders` | yes (may be empty) | `LoaderAdapter`s: `status`, `install` from the official channel, optional `remove` |
| `loadVerifiable` | yes | `true` only if `verify` really checks that the game will load the files |
| `configure` | no | Loader lists / config after deployment and after a rollback |
| `verify` | no | Post-deployment checks (`VerifyCheck[]`) |
| `launch`, `shortcut` | no | Start with / without mods |
| `checkLaunch` | no | Read the loader's log after a start (`LaunchCheck`, with per-file results where the log has them) |
| `saveRoutes` | no | Where save files go inside the `saves` target; must never overwrite an existing save |
| `diagnose` | no | Game-specific diagnostic findings; read-only |

**Capabilities are read off the integration** (`capabilitiesOf`), not declared separately, so an integration can't
claim more than it implements. The Diagnose tab and the exported report show them per game.

### Supported games and what each can confirm

| Integration | Matches | Loaders | Load verified | Runtime evidence (log) | Per-mod evidence | Saves | Own diagnostics |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Terraria | Terraria | tModLoader (Steam, or GitHub zip when its InstallVerifier accepts the copy) | yes (`enabled.json`) | `tModLoader-Logs/client.log` | by file name where the log lists it | no | no |
| Casualties: Unknown, Valheim, Lethal Company, Risk of Rain 2 | known BepInEx games | BepInEx | yes | `BepInEx/LogOutput.log` | yes: plugin name + version | no | no |
| GTA V | `GTA5.exe` | Script Hook V (dev-c.com, only for a supported patch), Script Hook V .NET (stable, or the official nightly when a script needs a newer API) | no | `ScriptHookV.log`, `ScriptHookVDotNet.log` | yes: per script file, with the API version a script needs | yes (Rockstar profile, RUNE Social Club emulator) | yes |
| Cyberpunk 2077 | Cyberpunk2077.exe | CET, RED4ext, redscript, ArchiveXL, TweakXL, Codeware | no | CET and redscript logs | by file name where the log lists it | no | no |
| Any Unity game | Unity data folder | BepInEx 5/6, MelonLoader | yes | `BepInEx/LogOutput.log`, `MelonLoader/Latest.log` | BepInEx: plugin name + version | no | no |
| Any Unreal game | Unreal layout | UE4SS | no | `UE4SS.log` | by file name where the log lists it | no | no |
| Generic | everything else | none | no | none: the Diagnose tab says loading can't be confirmed (`NF-RUN-003`) | none | no | no |

Every integration gets file verification and clean removal from the shared engine.

## Diagnostic codes

Findings have a code, category, severity, confidence (`confirmed` = the evidence shows it, `likely`, `possible`),
evidence (paths, log lines, recorded state), optional fixes and, when only the user can resolve it, `userAction`.
`runDiagnostics` changes nothing. Fixes are a fixed set (`deploy`, `install-loader`, `relayout`, `set-deploy-dir`,
`run-installer`, `remove-mod`); each consequential one asks first, and the checks run again afterwards.

| Code | Category | Meaning | Fix |
| --- | --- | --- | --- |
| NF-INS-001 | installation | Game folder missing | user: point the game at its folder |
| NF-INS-002 | installation | Game executable missing | user: pick it again |
| NF-INS-003 | installation | Installation incomplete (integration's `problems`) | — |
| NF-INS-004 | installation | Repack wrapper folder: the game is one folder deeper than the deploy folder | set the deploy folder |
| NF-DEP-001 | deployment | A deployment was cut off (journal present) | deploy (undoes it first) |
| NF-DEP-002 | deployment | Last deployment failed / was rolled back, with the engine's error class | deploy |
| NF-DEP-003 | deployment | The game doesn't have the current mod setup | deploy |
| NF-DEP-004 | deployment | Deployed files missing or changed on disk | deploy |
| NF-DEP-005 | state | A listed mod's files are gone from storage | remove from the list |
| NF-PKG-001 | package | A package that is not deployed (installer, framework mod, unplaceable save, …) | run installer (setup programs); check the package again (saves, once the save folder is known) |
| NF-PKG-002 | package | A package that needs something only the user can do (ReShade), or may not work as expected | user |
| NF-LDR-001 | loader | A loader enabled mods need is missing or incomplete | install loader |
| NF-LDR-002 | loader | A needed loader can't be installed here (with the reason) | — |
| NF-LDR-003 | loader | A loader update exists; an error when the last start showed a mod needs it | update loader |
| NF-CFG-001 | configuration | One of the integration's post-deployment checks failed | deploy |
| NF-RUN-001 | runtime | A mod failed to load at the last start (log lines, what it needs) | install loader, when a newer one fixes it |
| NF-RUN-002 | runtime | The loader logged errors NexusForge can't tie to one mod | — |
| NF-RUN-003 | runtime | This game has no log that says which mods loaded | — |
| NF-RUN-004 | runtime | No start with mods seen yet | — |
| NF-RUN-005 | runtime | The last start was before the last deployment | — |
| NF-INT-001 | state | The integration's own diagnostics threw | — |
| NF-GTA-001 | installation | GTA V: save folder of this copy not found | — |
| NF-GTA-002 | deployment | GTA V: a save game sits in the game folder (never read there) | deploy (moves it into a free slot) |

Deploy-engine error classes (`problem.code` in the last deployment): `game_running`, `locked`, `not_writable`,
`path_too_long`, `disk_full`, `unsafe_path`, `source_missing`, `target_missing`, `verify_failed`, `check_failed`,
`cancelled`, `error`.

**Export**: *Export report* writes Markdown (default: Downloads). The user folder becomes `%USERPROFILE%`, the user
name `<user>`, e-mail addresses and long mixed-case tokens are removed (`diagnostics/report.ts`).

## Adding a game

1. Create `src/main/integrations/<game>.ts` exporting a `GameIntegration`. Reuse `common.ts` (`unwrap`, `under`,
   `skipDocs`), `zip-loader.ts` for loaders shipped as official zips, and `proxy.ts` before placing any proxy DLL.
2. `matches`: recognize the game by its files, not by its folder name alone.
3. `inspect`: report every deploy target the game reads from (`game`, `saves`, `documents`, …); mark user-data
   targets (`userData: true`) so they are copied, never linked. Put real install problems into `problems`.
4. `classify`: route what you know, skip what doesn't belong with a reason, and return a check (with `userAction`)
   instead of guessing when a package is ambiguous. Don't re-implement the shared strategies.
5. Only set `loadVerifiable: true` if `verify` checks that the game will load the files. Add `checkLaunch` only for a
   log the game or loader really writes; return per-file results (`files`) when the log names files.
6. Loaders: official channel only, SHA-256 when the publisher states one, `allowedHosts` limited to that channel. Never
   patch ownership, DRM or anti-cheat checks.
7. Register it in `registry.ts` above the engine-wide integrations it is more specific than.
8. Tests: a fake game folder in `tests/` covering detection, classification of representative packages, rejection of
   unsupported ones, and deploy + purge through the engine. If there is a log, a test with real log lines.

## Tests and what they prove

| Layer | Command | Proves | Does not prove |
| --- | --- | --- | --- |
| Unit + integration | `npm test` | Classification, routes, save slots, log parsing, runtime mapping, deploy/rollback/purge in temporary folders, diagnostics on fake games, redaction | That any game loads a mod |
| UI end-to-end | `npm run build && npm run smoke` | The built app's pages, deploy into a fake game under `.smoke/` | Real games |
| Live, read-only | `npx vitest run --config scripts/live/vitest.live.config.ts scripts/live/reliability.live.ts` | Real logs and save folders on this PC are read as the unit tests assume; real packages in storage classify as expected; the official SHVDN nightly downloads with a matching SHA-256 and lays out right (stand-in folder) | That the game then loads the mods |
| Diagnose probe | `npm run build && node scripts/probe-diagnostics.mjs` | Diagnose against a copy of the real data file and manifests (game folders only read), reports + screenshots in `.smoke/diagnostics` | Repairs (none are run) |
| Real runtime | start the real game, then Diagnose | Whether the loader loaded each mod (per-mod evidence where the log has it) | — |

### Runtime checks that need a real game

- **GTA V + Zombies V**: Diagnose › *Update to 3.7.0-nightly.N* (Script Hook V .NET), start GTA V to story mode,
  quit, Diagnose again. Expected: Zombies V "loaded in game"; if not, the failure line from `ScriptHookVDotNet.log`.
- **GTA V 100 % save**: *Deploy again* moves `SGTA50015` out of the game folder into a free slot of the RUNE save
  folder; load it from the game's Load Game menu.
- **BepInEx games**: start the game once; per-plugin "loaded" comes from `BepInEx/LogOutput.log`.
- **Terraria / tModLoader, Unity (MelonLoader), Unreal (UE4SS), Cyberpunk**: start the game; their logs give game-level
  evidence and per-mod evidence only where the log names files.
- **Generic games (WATCH_DOGS, Sky, …)**: no runtime evidence exists; check in the game.

## Known limits

- No general version-constraint solver: compatibility is checked where a source of truth exists (Script Hook V vs the
  GTA5.exe patch, tModLoader's InstallVerifier, BepInEx 5 vs 6 from the mod's references, the API version a script
  asks for in the SHVDN log, Cyberpunk mods' required frameworks). Elsewhere compatibility is *unknown*, not "ok".
- Mod-to-mod requirements come from the sources (Nexus, Thunderstore, mod.io, …) and are installed first; mods from
  other places have no dependency data.
- NexusTools (WATCH_DOGS) and other closed mod managers: their mods are recognized but not deployed.
- Runtime evidence is only as good as the loader's log; games without one stay "unknown".
- The SHVDN nightly is a pre-release by the project's own build bot; it is only offered when a script's log line asks
  for a newer API than the stable release has.
