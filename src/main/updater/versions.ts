// Version and release-file helpers for the updater (no Electron, tested directly).

/** -1 / 0 / 1 for dotted versions ("v1.10.0" > "1.9.2"); a pre-release is older than its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/i, '').split('-', 2)
    return { nums: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  return 0
}

/** The installer named in a release's latest.yml, with its SHA-512 (base64) and size. */
export function parseLatestYml(text: string): { version?: string; file?: string; sha512?: string; size?: number } {
  const get = (re: RegExp) => text.match(re)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  return {
    version: get(/^version:\s*(.+)$/m),
    file: get(/^\s*-\s*url:\s*(.+)$/m) ?? get(/^path:\s*(.+)$/m),
    sha512: get(/^\s+sha512:\s*(.+)$/m) ?? get(/^sha512:\s*(.+)$/m),
    size: Number(get(/^\s+size:\s*(\d+)$/m)) || undefined
  }
}
