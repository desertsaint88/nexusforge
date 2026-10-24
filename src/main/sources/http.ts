import type { HttpOptions } from './types'

export const USER_AGENT = 'NexusForge/1.0'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...opts.headers }
  let body: string | undefined
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    headers['Content-Type'] ??= 'application/json'
  }
  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) })
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      const parsed = JSON.parse(text) as { message?: string; error?: string; detail?: string }
      detail = parsed.message ?? parsed.error ?? parsed.detail ?? text.slice(0, 200)
    } catch {
      // not JSON
    }
    throw new HttpError(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`, res.status)
  }
  return (await res.json()) as T
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9', ...opts.headers },
    body: typeof opts.body === 'string' ? opts.body : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000)
  })
  if (res.status === 429) throw new HttpError('The site is rate limiting requests. Wait a minute and try again.', 429)
  if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status)
  return res.text()
}

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 NexusForge/1.0'

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

/** Strips HTML/BBCode to readable text; descriptions are never rendered as HTML. */
export function toPlainText(input: string | undefined): string {
  if (!input) return ''
  const text = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[img[^\]]*\][^[]*\[\/img\]/gi, '')
    .replace(/\[youtube[^\]]*\][^[]*\[\/youtube\]/gi, '')
    .replace(/\[\*\]/g, '• ')
    .replace(/\[\/?(b|i|u|s|h\d|center|size|color|font|quote|spoiler|list|olist|img|url|youtube|line|heading|hr|table|tr|td|th|noparse|code)[^\]]*\]/gi, '')
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const normName = (s: string) => s.toLowerCase().replace(/[™®©']/g, '').replace(/[^a-z0-9]/g, '')

const NAME_NOISE = /\b(demo|playtest|public test|beta|alpha|early access|prologue|remastered|definitive edition|game of the year edition|goty|complete edition|enhanced edition|anniversary edition|legacy|enhanced)\b/gi

/**
 * Search terms for finding a game on a mod site, most specific first:
 * "Casualties: Unknown Demo" -> ["Casualties: Unknown Demo", "Casualties: Unknown", "Casualties"].
 */
export function gameNameVariants(name: string): string[] {
  const clean = name.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()
  const out = [clean]
  const noNoise = clean.replace(NAME_NOISE, '').replace(/[\s:–-]+$/g, '').replace(/\s{2,}/g, ' ').trim()
  if (noNoise && noNoise !== clean) out.push(noNoise)
  const beforeColon = noNoise.split(/[:–]| - /)[0].trim()
  if (beforeColon && beforeColon.length >= 4 && !out.includes(beforeColon)) out.push(beforeColon)
  return out
}

/** 0..1 similarity of two names after normalization (exact > prefix > shared words). */
export function nameScore(a: string, b: string): number {
  const x = normName(a.replace(NAME_NOISE, ''))
  const y = normName(b.replace(NAME_NOISE, ''))
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.startsWith(y) || y.startsWith(x)) return 0.85 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.1
  const wa = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
  const shared = [...wa].filter((w) => wb.has(w)).length
  return shared ? (0.6 * shared) / Math.max(wa.size, wb.size) : 0
}
