// ReShade's .ini files (ReShade.ini, presets, the setup's Compatibility.ini and EffectPackages.ini) as an editable
// document: values change in place, everything else (order, comments, keys NexusForge doesn't know) stays as the
// file had it. ReShade writes "Key=Value" without spaces and lists as comma-separated values.

export interface IniLine {
  /** Section the line belongs to ('' = before the first section header). */
  section: string
  key?: string
  value?: string
  /** The line as it was read (comments, blank lines, headers). */
  raw: string
}

export class IniDoc {
  lines: IniLine[] = []

  static parse(text: string): IniDoc {
    const doc = new IniDoc()
    let section = ''
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      const header = raw.match(/^\s*\[([^\]\r\n]*)\]\s*$/)
      if (header) {
        section = header[1].trim()
        doc.lines.push({ section, raw })
        continue
      }
      const kv = raw.match(/^\s*([^=;#\s][^=]*?)\s*=(.*)$/)
      if (kv) doc.lines.push({ section, key: kv[1], value: kv[2].trim(), raw })
      else doc.lines.push({ section, raw })
    }
    // A trailing newline leaves one empty line; serialize() adds it back.
    if (doc.lines.length && doc.lines[doc.lines.length - 1].raw === '' && !doc.lines[doc.lines.length - 1].key) doc.lines.pop()
    return doc
  }

  sections(): string[] {
    const out: string[] = []
    for (const l of this.lines) if (!out.includes(l.section) && (l.key || l.raw.trim().startsWith('['))) out.push(l.section)
    return out
  }

  private find(section: string, key: string): IniLine | undefined {
    const s = section.toLowerCase()
    const k = key.toLowerCase()
    return this.lines.find((l) => l.key !== undefined && l.section.toLowerCase() === s && l.key.toLowerCase() === k)
  }

  has(section: string, key?: string): boolean {
    if (key === undefined) return this.lines.some((l) => l.section.toLowerCase() === section.toLowerCase() && (l.key !== undefined || l.raw.trim().startsWith('[')))
    return Boolean(this.find(section, key))
  }

  get(section: string, key: string): string | undefined {
    return this.find(section, key)?.value
  }

  /** A comma-separated value as a list (empty entries dropped). */
  getList(section: string, key: string): string[] | undefined {
    const v = this.get(section, key)
    return v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean)
  }

  /** Keys and values of one section, in file order. */
  entries(section: string): Array<[string, string]> {
    const s = section.toLowerCase()
    return this.lines.filter((l) => l.key !== undefined && l.section.toLowerCase() === s).map((l) => [l.key!, l.value ?? ''])
  }

  /** Sets a value; returns true when the file changes. New keys go at the end of their section (created if needed). */
  set(section: string, key: string, value: string | string[]): boolean {
    const v = Array.isArray(value) ? value.join(',') : value
    const hit = this.find(section, key)
    if (hit) {
      if (hit.value === v) return false
      hit.value = v
      hit.raw = `${hit.key}=${v}`
      return true
    }
    const s = section.toLowerCase()
    let last = -1
    for (let i = 0; i < this.lines.length; i++) if (this.lines[i].section.toLowerCase() === s && (this.lines[i].key !== undefined || this.lines[i].raw.trim().startsWith('['))) last = i
    const line: IniLine = { section, key, value: v, raw: `${key}=${v}` }
    if (last >= 0) {
      this.lines.splice(last + 1, 0, line)
    } else {
      if (section) {
        if (this.lines.length && this.lines[this.lines.length - 1].raw.trim() !== '') this.lines.push({ section: this.lines[this.lines.length - 1].section, raw: '' })
        this.lines.push({ section, raw: `[${section}]` })
      }
      if (!section) this.lines.unshift(line)
      else this.lines.push(line)
    }
    return true
  }

  delete(section: string, key: string): boolean {
    const hit = this.find(section, key)
    if (!hit) return false
    this.lines.splice(this.lines.indexOf(hit), 1)
    return true
  }

  serialize(): string {
    return `${this.lines.map((l) => l.raw).join('\r\n')}\r\n`
  }
}

/** Sections of a list file (Compatibility.ini, EffectPackages.ini) with their values; '#' starts a comment. */
export function parseListIni(text: string): Array<{ name: string; values: Record<string, string> }> {
  const out: Array<{ name: string; values: Record<string, string> }> = []
  let current: { name: string; values: Record<string, string> } | undefined
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      current = { name: header[1].trim(), values: {} }
      out.push(current)
      continue
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (kv && current) current.values[kv[1]] = kv[2].trim()
  }
  return out
}
