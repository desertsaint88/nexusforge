import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Profile } from '@shared/types'
import { db } from '../store'
import { paths } from '../paths'
import { readJson, safeReaddir, shortId, writeJsonAtomic } from '../util/fs'

// Each profile is its own JSON file: <userData>/profiles/<game>/<profileId>.json

function file(gameId: string, profileId: string): string {
  return join(paths.profiles(gameId), `${profileId}.json`)
}

function modIds(gameId: string): string[] {
  const mods = Object.values(db().get('mods')[gameId] ?? {})
  return mods.sort((a, b) => a.installedAt - b.installedAt).map((m) => m.id)
}

/** Drops ids of removed mods and appends newly installed ones (disabled) so every profile lists every mod. */
export function normalizeProfile(p: Profile, ids: string[]): Profile {
  const known = new Set(ids)
  const order = p.order.filter((id, i) => known.has(id) && p.order.indexOf(id) === i)
  for (const id of ids) if (!order.includes(id)) order.push(id)
  const enabled = p.enabled.filter((id) => known.has(id))
  const fileOverrides: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.fileOverrides ?? {})) if (known.has(v)) fileOverrides[k] = v
  return { ...p, order, enabled: [...new Set(enabled)], fileOverrides }
}

export async function listProfiles(gameId: string): Promise<{ profiles: Profile[]; activeId: string }> {
  const ids = modIds(gameId)
  const profiles: Profile[] = []
  for (const e of await safeReaddir(paths.profiles(gameId))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const p = await readJson<Profile>(join(paths.profiles(gameId), e.name))
    if (p && p.id && Array.isArray(p.order)) profiles.push(normalizeProfile(p, ids))
  }
  if (!profiles.length) {
    const p: Profile = { id: shortId('p'), gameId, name: 'Default', order: ids, enabled: ids, fileOverrides: {}, createdAt: Date.now(), updatedAt: Date.now() }
    await writeJsonAtomic(file(gameId, p.id), p)
    profiles.push(p)
  }
  profiles.sort((a, b) => a.createdAt - b.createdAt)
  let activeId = db().get('activeProfiles')[gameId]
  if (!activeId || !profiles.some((p) => p.id === activeId)) {
    activeId = profiles[0].id
    setActiveId(gameId, activeId)
  }
  return { profiles, activeId }
}

function setActiveId(gameId: string, profileId: string): void {
  const map = db().get('activeProfiles')
  map[gameId] = profileId
  db().set('activeProfiles', map)
}

export async function activeProfile(gameId: string): Promise<Profile> {
  const { profiles, activeId } = await listProfiles(gameId)
  return profiles.find((p) => p.id === activeId)!
}

export async function saveProfile(p: Profile): Promise<Profile> {
  const normalized = normalizeProfile({ ...p, updatedAt: Date.now() }, modIds(p.gameId))
  await writeJsonAtomic(file(p.gameId, p.id), normalized)
  return normalized
}

export async function createProfile(gameId: string, name: string, cloneFrom?: string): Promise<Profile> {
  const { profiles } = await listProfiles(gameId)
  const base = cloneFrom ? profiles.find((p) => p.id === cloneFrom) : undefined
  const ids = modIds(gameId)
  const p: Profile = {
    id: shortId('p'),
    gameId,
    name: name.trim() || 'New profile',
    order: base ? [...base.order] : ids,
    enabled: base ? [...base.enabled] : [],
    fileOverrides: base ? { ...base.fileOverrides } : {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return saveProfile(p)
}

export async function renameProfile(gameId: string, profileId: string, name: string): Promise<Profile> {
  const { profiles } = await listProfiles(gameId)
  const p = profiles.find((x) => x.id === profileId)
  if (!p) throw new Error('Profile not found')
  return saveProfile({ ...p, name: name.trim() || p.name })
}

export async function deleteProfile(gameId: string, profileId: string): Promise<void> {
  const { profiles, activeId } = await listProfiles(gameId)
  if (profiles.length <= 1) throw new Error('A game needs at least one profile.')
  await fsp.rm(file(gameId, profileId), { force: true })
  if (activeId === profileId) setActiveId(gameId, profiles.find((p) => p.id !== profileId)!.id)
}

export async function setActiveProfile(gameId: string, profileId: string): Promise<void> {
  const { profiles } = await listProfiles(gameId)
  if (!profiles.some((p) => p.id === profileId)) throw new Error('Profile not found')
  setActiveId(gameId, profileId)
}

/** A freshly installed mod goes to the end of every profile and is enabled in the active one. */
export async function addModToProfiles(gameId: string, modId: string): Promise<void> {
  const { profiles, activeId } = await listProfiles(gameId)
  for (const p of profiles) {
    if (!p.order.includes(modId)) p.order.push(modId)
    if (p.id === activeId && !p.enabled.includes(modId)) p.enabled.push(modId)
    await saveProfile(p)
  }
}

export async function deleteAllProfiles(gameId: string): Promise<void> {
  await fsp.rm(paths.profiles(gameId), { recursive: true, force: true })
  const map = db().get('activeProfiles')
  delete map[gameId]
  db().set('activeProfiles', map)
}
