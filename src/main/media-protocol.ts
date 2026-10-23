import { net, protocol } from 'electron'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MEDIA_SCHEME = 'nexus-media'
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.avif'])

/** URL the renderer can load for a local image file. */
export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absPath)}`
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/** Serves local image files only; anything else is a 403. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!IMAGE_EXT.has(extname(file).toLowerCase())) return new Response('Forbidden', { status: 403 })
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
