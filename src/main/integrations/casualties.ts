// Casualties: Unknown (Orsoniks; Steam 4576490, demo 4576510; started as the free "Scav Prototype").
//
// What its modding is, as found on 2026-10-26: a Unity 2022.3 Mono x64 game without official mod support;
// the community uses BepInEx 5 plugins (the 506 mods on Nexus Mods, game domain "scavprototype", are BepInEx
// plugin DLLs, often bundled with a copy of BepInEx in a "modloader" folder and a howtomod.txt that says to copy
// it into the game folder and the DLL into BepInEx/plugins). BepInEx 5.4.23.6 was confirmed to start in the demo
// (its LogOutput.log: "Running under Unity v2022.3.62", chainloader started). There is no Thunderstore community.

import { bepinexIntegration } from './bepinex'

export const casualtiesIntegration = bepinexIntegration({
  id: 'casualties-unknown',
  name: 'Casualties: Unknown',
  steam: ['4576490', '4576510'],
  names: [/^casualties\W*unknown/i, /^scav\W*prototype/i],
  exe: 'CasualtiesUnknown.exe',
  support: 'full',
  major: 5,
  capabilities: [
    'Installs BepInEx 5 (official GitHub release, Mono x64) the first time a mod needs it; works for the Steam game, the demo and copies outside Steam.',
    'Puts each plugin DLL into BepInEx/plugins/<mod>/. The copy of BepInEx that many mods bundle in a "modloader" folder, and their read-me files, stay out of the game.',
    'Checks after deploying that BepInEx is switched on and every plugin sits where BepInEx loads it; after you play, shows which plugins BepInEx loaded (LogOutput.log).',
    '"Play without mods" starts the game with BepInEx switched off for that one start.'
  ],
  limitations: [
    'Casualties: Unknown has no official mod support: plugins can break when the game updates. Check a mod\'s page for the game version it supports.',
    'Multiplayer mods (Casualties Together) need every player on the same mod versions.'
  ]
})
