// Known modding layouts. `target` is relative to the game's install folder.

export interface ModPreset {
  target: string
  /** Keep a mod archive's single top-level folder (games where every mod lives in its own folder). */
  keepWrapper?: boolean
  sources?: Record<string, string>
}

interface PresetEntry extends ModPreset {
  steam?: string[]
  names: string[]
}

const PRESETS: PresetEntry[] = [
  { steam: ['489830'], names: ['skyrim special edition', 'skyrim anniversary edition'], target: 'Data', sources: { nexus: 'skyrimspecialedition' } },
  { steam: ['72850'], names: ['the elder scrolls v skyrim'], target: 'Data', sources: { nexus: 'skyrim' } },
  { steam: ['377160'], names: ['fallout 4'], target: 'Data', sources: { nexus: 'fallout4' } },
  { steam: ['22380'], names: ['fallout new vegas'], target: 'Data', sources: { nexus: 'newvegas' } },
  { steam: ['22330'], names: ['the elder scrolls iv oblivion'], target: 'Data', sources: { nexus: 'oblivion' } },
  { steam: ['1716740'], names: ['starfield'], target: 'Data', sources: { nexus: 'starfield' } },
  { steam: ['1091500'], names: ['cyberpunk 2077'], target: '', sources: { nexus: 'cyberpunk2077' } },
  { steam: ['413150'], names: ['stardew valley'], target: 'Mods', keepWrapper: true, sources: { nexus: 'stardewvalley' } },
  { steam: ['1086940'], names: ["baldur's gate 3"], target: '', sources: { nexus: 'baldursgate3' } },
  { steam: ['892970'], names: ['valheim'], target: '', sources: { thunderstore: 'valheim', nexus: 'valheim' } },
  { steam: ['1966720'], names: ['lethal company'], target: '', sources: { thunderstore: 'lethal-company', nexus: 'lethalcompany' } },
  { steam: ['632360'], names: ['risk of rain 2'], target: '', sources: { thunderstore: 'ror2', nexus: 'riskofrain2' } },
  { steam: ['4000'], names: ["garry's mod", 'garrysmod'], target: 'garrysmod/addons', keepWrapper: true, sources: { nexus: 'garrysmod' } },
  { steam: ['1118200'], names: ['people playground'], target: 'Mods', keepWrapper: true },
  { steam: ['294100'], names: ['rimworld'], target: 'Mods', keepWrapper: true, sources: { nexus: 'rimworld' } },
  { steam: ['271590'], names: ['grand theft auto v', 'gta v', 'gta 5', 'grand theft auto v legacy', 'grand theft auto v enhanced'], target: '', sources: { nexus: 'gta5' } },
  { steam: ['1174180'], names: ['red dead redemption 2'], target: '', sources: { nexus: 'reddeadredemption2' } },
  { steam: ['292030'], names: ['the witcher 3 wild hunt', 'the witcher 3'], target: '', sources: { nexus: 'witcher3' } },
  { steam: ['1245620'], names: ['elden ring'], target: '', sources: { nexus: 'eldenring' } },
  { steam: ['2050650'], names: ['resident evil 4'], target: '', sources: { nexus: 'residentevil42023' } },
  { steam: ['1623730'], names: ['palworld'], target: '', sources: { thunderstore: 'palworld', nexus: 'palworld' } },
  { steam: ['243470'], names: ['watch dogs', 'watch_dogs'], target: '', sources: { nexus: 'watchdogs' } },
  { steam: ['447040'], names: ['watch dogs 2', 'watch_dogs 2'], target: '', sources: { nexus: 'watchdogs2' } },
  { steam: ['1426210'], names: ['it takes two'], target: '' },
  { steam: ['105600'], names: ['terraria'], target: '', sources: { nexus: 'terraria' } },
  { steam: ['548430'], names: ['deep rock galactic'], target: 'FSD/Mods', keepWrapper: true, sources: { thunderstore: 'deep-rock-galactic' } }
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function findPreset(game: { platform: string; platformId?: string; name: string }): ModPreset | undefined {
  if (game.platform === 'steam' && game.platformId) {
    const hit = PRESETS.find((p) => p.steam?.includes(game.platformId!))
    if (hit) return hit
  }
  const n = norm(game.name)
  return PRESETS.find((p) => p.names.some((x) => norm(x) === n))
}
