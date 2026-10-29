// The NexusForge mark: an "N" drawn as one stroke whose last line ends in an ember spark (the forge), on a dark
// graphite tile. The same geometry is in src/renderer/src/components/Chrome.tsx (Logo); keep both in step.

/**
 * @param {{ size: number, id: string, small?: boolean, tile?: boolean }} o
 *   small: the 16–24 px drawing (thicker stroke, bigger spark, no glow, tile to the edge).
 */
export function markSvg({ size, id, small = false, tile = true }) {
  const t = small ? { x: 0, r: 12 } : { x: 2, r: 14 }
  const n = small ? { d: 'M20 47V17L44 47V30.5', w: 7.6 } : { d: 'M21 46V18L43 46V30', w: 6 }
  const e = small ? { cx: 44, cy: 18.5, r: 6.2 } : { cx: 43, cy: 19, r: 5.2 }
  const tileSize = 64 - 2 * t.x
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="${id}-t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2c32"/><stop offset="1" stop-color="#0c0c0f"/></linearGradient>
    <linearGradient id="${id}-s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b4b7bf"/></linearGradient>
    <radialGradient id="${id}-e" cx="0.42" cy="0.38" r="0.62"><stop offset="0" stop-color="#ffe6b0"/><stop offset="0.45" stop-color="#ffa14a"/><stop offset="1" stop-color="#ec5a24"/></radialGradient>
    <radialGradient id="${id}-g" cx="${e.cx}" cy="${e.cy}" r="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff8a3d" stop-opacity="0.34"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>
  </defs>
  ${
    tile
      ? `<rect x="${t.x}" y="${t.x}" width="${tileSize}" height="${tileSize}" rx="${t.r}" fill="url(#${id}-t)"/>
  ${small ? '' : `<rect x="${t.x}" y="${t.x}" width="${tileSize}" height="${tileSize}" rx="${t.r}" fill="url(#${id}-g)"/>`}
  <rect x="${t.x + 0.5}" y="${t.x + 0.5}" width="${tileSize - 1}" height="${tileSize - 1}" rx="${t.r - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="${small ? 0.12 : 0.09}"/>`
      : ''
  }
  <path d="${n.d}" fill="none" stroke="url(#${id}-s)" stroke-width="${n.w}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${e.cx}" cy="${e.cy}" r="${e.r}" fill="url(#${id}-e)"/>
</svg>`
}
