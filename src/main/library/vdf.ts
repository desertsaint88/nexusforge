// Minimal parser for Valve's text KeyValues format (libraryfolders.vdf, *.acf, localconfig.vdf).

export type VdfValue = string | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

export function parseVdf(text: string): VdfObject {
  const root: VdfObject = {}
  const stack: VdfObject[] = [root]
  let i = 0
  const n = text.length
  let pendingKey: string | undefined

  const readString = (): string => {
    // assumes text[i] === '"'
    i++
    let out = ''
    while (i < n) {
      const c = text[i]
      if (c === '\\' && i + 1 < n) {
        const next = text[i + 1]
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        i += 2
        continue
      }
      if (c === '"') {
        i++
        break
      }
      out += c
      i++
    }
    return out
  }

  const readBare = (): string => {
    let out = ''
    while (i < n && !/[\s{}"]/.test(text[i])) out += text[i++]
    return out
  }

  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '[') {
      // conditional like [$WIN32] - skip
      while (i < n && text[i] !== ']') i++
      i++
      continue
    }
    if (c === '{') {
      i++
      const obj: VdfObject = {}
      const parent = stack[stack.length - 1]
      if (pendingKey !== undefined) {
        assign(parent, pendingKey, obj)
        pendingKey = undefined
      }
      stack.push(obj)
      continue
    }
    if (c === '}') {
      i++
      if (stack.length > 1) stack.pop()
      pendingKey = undefined
      continue
    }
    const token = c === '"' ? readString() : readBare()
    if (pendingKey === undefined) {
      pendingKey = token
    } else {
      assign(stack[stack.length - 1], pendingKey, token)
      pendingKey = undefined
    }
  }
  return root
}

function assign(obj: VdfObject, key: string, value: VdfValue): void {
  const existing = obj[key]
  if (existing !== undefined && typeof existing === 'object' && typeof value === 'object') {
    Object.assign(existing, value)
  } else {
    obj[key] = value
  }
}

/** Case-insensitive child lookup. */
export function vget(obj: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    const lower = key.toLowerCase()
    const hit: string | undefined = Object.keys(cur).find((k) => k.toLowerCase() === lower)
    cur = hit === undefined ? undefined : cur[hit]
  }
  return cur
}

export function vstr(obj: VdfValue | undefined, ...path: string[]): string | undefined {
  const v = vget(obj, ...path)
  return typeof v === 'string' ? v : undefined
}
