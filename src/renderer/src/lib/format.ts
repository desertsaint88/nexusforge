export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatPlaytime(minutes: number | undefined): string {
  if (!minutes) return 'Never played'
  if (minutes < 60) return `${minutes} min`
  const h = minutes / 60
  return h < 100 ? `${h.toFixed(1)} h` : `${Math.round(h).toLocaleString()} h`
}

export function formatCount(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function relativeTime(ts: number | string | undefined): string {
  if (!ts) return '—'
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!t) return '—'
  const diff = Date.now() - t
  const s = Math.round(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`
  const y = Math.round(mo / 12)
  return `${y} year${y === 1 ? '' : 's'} ago`
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`
}

/** Time left: "45 s", "3 min 20 s", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`
}

/** Deterministic pair of hues for generated artwork. */
export function nameHues(name: string): [number, number] {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  const a = Math.abs(h) % 360
  return [a, (a + 40 + (Math.abs(h >> 8) % 80)) % 360]
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + (words.find((w, i) => i > 0 && /\p{L}|\p{N}/u.test(w[0])) ?? words[1])[0]).toUpperCase()
}

export const PLATFORM_LABEL: Record<string, string> = {
  steam: 'Steam',
  epic: 'Epic Games',
  xbox: 'Xbox',
  gog: 'GOG',
  custom: 'Local',
  manual: 'Manual'
}

export const PLATFORM_COLOR: Record<string, string> = {
  steam: '#66c0f4',
  epic: '#e5e7eb',
  xbox: '#4ade80',
  gog: '#c084fc',
  custom: '#fbbf24',
  manual: '#f472b6'
}
