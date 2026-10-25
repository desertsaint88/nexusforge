import { describe, expect, it } from 'vitest'
import { newerVersion } from '../src/main/mods/update-match'
import { storeQueries } from '../src/main/library/names'
import type { ModVersion } from '../src/shared/types'

const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString()
const installed = (versionId: string, version?: string, updatedAt = Date.UTC(2026, 9, 10)) => ({ version, updatedAt, source: { sourceId: 'x', modId: 'm', versionId } })

describe('mod update check', () => {
  // Nexus: main files, optional files and "old versions", newest main first.
  const nexus: ModVersion[] = [
    { id: '30', name: 'Main file', version: '1.3', date: day(20), primary: true, channel: 'MAIN' },
    { id: '31', name: '4K textures', version: '1.3', date: day(20), primary: false, channel: 'OPTIONAL' },
    { id: '20', name: 'Main file', version: '1.2', date: day(5), primary: false, superseded: true },
    { id: '21', name: '4K textures', version: '1.2', date: day(5), primary: false, channel: 'OPTIONAL' }
  ]

  it('offers the newest main file when the installed one moved to old versions', () => {
    expect(newerVersion(installed('20', '1.2'), nexus)?.id).toBe('30')
  })

  it('updates an optional file only with a newer upload of that optional file', () => {
    expect(newerVersion(installed('21', '1.2'), nexus)?.id).toBe('31')
  })

  it('reports nothing when the installed file is the newest', () => {
    expect(newerVersion(installed('30', '1.3'), nexus)).toBeUndefined()
    expect(newerVersion(installed('31', '1.3'), nexus)).toBeUndefined()
  })

  it('stays with the installed variant when a mod has several main files', () => {
    const variants: ModVersion[] = [
      { id: '41', name: 'Main 1080p', version: '2.0', date: day(21), primary: true, channel: 'MAIN' },
      { id: '40', name: 'Main 4K', version: '1.0', date: day(2), primary: true, channel: 'MAIN' }
    ]
    expect(newerVersion(installed('40', '1.0'), variants)).toBeUndefined()
  })

  it('never offers an older file and ignores the same version number', () => {
    const list: ModVersion[] = [
      { id: 'b', name: 'B', version: '1.0', date: day(1), primary: true },
      { id: 'a', name: 'A', version: '1.1', date: day(9), primary: false }
    ]
    // Order says b is "primary", but it is older than what is installed.
    expect(newerVersion(installed('a', '1.1'), list)).toBeUndefined()
    expect(newerVersion(installed('gone', '1.0'), list)).toBeUndefined()
  })

  it('handles sources that list the newest file first (Thunderstore, Modrinth, mod.io)', () => {
    const ts: ModVersion[] = [
      { id: '2.1.0', name: 'Pkg 2.1.0', version: '2.1.0', date: day(15), primary: true },
      { id: '2.0.0', name: 'Pkg 2.0.0', version: '2.0.0', date: day(3) }
    ]
    expect(newerVersion(installed('2.0.0', '2.0.0'), ts)?.id).toBe('2.1.0')
    expect(newerVersion(installed('2.1.0', '2.1.0'), ts)).toBeUndefined()
  })

  it('sees a changed Steam Workshop item by its update time', () => {
    const ws: ModVersion[] = [{ id: 'latest', name: 'Item', date: day(12), primary: true }]
    expect(newerVersion(installed('latest', undefined, Date.UTC(2026, 9, 10)), ws)?.id).toBe('latest')
    expect(newerVersion(installed('latest', undefined, Date.UTC(2026, 9, 14)), ws)).toBeUndefined()
  })
})

describe('store name queries', () => {
  it('also searches executable-style names spaced out', () => {
    expect(storeQueries('Cyberpunk2077')).toContain('Cyberpunk 2077')
    expect(storeQueries('WatchDogs2')).toContain('Watch Dogs 2')
    expect(storeQueries('Garry\'s Mod')[0]).toBe("Garry's Mod")
  })
})
