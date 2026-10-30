import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * Windows' own Authenticode check (Get-AuthenticodeSignature): the signature's status ("Valid", "UnknownError" for
 * an intact signature from a self-signed certificate, "HashMismatch", "NotSigned") and the signer's thumbprint.
 * The path goes in through the environment, never the command line.
 */
export async function authenticode(file: string): Promise<{ status: string; thumbprint?: string } | undefined> {
  if (process.platform !== 'win32') return undefined
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:NF_SIGNED_FILE; Write-Output ("{0}|{1}" -f $s.Status, $s.SignerCertificate.Thumbprint)'
  const out = await new Promise<string>((resolve) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 60_000, env: { ...process.env, NF_SIGNED_FILE: file } }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })
  const line = out.trim().split(/\r?\n/).pop() ?? ''
  const [status, thumbprint] = line.split('|')
  return status ? { status: status.trim(), thumbprint: thumbprint?.trim() || undefined } : undefined
}
