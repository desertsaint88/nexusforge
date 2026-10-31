// Renders every NexusForge brand image from one mark (scripts/brand-mark.mjs) with Electron's offscreen renderer,
// in the Grey Hat look: greys only on near-black, Bahnschrift in spaced capitals ("NEXUSFORGE / EST. 2026", like the
// DESERTSAINT lockup), a faint honeycomb where the hacker-group marks sit in the background it was made to match.
//   resources/icon.svg, icon.png (512)          app icon source and PNG
//   resources/icon.ico (16–256)                 app, installer and uninstaller icon; small sizes drawn for their size
//   resources/installerSidebar.bmp (164×314)    welcome / finish pages of the installer and uninstaller
//   resources/installerHeader.bmp (150×57)      header of the other installer pages
//   resources/brand/readme-banner.png           top of README.md
//   resources/brand/social-preview.png          GitHub social preview (1280×640)
// Usage: npm run brand
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BG, hexPath, INK, markSvg } from './brand-mark.mjs'

const root = join(import.meta.dirname, '..')
const res = join(root, 'resources')
const brand = join(res, 'brand')
mkdirSync(brand, { recursive: true })
const version = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8')).version

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// Every image is an absolutely placed box on one page; each is captured by its rectangle.
const items = []
let y = 0
const place = (name, w, h, html) => {
  items.push({ name, x: 0, y, w, h, html })
  y += h + 8
}

for (const s of ICO_SIZES) place(`ico-${s}`, s, s, markSvg({ size: s, id: `i${s}`, small: s <= 24 }))
place('png-512', 512, 512, markSvg({ size: 512, id: 'p512' }))

// Bahnschrift (Windows' DIN-style face, the one the Grey Hat marks and the DESERTSAINT lockup use) in spaced capitals.
const text = (t, size, weight, color, spacing = 0.2, extra = '') =>
  `<div style="font-family:Bahnschrift,'Segoe UI',sans-serif;font-size:${size}px;font-weight:${weight};line-height:1.15;color:${color};letter-spacing:${spacing}em;margin-right:-${spacing}em;${extra}">${t}</div>`

/** A faint honeycomb: the hexagon of the mark repeated, the way the group marks sit in the background. */
function honeycomb(w, h, r, color, id, fade) {
  const dx = r * Math.sqrt(3)
  const cells = []
  for (let row = -1; row * r * 1.5 < h + r * 2; row++) {
    for (let col = -1; col * dx < w + dx; col++) {
      const x = col * dx + (row % 2 ? dx / 2 : 0)
      const y = row * r * 1.5
      cells.push(`<path transform="translate(${(x - 32 * (r / 32)).toFixed(1)} ${(y - 32 * (r / 32)).toFixed(1)}) scale(${(r / 32).toFixed(4)})" d="${hexPath(32)}"/>`)
    }
  }
  return `<svg width="${w}" height="${h}" style="position:absolute;inset:0" viewBox="0 0 ${w} ${h}">
    <defs><radialGradient id="${id}-f" ${fade}><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <mask id="${id}-m"><rect width="${w}" height="${h}" fill="url(#${id}-f)"/></mask></defs>
    <g mask="url(#${id}-m)" fill="none" stroke="${color}" stroke-width="${(32 / r).toFixed(3)}" vector-effect="non-scaling-stroke">${cells.join('')}</g>
  </svg>`
}

const panel = (w, h, inner) => `<div style="position:absolute;inset:0;background:${BG};overflow:hidden">${inner}</div>`

place(
  'sidebar',
  164,
  314,
  panel(
    164,
    314,
    `${honeycomb(164, 314, 22, '#1d1d1d', 'sbh', 'cx="0.5" cy="1" r="0.9"')}
    <div style="position:absolute;left:44px;top:56px">${markSvg({ size: 76, id: 'sb', tile: false })}</div>
    <div style="position:absolute;left:0;right:0;top:150px;text-align:center">${text('NEXUSFORGE', 15, 600, INK, 0.2)}</div>
    <div style="position:absolute;left:0;right:0;top:173px;text-align:center">${text('EST. 2026', 9.5, 400, '#7a7a7a', 0.32)}</div>
    <div style="position:absolute;left:30px;right:30px;top:198px;height:1px;background:#262626"></div>
    <div style="position:absolute;left:0;right:0;top:210px;text-align:center">${text('MOD MANAGER', 8.5, 400, '#5e5e5e', 0.26)}${text('&amp; LAUNCHER', 8.5, 400, '#5e5e5e', 0.26, 'margin-top:3px')}</div>
    <div style="position:absolute;left:0;right:0;bottom:14px;text-align:center">${text(`V${version}`, 8.5, 400, '#4a4a4a', 0.28)}</div>`
  )
)
// The header strip of the other pages: the installer paints it in the same near-black (installer.nsh).
place(
  'header',
  150,
  57,
  panel(
    150,
    57,
    `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:9px;padding-right:12px">
      ${text('NEXUSFORGE', 10.5, 600, INK, 0.18)}
      ${markSvg({ size: 34, id: 'hd', tile: false })}
    </div>`
  )
)

const hero = (w, h, iconSize, titleSize, tagSize, id) =>
  panel(
    w,
    h,
    `${honeycomb(w, h, Math.round(h / 7), '#191919', `${id}h`, 'cx="0.28" cy="0.5" r="0.75"')}
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:${Math.round(iconSize * 0.3)}px">
      ${markSvg({ size: iconSize, id, tile: false })}
      <div style="border-left:1px solid #262626;padding-left:${Math.round(iconSize * 0.3)}px">
        ${text('NEXUSFORGE', titleSize, 600, INK, 0.16)}
        ${text('EST. 2026', tagSize * 0.8, 400, '#7a7a7a', 0.4, `margin-top:${Math.round(tagSize * 0.5)}px`)}
        ${text('UNIVERSAL GAME MOD MANAGER &amp; LAUNCHER FOR WINDOWS', tagSize * 0.78, 400, '#9a9a9a', 0.14, `margin-top:${Math.round(tagSize * 1.2)}px`)}
        ${text('MOD LOADERS &nbsp;·&nbsp; RESHADE &nbsp;·&nbsp; VERIFIED DEPLOYMENT &nbsp;·&nbsp; DIAGNOSTICS', tagSize * 0.62, 400, '#5e5e5e', 0.16, `margin-top:${Math.round(tagSize * 0.7)}px`)}
      </div>
    </div>`
  )
place('banner', 1280, 360, hero(1280, 360, 170, 58, 22, 'bn'))
place('social', 1280, 640, hero(1280, 640, 230, 76, 28, 'so'))

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:transparent; -webkit-font-smoothing:antialiased; }
  .box { position:absolute; left:0; overflow:hidden; }
  .box > svg { display:block; }
</style></head><body>
${items.map((it) => `<div class="box" id="${it.name}" style="top:0;display:none;width:${it.w}px;height:${it.h}px">${it.html}</div>`).join('\n')}
</body></html>`

/** PNG-compressed .ico (Windows Vista and later read PNG entries of every size). */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

/** 24-bit bottom-up BMP (what NSIS's installer pages want) from Electron's BGRA bitmap. */
function bmp(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * h)
  out.write('BM', 0)
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(w, 18)
  out.writeInt32LE(h, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * h, 34)
  out.writeInt32LE(2835, 38)
  out.writeInt32LE(2835, 42)
  for (let yy = 0; yy < h; yy++) {
    const src = (h - 1 - yy) * w * 4
    const dst = 54 + yy * row
    for (let x = 0; x < w; x++) {
      out[dst + x * 3] = bgra[src + x * 4]
      out[dst + x * 3 + 1] = bgra[src + x * 4 + 1]
      out[dst + x * 3 + 2] = bgra[src + x * 4 + 2]
    }
  }
  return out
}

// Grey anti-aliasing: ClearType's coloured fringes would put colour into a greys-only design.
app.commandLine.appendSwitch('disable-lcd-text')

app.whenReady().then(async () => {
  const tmp = join(app.getPath('temp'), 'nexusforge-brand.html')
  writeFileSync(tmp, page)
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  await win.loadFile(tmp)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.size)')
  await new Promise((r) => setTimeout(r, 600))
  const shot = async (it) => {
    // One image at a time, at the top left (an offscreen page only paints what fits its window).
    await win.webContents.executeJavaScript(`document.querySelectorAll('.box').forEach((b) => (b.style.display = b.id === '${it.name}' ? 'block' : 'none'))`)
    await new Promise((r) => setTimeout(r, 120))
    win.webContents.invalidate()
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: it.w, height: it.h })
    const s = img.getSize()
    return s.width === it.w && s.height === it.h ? img : img.resize({ width: it.w, height: it.h, quality: 'best' })
  }
  const by = (n) => items.find((i) => i.name === n)

  const pngs = []
  for (const s of ICO_SIZES) pngs.push({ size: s, data: (await shot(by(`ico-${s}`))).toPNG() })
  writeFileSync(join(res, 'icon.ico'), ico(pngs))
  writeFileSync(join(res, 'icon.png'), (await shot(by('png-512'))).toPNG())
  writeFileSync(join(res, 'icon.svg'), markSvg({ size: 512, id: 'nf' }) + '\n')
  for (const [name, file] of [
    ['sidebar', 'installerSidebar.bmp'],
    ['header', 'installerHeader.bmp']
  ]) {
    const it = by(name)
    writeFileSync(join(res, file), bmp((await shot(it)).toBitmap(), it.w, it.h))
  }
  writeFileSync(join(brand, 'readme-banner.png'), (await shot(by('banner'))).toPNG())
  writeFileSync(join(brand, 'social-preview.png'), (await shot(by('social'))).toPNG())
  // A contact sheet to look at the small sizes.
  const sheet = items.filter((i) => i.name.startsWith('ico-') || i.name === 'sidebar' || i.name === 'header')
  writeFileSync(join(brand, 'sizes.html'), `<body style="background:#202124;color:#aaa;font:12px sans-serif">${sheet.map((i) => `<div style="display:inline-block;margin:8px;vertical-align:top">${i.html.includes('<svg') && !i.name.includes('side') ? i.html : ''}<div>${i.name}</div></div>`).join('')}</body>`)
  console.log(`wrote icon.ico (${ICO_SIZES.join(', ')}), icon.png, icon.svg, installerSidebar.bmp, installerHeader.bmp, brand/readme-banner.png, brand/social-preview.png`)
  app.quit()
})
