// Tests play-session tracking for games started through a launcher that exits right away: a fake game folder
// with Launcher.exe (a copy of cmd.exe that starts Game.exe and quits) and Game.exe (a copy of ping.exe that
// runs ~45 s). Expected: "running" stays on after the launcher exits and ends after the game; play time is counted.
//   NODE_OPTIONS=--require scripts/tracker-probe.cjs  NEXUSFORGE_USER_DATA=<fresh dir>  electron .
const { copyFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

async function probe() {
  await wait(4000)
  const dir = join(process.cwd(), '.smoke', 'tracker', 'games', 'Launcher Game')
  mkdirSync(dir, { recursive: true })
  const sys = join(process.env.SystemRoot, 'System32')
  copyFileSync(join(sys, 'cmd.exe'), join(dir, 'Launcher.exe'))
  copyFileSync(join(sys, 'PING.EXE'), join(dir, 'Game.exe'))
  const win = electron.BrowserWindow.getAllWindows()[0]
  const invoke = (...args) =>
    win.webContents.executeJavaScript(`window.nexus.invoke(${args.map((a) => JSON.stringify(a)).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`)
  const game = (await invoke('library:addManual', { name: 'Launcher Game', path: join(dir, 'Launcher.exe') })).r
  await invoke('library:update', game.id, { launchArgs: `/c start "" "${join(dir, 'Game.exe')}" -n 46 127.0.0.1` })
  const t0 = Date.now()
  const launched = await invoke('library:launch', game.id)
  const timeline = []
  let endedAt
  for (let i = 0; i < 60; i++) {
    await wait(2000)
    const running = (await invoke('library:running')).r.includes(game.id)
    const s = Math.round((Date.now() - t0) / 1000)
    if (!timeline.length || timeline[timeline.length - 1].running !== running) timeline.push({ s, running })
    if (!running && s > 10) {
      endedAt = s
      break
    }
  }
  const after = (await invoke('library:list')).r.find((g) => g.id === game.id)
  finish({ launched: launched.ok ? 'ok' : launched.error, timeline, endedAt, playtimeMinutes: after.playtimeMinutes, lastPlayed: Boolean(after.lastPlayed) })
}

function finish(result) {
  console.log('[tracker-probe] ' + JSON.stringify(result))
  electron.app.exit(0)
}
