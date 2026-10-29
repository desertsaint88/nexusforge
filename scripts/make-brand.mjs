// Renders every NexusForge brand image from one mark (scripts/brand-mark.mjs) with Electron's offscreen renderer:
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
import { pathToFileURL } from 'node:url'
import { markSvg } from './brand-mark.mjs'

const root = join(import.meta.dirname, '..')
const res = join(root, 'resources')
const brand = join(res, 'brand')
mkdirSync(brand, { recursive: true })
const font = pathToFileURL(join(root, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2')).href
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

const text = (t, size, weight, color, extra = '') => `<div style="font:${weight} ${size}px/1.15 Inter;color:${color};letter-spacing:${size > 40 ? '-0.03em' : '0'};${extra}">${t}</div>`
const glow = (x, y, r, a) => `<div style="position:absolute;left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,138,61,${a}),transparent)"></div>`
const dark = 'background:radial-gradient(900px 500px at 20% 0%,#17181c,transparent 70%),#09090b'

place(
  'sidebar',
  164,
  314,
  `<div style="position:absolute;inset:0;${dark};overflow:hidden">
    ${glow(82, 104, 90, 0.16)}
    <div style="position:absolute;left:42px;top:64px">${markSvg({ size: 80, id: 'sb' })}</div>
    <div style="position:absolute;left:0;right:0;top:162px;text-align:center">${text('NexusForge', 21, 700, '#f2f3f5')}</div>
    <div style="position:absolute;left:14px;right:14px;top:192px;text-align:center">${text('Mod manager &amp; launcher', 11.5, 450, '#8d9098')}</div>
    <div style="position:absolute;left:0;right:0;bottom:16px;text-align:center">${text(`Version ${version}`, 10.5, 500, '#5c5f67')}</div>
  </div>`
)
place(
  'header',
  150,
  57,
  `<div style="position:absolute;inset:0;background:#ffffff;display:flex;align-items:center;justify-content:flex-end;gap:9px;padding-right:12px">
    ${text('NexusForge', 14, 700, '#18191d')}
    ${markSvg({ size: 34, id: 'hd' })}
  </div>`
)

const hero = (w, h, iconSize, titleSize, tagSize, id) => `<div style="position:absolute;inset:0;${dark};overflow:hidden">
    <div style="position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(ellipse at 30% 40%,#000 20%,transparent 75%)"></div>
    ${glow(w * 0.5 - (titleSize * 4.2) / 2, h / 2, iconSize * 1.4, 0.13)}
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:${Math.round(iconSize * 0.28)}px">
      ${markSvg({ size: iconSize, id })}
      <div>
        ${text('NexusForge', titleSize, 750, '#f4f5f7')}
        ${text('Universal game mod manager &amp; launcher for Windows', tagSize, 450, '#9a9da5', `margin-top:${Math.round(tagSize * 0.55)}px`)}
        ${text('Mod loaders &nbsp;·&nbsp; Verified deployment &nbsp;·&nbsp; Diagnostics &nbsp;·&nbsp; In-app updates', tagSize * 0.72, 500, '#62656d', `margin-top:${Math.round(tagSize * 0.9)}px;letter-spacing:.02em`)}
      </div>
    </div>
  </div>`
place('banner', 1280, 360, hero(1280, 360, 150, 64, 22, 'bn'))
place('social', 1280, 640, hero(1280, 640, 190, 80, 27, 'so'))

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: url('${font}') format('woff2'); font-weight: 100 900; }
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
