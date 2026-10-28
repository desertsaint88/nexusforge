import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gameNameVariants, nameScore, toPlainText } from '../src/main/sources/http'
import { parseDependency } from '../src/main/sources/thunderstore'
import { parseRows } from '../src/main/sources/moddb'
import { workshopBrowseIds } from '../src/main/sources/steamworkshop'
import { nexusListing, parseNxm } from '../src/main/sources/nexus'
import { placeInOrder } from '../src/main/mods/order'
import { missingRequirements, supportsVersion } from '../src/shared/deps'
import { extractGma, addonSlug } from '../src/main/steam/gma'
import { isEngineBuildString, readExeVersion } from '../src/main/library/exe-version'
import type { InstalledMod } from '../src/shared/types'

describe('game name matching', () => {
  it('drops demo/edition noise and tries shorter names', () => {
    expect(gameNameVariants('Casualties: Unknown Demo')).toEqual(['Casualties: Unknown Demo', 'Casualties: Unknown', 'Casualties'])
    expect(nameScore('Casualties: Unknown Demo', 'Casualties: Unknown')).toBe(1)
    expect(nameScore('Skyrim Special Edition', 'Skyrim (Switch)')).toBeLessThan(nameScore('Skyrim Special Edition', 'Skyrim Special Edition'))
    expect(nameScore('Valheim', 'Lethal Company')).toBe(0)
  })

  it('turns BBCode and HTML into plain text', () => {
    expect(toPlainText('[center][img]https://x/y.png[/img][/center]\n<br />[b]Hi[/b] &amp; [url=https://a]link[/url]')).toBe('Hi & link')
  })
})

describe('source parsers', () => {
  it('parses Thunderstore dependency strings', () => {
    expect(parseDependency('denikson-BepInExPack_Valheim-5.4.2202')).toMatchObject({
      sourceId: 'thunderstore',
      modId: 'denikson/BepInExPack_Valheim',
      versionId: '5.4.2202',
      required: true,
      installable: true
    })
  })

  it('parses nxm links', () => {
    expect(parseNxm('nxm://skyrimspecialedition/mods/12604/files/35407?key=abc&expires=123&user_id=9')).toEqual({
      domain: 'skyrimspecialedition',
      modId: '12604',
      fileId: '35407',
      key: 'abc',
      expires: '123'
    })
  })

  it('parses ModDB list rows', () => {
    const html = `<div class="row rowcontent rowreleased1 clear">
				<a href="/mods/minerva-reimagined" title="MINERVA: REIMAGINED" class="image"><img src="https://media.moddb.com/x.png" alt=""></a>
				<div class="content">
			<h4><a href="/mods/minerva-reimagined">MINERVA: REIMAGINED</a></h4>
			<span class="date"><time datetime="2022-05-20T17:37:51+00:00">May 20 2022</time></span>
			<span class="subheading"><time datetime="2021-03-09">Released 2021</time> First Person Shooter</span>
			<p>New life &amp; style for an old mod.</p>		</div>
	</div>`
    const rows = parseRows(html, /^\/mods\/[^/]+$/)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: '/mods/minerva-reimagined', title: 'MINERVA: REIMAGINED', image: 'https://media.moddb.com/x.png', summary: 'New life & style for an old mod.' })
  })
})

describe('Nexus mod lists', () => {
  // What nexusmods.com sent for garrysmod on 2026-10-25 12:10 (Unix 1792926493): adult content hidden,
  // "Trending mods" = endorsements of mods published since the hour 7 days ago, "Popular mods" = downloads, 28 days.
  const now = 1792926493_000
  it('asks for the same list as the website', () => {
    expect(nexusListing('garrysmod', '', 'endorsed', now)).toEqual({
      f: { gameDomainName: [{ value: 'garrysmod', op: 'EQUALS' }], adultContent: [{ value: false, op: 'EQUALS' }] },
      s: [{ endorsements: { direction: 'DESC' } }]
    })
    expect(nexusListing('garrysmod', '', 'trending', now).f.createdAt).toEqual([{ value: String(1792926000 - 7 * 86400), op: 'GTE' }])
    expect(nexusListing('garrysmod', '', 'downloads_recent', now)).toMatchObject({ f: { createdAt: [{ value: String(1792926000 - 28 * 86400), op: 'GTE' }] }, s: [{ downloads: { direction: 'DESC' } }] })
    expect(nexusListing('garrysmod', '', 'newest', now).s).toEqual([{ createdAt: { direction: 'DESC' } }])
    expect(nexusListing('garrysmod', '', 'updated', now).s).toEqual([{ updatedAt: { direction: 'DESC' } }])
    expect(nexusListing('garrysmod', 'car', 'relevance', now)).toMatchObject({ f: { name: [{ value: 'car', op: 'WILDCARD' }] }, s: [{ relevance: { direction: 'DESC' } }] })
  })
})

describe('Steam Workshop browse page', () => {
  it('lists the result items only, in page order', () => {
    // Shape of the page's embedded data (2026-10-25): the upload guide link and a description linking another item
    // come before or between the results and must not count.
    const html =
      '{\\"instructionsURL\\":\\"https://steamcommunity.com/sharedfiles/filedetails/?id=1838376273\\"}' +
      '{\\"total_count\\":796383,\\"results\\":[{\\"publishedfileid\\":\\"2312356877\\",\\"creator\\":\\"1\\",\\"title\\":\\"A\\"},' +
      '{\\"publishedfileid\\":\\"2385213638\\",\\"creator\\":\\"2\\",\\"short_description\\":\\"New Version : https://steamcommunity.com/sharedfiles/filedetails/?id=2390800738\\",' +
      '\\"children\\":[{\\"publishedfileid\\":\\"111111111\\",\\"sortorder\\":0}]},' +
      '{\\"publishedfileid\\":\\"2987467480\\",\\"creator\\":\\"3\\"}]}'
    expect(workshopBrowseIds(html)).toEqual(['2312356877', '2385213638', '2987467480'])
  })
})

describe('dependency ordering', () => {
  const mod = (id: string, source: string, requires: string[] = []): InstalledMod => ({
    id,
    gameId: 'g',
    name: id,
    source: { sourceId: 'ts', modId: source },
    requires: requires.map((r) => ({ sourceId: 'ts', modId: r })),
    stagingDir: '',
    rootPath: '',
    installedAt: 0,
    updatedAt: 0,
    sizeBytes: 0,
    fileCount: 0
  })

  it('puts a mod after what it needs and before what needs it', () => {
    const mods = { a: mod('a', 'A'), b: mod('b', 'B', ['LIB']), lib: mod('lib', 'LIB'), x: mod('x', 'X', ['B']) }
    expect(placeInOrder(['a', 'b', 'x', 'lib'], 'lib', mods)).toEqual(['a', 'lib', 'b', 'x'])
    expect(placeInOrder(['lib', 'a', 'x', 'b'], 'b', mods)).toEqual(['lib', 'a', 'b', 'x'])
    expect(placeInOrder(['a', 'z'], 'z', { a: mod('a', 'A') })).toEqual(['a', 'z'])
  })

  it('reports missing and disabled requirements', () => {
    const lib = mod('lib', 'LIB')
    const user = mod('user', 'U', ['LIB', 'GONE'])
    const r = missingRequirements(user, [lib, user], new Set(['user']))
    expect(r.map((x) => [x.ref.modId, x.disabled])).toEqual([
      ['LIB', true],
      ['GONE', false]
    ])
  })

  it('matches game versions loosely', () => {
    expect(supportsVersion(['1.6'], '1.6.1170')).toBe(true)
    expect(supportsVersion(['1.20.1', '1.20.2'], '1.20.2')).toBe(true)
    expect(supportsVersion(['1.5.97'], '1.6.1170')).toBe(false)
    expect(supportsVersion(undefined, '1.0')).toBeUndefined()
  })
})

describe('Garry\'s Mod GMA', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-gma-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('extracts files and rejects path escapes', async () => {
    const files = [
      ['lua/autorun/hello.lua', 'print("hi")'],
      ['materials/x.vmt', 'VertexLitGeneric']
    ] as const
    const parts: Buffer[] = [Buffer.from('GMAD'), Buffer.from([3]), Buffer.alloc(16), Buffer.from('\0'), Buffer.from('My Addon\0desc\0author\0'), Buffer.alloc(4)]
    files.forEach(([p, c], i) => {
      const n = Buffer.alloc(4)
      n.writeUInt32LE(i + 1)
      const size = Buffer.alloc(8)
      size.writeBigInt64LE(BigInt(Buffer.byteLength(c)))
      parts.push(n, Buffer.from(`${p}\0`), size, Buffer.alloc(4))
    })
    parts.push(Buffer.alloc(4))
    for (const [, c] of files) parts.push(Buffer.from(c))
    const gma = join(dir, 'a.gma')
    await fsp.writeFile(gma, Buffer.concat(parts))
    const info = await extractGma(gma, join(dir, 'out'))
    expect(info.name).toBe('My Addon')
    expect(await fsp.readFile(join(dir, 'out', 'lua', 'autorun', 'hello.lua'), 'utf8')).toBe('print("hi")')
    expect(addonSlug('[VJ] Dinosaurs SNPCs!', '1')).toBe('vj_dinosaurs_snpcs')
  })
})

describe('exe version', () => {
  it('reads the version resource of a Windows executable', async () => {
    const v = await readExeVersion('C:\\Windows\\System32\\notepad.exe')
    expect(v).toMatch(/^\d+\.\d+/)
  })

  it('treats engine and SDK build strings as no game version', () => {
    expect(isEngineBuildString('++EOSSDK+Release-1.19.0.3')).toBe(true)
    expect(isEngineBuildString('++UE5+Release-5.5-CL-0')).toBe(true)
    expect(isEngineBuildString('1.0.3889.0')).toBe(false)
    expect(isEngineBuildString('2.31')).toBe(false)
  })
})
