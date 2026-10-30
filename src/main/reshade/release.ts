// ReShade itself, from its only official source: reshade.me. The site offers the newest version as a setup program
// in two builds (standard, and "with full add-on support", which is meant for single-player games). The setup
// carries ReShade32.dll and ReShade64.dll in a zip archive appended to the program; NexusForge takes the DLL out of
// it instead of running the setup.
//
// Checks before anything is used: the setup's Authenticode signature must be intact and made with the certificate
// reshade.me states (X.509 thumbprint on the download section; pinned below as well), the standard build's DLLs
// carry the same signature, every file in the archive matches its CRC, and the DLL's version is the one the site
// offers. reshade.me publishes no checksum, so the signature is what proves the files are crosire's.

import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateRawSync, crc32 } from 'node:zlib'
import { join } from 'node:path'
import type { IntegrationEnv, StepReporter } from '../integrations/types'
import { compareVersions } from '../integrations/common'

export const RESHADE_SITE = 'https://reshade.me/'
export const RESHADE_HOSTS = ['reshade.me', 'www.reshade.me']
/** The certificate reshade.me names as the one its downloads are signed with (CN=ReShade). */
export const RESHADE_THUMBPRINT = '589690208A5E52FB96980C4A6698F50ACD47C49F'

export type ReshadeBuild = 'standard' | 'addon'
export type ReshadeArch = 'x86' | 'x64'

export interface ReshadeRelease {
  version: string
  url: string
  addonUrl?: string
  /** Thumbprint the page states (normally RESHADE_THUMBPRINT). */
  thumbprint?: string
  released?: string
}

/** Reads the newest version and its two downloads from reshade.me's front page. */
export function parseReshadePage(html: string): ReshadeRelease | undefined {
  const std = html.match(/href="((?:https:\/\/reshade\.me)?\/downloads\/ReShade_Setup_(\d+\.\d+\.\d+)\.exe)"/i)
  if (!std) return undefined
  const abs = (u: string) => (u.startsWith('http') ? u : `https://reshade.me${u}`)
  const addon = html.match(/href="((?:https:\/\/reshade\.me)?\/downloads\/ReShade_Setup_[\d.]+_Addon\.exe)"/i)
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  return {
    version: std[2],
    url: abs(std[1]),
    addonUrl: addon ? abs(addon[1]) : undefined,
    thumbprint: text.match(/Thumbprint:?\s*\W*([0-9A-F]{40})/i)?.[1].toUpperCase(),
    released: text.match(/released\s+on\s+([A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)? \d{4})/i)?.[1]
  }
}

let pageCache: { at: number; rel: ReshadeRelease } | undefined

export async function reshadeRelease(env: Pick<IntegrationEnv, 'fetchText'>): Promise<ReshadeRelease> {
  if (pageCache && Date.now() - pageCache.at < 30 * 60_000) return pageCache.rel
  const rel = parseReshadePage(await env.fetchText(RESHADE_SITE))
  if (!rel) throw new Error("reshade.me's download section has no setup link NexusForge recognizes.")
  pageCache = { at: Date.now(), rel }
  return rel
}

export function clearReshadeCache(): void {
  pageCache = undefined
}

// ---------------------------------------------------------------------------
// The archive inside the setup

export interface EmbeddedEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  /** Absolute offset of the local file header in the setup. */
  local: number
}

/**
 * Finds the zip archive appended to a program (the setup, then the archive, then the Authenticode signature) and
 * lists it. Offsets in the archive count from its own start, which is worked out from the end record.
 */
export function embeddedZip(buf: Buffer): EmbeddedEntry[] {
  const from = Math.max(0, buf.length - 256 * 1024)
  for (let p = buf.length - 22; p >= from; p--) {
    if (buf.readUInt32LE(p) !== 0x06054b50) continue
    const count = buf.readUInt16LE(p + 10)
    const cdSize = buf.readUInt32LE(p + 12)
    const cdOffset = buf.readUInt32LE(p + 16)
    const cdStart = p - cdSize
    const zipStart = cdStart - cdOffset
    if (cdStart < 0 || zipStart < 0 || buf.readUInt32LE(cdStart) !== 0x02014b50) continue
    const out: EmbeddedEntry[] = []
    let q = cdStart
    for (let i = 0; i < count && q + 46 <= p; i++) {
      if (buf.readUInt32LE(q) !== 0x02014b50) break
      const nameLen = buf.readUInt16LE(q + 28)
      const extraLen = buf.readUInt16LE(q + 30)
      const commentLen = buf.readUInt16LE(q + 32)
      out.push({
        name: buf.toString('utf8', q + 46, q + 46 + nameLen),
        method: buf.readUInt16LE(q + 10),
        crc: buf.readUInt32LE(q + 16),
        compressedSize: buf.readUInt32LE(q + 20),
        size: buf.readUInt32LE(q + 24),
        local: zipStart + buf.readUInt32LE(q + 42)
      })
      q += 46 + nameLen + extraLen + commentLen
    }
    if (out.length) return out
  }
  throw new Error('The ReShade setup contains no archive NexusForge can read (damaged or not a ReShade setup).')
}

/** Unpacks one entry (stored or deflated) and checks its CRC. */
export function embeddedFile(buf: Buffer, entry: EmbeddedEntry): Buffer {
  if (buf.readUInt32LE(entry.local) !== 0x04034b50) throw new Error(`${entry.name}: damaged archive entry.`)
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28)
  const raw = buf.subarray(start, start + entry.compressedSize)
  let data: Buffer
  if (entry.method === 0) data = Buffer.from(raw)
  else if (entry.method === 8) data = inflateRawSync(raw)
  else throw new Error(`${entry.name}: compression method ${entry.method} is not supported.`)
  if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc >>> 0) throw new Error(`${entry.name} does not match its checksum in the archive (damaged download).`)
  return data
}

// ---------------------------------------------------------------------------
// Download, check, unpack

export interface ReshadeBinaries {
  version: string
  build: ReshadeBuild
  /** Folder with ReShade32.dll and ReShade64.dll. */
  dir: string
  thumbprint: string
}

interface Verified {
  version: string
  build: ReshadeBuild
  thumbprint: string
  files: Record<string, string>
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex')
}

/** A signature is acceptable when it is intact and made with ReShade's certificate (self-signed, so not "trusted"). */
function signatureOk(sig: { status: string; thumbprint?: string } | undefined, thumbprints: string[]): boolean {
  if (!sig?.thumbprint) return false
  return ['Valid', 'UnknownError'].includes(sig.status) && thumbprints.includes(sig.thumbprint.toUpperCase())
}

/**
 * The ReShade DLLs of a build, downloaded from reshade.me and checked (kept in NexusForge's work folder, so every
 * game uses the same checked copy).
 */
export async function reshadeBinaries(env: IntegrationEnv, build: ReshadeBuild, report: StepReporter = () => {}, signal?: AbortSignal): Promise<ReshadeBinaries> {
  const rel = await reshadeRelease(env)
  const url = build === 'addon' ? rel.addonUrl : rel.url
  if (!url) throw new Error(`reshade.me offers no ${build === 'addon' ? 'add-on' : 'standard'} build of ReShade ${rel.version} right now.`)
  const thumbprints = [...new Set([RESHADE_THUMBPRINT, ...(rel.thumbprint ? [rel.thumbprint] : [])])]
  const dir = join(env.workDir, 'reshade', rel.version, build)
  const marker = join(dir, 'verified.json')
  try {
    const v = JSON.parse(await fsp.readFile(marker, 'utf8')) as Verified
    let intact = v.version === rel.version && v.build === build
    for (const [name, sha] of Object.entries(v.files)) if (intact && (await sha256File(join(dir, name)).catch(() => '')) !== sha) intact = false
    if (intact) return { version: rel.version, build, dir, thumbprint: v.thumbprint }
  } catch {
    // not downloaded yet
  }
  if (!env.verifySignature) throw new Error('NexusForge cannot check digital signatures on this system, so it does not install ReShade.')
  await fsp.mkdir(dir, { recursive: true })
  const setup = join(dir, url.split('/').pop()!)
  report(`Downloading ReShade ${rel.version}${build === 'addon' ? ' with add-on support' : ''} from reshade.me…`, 0)
  await env.download(url, setup, { allowedHosts: RESHADE_HOSTS, signal, onProgress: (r, t) => report(`Downloading ReShade ${rel.version} from reshade.me…`, t ? r / t : undefined) })
  try {
    const sig = await env.verifySignature(setup)
    if (!signatureOk(sig, thumbprints)) {
      throw new Error(`The downloaded ReShade setup is not signed with ReShade's certificate (${sig?.status ?? 'no signature'}${sig?.thumbprint ? `, ${sig.thumbprint}` : ''}). NexusForge did not use it.`)
    }
    report(`Signature checked: ReShade's certificate (${sig!.thumbprint})`)
    const buf = await fsp.readFile(setup)
    const entries = embeddedZip(buf)
    const files: Record<string, string> = {}
    for (const name of ['ReShade32.dll', 'ReShade64.dll']) {
      const entry = entries.find((e) => e.name.toLowerCase() === name.toLowerCase())
      if (!entry) throw new Error(`The ReShade setup has no ${name}.`)
      const data = embeddedFile(buf, entry)
      await fsp.writeFile(join(dir, name), data)
      const ver = await env.fileVersion(join(dir, name))
      if (ver && compareVersions(ver.split('.').slice(0, 3).join('.'), rel.version) !== 0) throw new Error(`${name} in the setup is version ${ver}, not ${rel.version}.`)
      if (build === 'standard' && !signatureOk(await env.verifySignature(join(dir, name)), thumbprints)) throw new Error(`${name} of the standard build is not signed with ReShade's certificate.`)
      files[name] = createHash('sha256').update(data).digest('hex')
    }
    const verified: Verified = { version: rel.version, build, thumbprint: sig!.thumbprint!.toUpperCase(), files }
    await fsp.writeFile(marker, JSON.stringify(verified, null, 2))
    return { version: rel.version, build, dir, thumbprint: verified.thumbprint }
  } finally {
    await fsp.rm(setup, { force: true }).catch(() => {})
  }
}
