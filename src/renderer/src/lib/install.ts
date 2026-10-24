import type { ModSearchResult, ModSourceRef, ModVersion, ResolvedDependency } from '@shared/types'
import { invoke } from './api'
import { useApp } from '../store/app'
import { useDownloads } from '../store/downloads'
import { useLibrary } from '../store/library'
import { useMods } from '../store/mods'
import { toast, useDependencyDialog } from '../store/ui'
import { ensureSignedIn } from '../store/accounts'

export const installableMissing = (d: ResolvedDependency) => !d.installed && d.installable && Boolean(d.sourceId && d.modId)

/**
 * Downloads a mod into a game together with what it needs. Depending on Settings › Mods, missing
 * dependencies are installed automatically, skipped, or the user is asked first.
 * Returns false when the user cancelled.
 */
export async function installWithDependencies(mod: ModSearchResult, version: ModVersion, gameId: string | undefined, known?: ResolvedDependency[]): Promise<boolean> {
  const mode = useApp.getState().settings?.dependencyMode ?? 'ask'
  const game = useLibrary.getState().games.find((g) => g.id === gameId)
  let deps: ResolvedDependency[] = known ?? []
  if (!known && gameId) {
    try {
      deps = await invoke('sources:dependencies', mod.sourceId, mod.id, version.id, gameId)
    } catch (err) {
      toast.warning('Could not check dependencies', (err as Error).message)
    }
  }

  const missing = deps.filter(installableMissing)
  const disabled = deps.filter((d) => d.installed && d.disabled && d.required)
  const external = deps.filter((d) => d.required && !d.installable && !d.installed && d.sourceId === '')

  let choice = { install: [] as ResolvedDependency[], enableDisabled: false }
  if (gameId && (missing.length || disabled.length || external.length)) {
    if (mode === 'always') choice = { install: missing.filter((d) => d.required), enableDisabled: true }
    else if (mode === 'ask') {
      const answer = await useDependencyDialog.getState().ask(mod.name, game?.name ?? 'this game', deps)
      if (!answer) return false
      choice = answer
    }
  }

  // Downloads from Nexus, mod.io and CurseForge need the user's account there; sign in first (inside the app).
  const reason = `${mod.name} comes from a site that needs your (free) account for downloads.`
  if (!(await ensureSignedIn([mod.sourceId, ...choice.install.map((d) => d.sourceId)], reason))) return false

  const start = useDownloads.getState().start
  for (const dep of choice.install) {
    try {
      const versionId = dep.versionId ?? (await invoke('sources:latestVersion', dep.sourceId, dep.modId!, gameId))
      // Nested dependencies (a library of a library) are ordered before this one too.
      const nested = deps.filter((x) => x.requiredBy === dep.name && x.required && x.sourceId && x.modId).map((x) => ({ sourceId: x.sourceId, modId: x.modId!, name: x.name }))
      await start({ sourceId: dep.sourceId, modId: dep.modId!, versionId, gameId, name: dep.name.replace(/\s+\d+(\.\d+)+$/, ''), requires: nested })
    } catch (err) {
      toast.error(`Couldn't get ${dep.name}`, (err as Error).message)
    }
  }

  if (choice.enableDisabled && gameId) {
    const installed = (await invoke('mods:list', gameId)).filter((m) => disabled.some((d) => m.source?.sourceId === d.sourceId && m.source.modId === d.modId))
    if (!useMods.getState().byGame[gameId]) await useMods.getState().load(gameId)
    for (const m of installed) await useMods.getState().toggle(gameId, m.id, true)
  }

  const requires: ModSourceRef[] = deps.filter((d) => d.required && d.sourceId && d.modId && !d.requiredBy).map((d) => ({ sourceId: d.sourceId, modId: d.modId!, name: d.name }))
  const item = await start({
    sourceId: mod.sourceId,
    modId: mod.id,
    versionId: version.id,
    gameId,
    name: mod.name,
    version: version.version,
    author: mod.author,
    summary: mod.summary,
    thumbnail: mod.thumbnail,
    requires
  })
  return Boolean(item)
}
