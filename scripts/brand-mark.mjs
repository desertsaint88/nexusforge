// The NexusForge mark, in the Grey Hat style of the hacker-group marks it sits next to: greys only, one line weight,
// a plain geometric frame. A pointy-top hexagon (the forge) around an "N" drawn as a small network: four nodes
// joined by the letter's three strokes (the nexus). On a near-black tile for the app and installer icons.
// The same geometry is in src/renderer/src/components/Chrome.tsx (Logo); keep both in step.

export const INK = '#c8c8c8'
export const BG = '#0e0e0e'

/** Hexagon (pointy top) around the centre of the 64×64 box. */
export function hexPath(r) {
  const pts = [0, 1, 2, 3, 4, 5].map((k) => {
    const a = ((-90 + 60 * k) * Math.PI) / 180
    return [32 + r * Math.cos(a), 32 + r * Math.sin(a)].map((v) => Math.round(v * 100) / 100)
  })
  return `M${pts.map((p) => p.join(' ')).join('L')}Z`
}

/** normal: 32 px and up (network nodes drawn); small: 16–24 px (bolder lines, no nodes, tile to the edge). */
export const GEOMETRY = {
  normal: { hexR: 21.5, hexW: 2.4, n: [[24.6, 40.2], [24.6, 23.8], [39.4, 40.2], [39.4, 23.8]], nW: 2.4, node: 3.2, tile: { x: 2, r: 14 } },
  small: { hexR: 26.5, hexW: 4.6, n: [[23, 42], [23, 22], [41, 42], [41, 22]], nW: 5.4, node: 0, tile: { x: 0, r: 12 } }
}

/**
 * @param {{ size: number, id: string, small?: boolean, tile?: boolean, ink?: string }} o
 *   tile: false draws only the mark (installer pages, banners), in `ink`.
 */
export function markSvg({ size, id, small = false, tile = true, ink = INK }) {
  const g = small ? GEOMETRY.small : GEOMETRY.normal
  const t = g.tile
  const tileSize = 64 - 2 * t.x
  const n = g.n.map((p) => p.join(' '))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="${id}-t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#181818"/><stop offset="1" stop-color="#0b0b0b"/></linearGradient>
  </defs>
  ${
    tile
      ? `<rect x="${t.x}" y="${t.x}" width="${tileSize}" height="${tileSize}" rx="${t.r}" fill="url(#${id}-t)"/>
  <rect x="${t.x + 0.5}" y="${t.x + 0.5}" width="${tileSize - 1}" height="${tileSize - 1}" rx="${t.r - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="${small ? 0.1 : 0.07}"/>`
      : ''
  }
  <path d="${hexPath(g.hexR)}" fill="none" stroke="${ink}" stroke-width="${g.hexW}" stroke-linejoin="round"/>
  <path d="M${n[0]}L${n[1]}L${n[2]}L${n[3]}" fill="none" stroke="${ink}" stroke-width="${g.nW}" stroke-linecap="round" stroke-linejoin="round"/>
  ${g.node ? g.n.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${g.node}" fill="${ink}"/>`).join('') : ''}
</svg>`
}
