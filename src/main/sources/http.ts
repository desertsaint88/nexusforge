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

/** Strips HTML/BBCode to readable text; descriptions are never rendered as HTML. */
export function toPlainText(input: string | undefined): string {
  if (!input) return ''
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(b|i|u|s|center|size|color|font|quote|spoiler|list|\*|img|url|youtube|line|heading)[^\]]*\]/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const normName = (s: string) => s.toLowerCase().replace(/[™®©']/g, '').replace(/[^a-z0-9]/g, '')
