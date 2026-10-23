// Renders resources/icon.svg to resources/icon.png (512x512) with Electron's offscreen renderer.
// Usage: npm run icon
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const svg = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  writeFileSync(join(root, 'resources', 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG())
  console.log('wrote resources/icon.png')
  app.quit()
})
