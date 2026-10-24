import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { libretroBoxart, romTitle, scanEmulatorGames, EMULATORS } from '../src/main/library/emulators'
import { findPreset, presetTarget } from '../src/main/library/presets'
import { parseResourceList, parseResourcePage, parseSearchResults } from '../src/main/sources/beamng'

describe('console games', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-roms-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  // Sparse files: big enough to count as disc images without writing the bytes.
  const image = async (rel: string, mb = 20) => {
    await fsp.mkdir(join(dir, rel, '..'), { recursive: true })
    const h = await fsp.open(join(dir, rel), 'w')
    await h.truncate(mb * 1024 * 1024)
    await h.close()
  }

  it('names games after the disc image, without region and language tags', () => {
    expect(romTitle('Jak II - Renegade (Europe, Australia) (En,Ja,Fr,De,Es,It,Ko).iso')).toBe('Jak II - Renegade')
    expect(romTitle('Gran_Turismo_4 [SCES-51719].chd')).toBe('Gran Turismo 4')
  })

  it('finds disc images in system folders and starts them with the installed emulator', async () => {
    await image('PS2/Jak II - Renegade (Europe, Australia) (En,Ja,Fr,De,Es,It,Ko).iso')
    await image('PS2/tiny.iso', 1) // too small to be a disc
    await image('Some PC Game/Game.exe', 1)
    await image('Some PC Game/disc.iso') // a PC game's own image, not a console game
    const pcsx2 = 'C:\\Program Files\\PCSX2\\pcsx2-qt.exe'
    const games = await scanEmulatorGames([{ dir: join(dir, 'PS2') }, { dir: join(dir, 'Some PC Game') }], new Map([['pcsx2', pcsx2]]))
    expect(games.map((g) => g.name)).toEqual(['Jak II - Renegade (PS2)'])
    const g = games[0]
    expect(g.emulator).toBe('PCSX2')
    expect(g.launch).toEqual({ kind: 'exe', exe: pcsx2, args: ['-batch', '--', join(dir, 'PS2', 'Jak II - Renegade (Europe, Australia) (En,Ja,Fr,De,Es,It,Ko).iso')], cwd: 'C:\\Program Files\\PCSX2' })
    expect(g.art.capsule[0]).toBe(
      'https://thumbnails.libretro.com/Sony%20-%20PlayStation%202/Named_Boxarts/Jak%20II%20-%20Renegade%20(Europe%2C%20Australia)%20(En%2CJa%2CFr%2CDe%2CEs%2CIt%2CKo).png'
    )
  })

  it('skips images when no installed emulator reads them', async () => {
    await image('GameCube/Zelda.rvz')
    expect(await scanEmulatorGames([{ dir }], new Map([['pcsx2', 'x.exe']]))).toEqual([])
  })

  it('builds libretro box art names like the thumbnail repository', () => {
    const ps2 = EMULATORS.find((e) => e.id === 'pcsx2')!
    expect(libretroBoxart(ps2, 'C:\\Games\\PS2\\Ratchet & Clank (USA).iso')).toContain('Ratchet%20_%20Clank%20(USA).png')
  })
})

describe('BeamNG', () => {
  let install: string
  beforeEach(async () => {
    install = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-beamng-'))
  })
  afterEach(async () => {
    await fsp.rm(install, { recursive: true, force: true })
  })

  it('keeps mods packed and deploys them into the user folder', async () => {
    const preset = findPreset({ platform: 'custom', name: 'BeamNG.drive' })
    expect(preset?.keepArchive).toBe(true)
    expect(preset?.sources?.beamng).toBe('beamng')
    await fsp.writeFile(join(install, 'startup.ini'), '[filesystem]\n;UserPath = .\\\nUserPath =\n')
    expect(presetTarget(preset!.target, install)).toBe(join(process.env.LOCALAPPDATA!, 'BeamNG', 'BeamNG.drive', 'current', 'mods'))
    await fsp.writeFile(join(install, 'startup.ini'), '[filesystem]\nUserPath = D:\\BeamNG User\n')
    expect(presetTarget(preset!.target, install)).toBe(join('D:\\BeamNG User', 'current', 'mods'))
  })

  it('parses the repository list, search results and resource pages', () => {
    const list = `<ol class="resourceList"><li class="resourceListItem visible " id="resource-1362">
      <a href="resources/car-jump-arena.1362/" class="resourceIcon"><img src="data/resource_icons/1/1362.jpg?1473003845" alt="" /></a>
      <h3 class="title"><a
        href="resources/car-jump-arena.1362/">Car Jump Arena</a> <span class="version">Final Release</span></h3>
      <div class="resourceDetails muted"><a href="resources/authors/mysterymanger.159613/">MysteryManGER</a></div>
      <div class="tagLine">Jump! Flip! Speeding!</div>
      <span class="Hint">139 ratings</span>
      <dl class="resourceDownloads"><dt>Downloads:</dt> <dd>4,650,386</dd></dl>
      <dl class="resourceUpdated"><dt>Updated:</dt> <dd><a href="x" class="concealed"><span class="DateTime" title="Sep 7, 2026 at 12:59 PM">Sep 7, 2026</span></a></dd></dl>
    </li>
    </ol>`
    const [item] = parseResourceList(list)
    expect(item).toMatchObject({ id: 'car-jump-arena.1362', name: 'Car Jump Arena', author: 'MysteryManGER', downloads: 4650386, endorsements: 139, version: 'Final Release' })
    expect(item.thumbnail).toBe('https://www.beamng.com/data/resource_icons/1/1362.jpg')

    const search = `<li id="resource_update-67960" class="searchResult resourceUpdate primaryContent" data-author="Raceless">
      <h3 class="title"><a href="resources/rls-career-collection.36260/?update=67960">RLS: Added New Mods!</a></h3>
      <blockquote class="snippet"><a href="x">v4.9 Added <em class="highlight">Hirochi</em></a></blockquote>
      <div class="meta"><span class="DateTime" title="Mar 16, 2026 at 10:01 AM">Mar 16, 2026</span>
      in resource: <a href="resources/rls-career-collection.36260/">RLS Career Collection</a></div></li>
      <li id="resource_update-1" class="searchResult resourceUpdate primaryContent" data-author="A">
      <h3 class="title"><a href="resources/hirochi-mistral.23527/">Hirochi Mistral</a></h3></li>`
    expect(parseSearchResults(search).map((r) => [r.id, r.name, r.thumbnail])).toEqual([
      ['rls-career-collection.36260', 'RLS Career Collection', 'https://www.beamng.com/data/resource_icons/36/36260.jpg'],
      ['hirochi-mistral.23527', 'Hirochi Mistral', 'https://www.beamng.com/data/resource_icons/23/23527.jpg']
    ])

    const page = `<div class="resourceInfo"><ul class="primaryLinks "><li><label class="downloadButton ">
      <a href="resources/hirochi-mistral.23527/download?version=71581" class="inner" >Download Now <small class="minorText">163.9 MB .zip</small></a></label></li></ul>
      <div class="resourceImage"><img src="data/resource_icons/23/23527.jpg?1660562656" alt="" class="resourceIcon" /></div>
      <h1>Hirochi Mistral <span class="muted">1.2.2</span></h1><p class="tagLine muted">The Covet-fighter</p></div>
      <div class="tagBlock TagContainer"></div>
      <blockquote class="ugc baseHtml messageText"><img src="data/attachments/1294/1.jpg" alt="b" class="bbCodeImage LbImage" /><br />1995 - 2003 Hirochi Mistral</blockquote>`
    const d = parseResourcePage(page, 'hirochi-mistral.23527')
    expect(d).toMatchObject({ name: 'Hirochi Mistral', version: '1.2.2', summary: 'The Covet-fighter', images: ['https://www.beamng.com/data/attachments/1294/1.jpg'] })
    expect(d.versions).toEqual([{ id: '71581', name: 'Hirochi Mistral 1.2.2', version: '1.2.2', fileName: 'Hirochi Mistral.zip', sizeBytes: Math.round(163.9 * 1024 ** 2), primary: true }])
  })
})
