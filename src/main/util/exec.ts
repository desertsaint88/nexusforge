import { execFile } from 'node:child_process'

export function run(file: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
      }
    )
  })
}

/** Read a single registry value with reg.exe. Returns undefined when the key/value is missing. */
export async function regValue(key: string, name: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const { stdout, code } = await run('reg.exe', ['query', key, '/v', name], { timeoutMs: 8000 })
  if (code !== 0) return undefined
  const line = stdout.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase() + ' '))
  if (!line) return undefined
  const m = line.trim().match(/^\S+\s+REG_\w+\s+(.*)$/)
  return m?.[1]?.trim()
}

/** List the values of every sub key below `key` (reg query /s). */
export async function regSubKeys(key: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  if (process.platform !== 'win32') return out
  const { stdout, code } = await run('reg.exe', ['query', key, '/s'], { timeoutMs: 15000 })
  if (code !== 0) return out
  let current: Record<string, string> | undefined
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue
    if (/^HKEY_/i.test(raw)) {
      current = {}
      out[raw.trim()] = current
      continue
    }
    const m = raw.trim().match(/^(.+?)\s+REG_\w+\s*(.*)$/)
    if (m && current) current[m[1]] = m[2] ?? ''
  }
  return out
}
