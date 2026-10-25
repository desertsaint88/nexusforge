// Matching game names against store titles ("Hell.Let.Loose.Vietnam" folder vs "Hell Let Loose: Vietnam").

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
}

/** Short names people (and release groups) use for long titles. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/^fnaf\b/i, "Five Nights at Freddy's"],
  [/^gta\s*(v|5)\b/i, 'Grand Theft Auto V'],
  [/^gta\b/i, 'Grand Theft Auto'],
  [/^rdr\s*2\b/i, 'Red Dead Redemption 2'],
  [/^cod\b/i, 'Call of Duty'],
  [/^bo\s*3\b/i, 'Call of Duty: Black Ops III'],
  [/^hll\b/i, 'Hell Let Loose'],
  [/^cs\s*2\b/i, 'Counter-Strike 2'],
  [/^tes\b/i, 'The Elder Scrolls'],
  [/^ets\s*2\b/i, 'Euro Truck Simulator 2'],
  [/^ats\b/i, 'American Truck Simulator'],
  [/^ksp\b/i, 'Kerbal Space Program']
]

const EDITION = /^(the)?(legacy|enhanced|enhancededition|definitiveedition|remastered|remaster|goty|gameoftheyear|gameoftheyearedition|completeedition|deluxeedition|edition|directorscut|anniversaryedition|\d{4})$/
const TEST_BUILD = /\s+(demo|playtest|prologue|beta|public test)$/i

/** Store search terms for a game name, most specific first. */
export function storeQueries(name: string): string[] {
  const out: string[] = []
  const add = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t.length >= 2 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  const base = name
    .replace(/[™®©]/g, '')
    .replace(/\s*[([](19|20)\d\d[)\]]\s*/g, ' ')
    .replace(/\s+-\s+/g, ': ')
    .trim()
  add(base)
  // Executable and folder names glue words and numbers together ("Cyberpunk2077", "WatchDogs2").
  add(base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2'))
  for (const [re, long] of ABBREVIATIONS) if (re.test(base)) add(base.replace(re, long))
  for (const q of [...out]) if (TEST_BUILD.test(q)) add(q.replace(TEST_BUILD, ''))
  for (const q of [...out]) add(q.replace(/:/g, ''))
  return out
}

/**
 * How well a store title matches what we know the game as: 'exact' when only punctuation, case or ™ differ,
 * 'edition' for an edition/demo suffix, undefined when it's a different game (sequel, DLC, soundtrack…).
 */
export function matchKind(wanted: string, title: string): 'exact' | 'edition' | undefined {
  const a = norm(wanted)
  const b = norm(title)
  if (!a || !b) return undefined
  if (a === b) return 'exact'
  const strip = (s: string) => s.replace(/(demo|playtest|prologue)$/, '')
  if (strip(a) === strip(b) && strip(a).length >= 3) return 'edition'
  if (b.startsWith(a)) return EDITION.test(b.slice(a.length)) ? 'edition' : undefined
  if (a.startsWith(b)) return EDITION.test(a.slice(b.length)) || /^(demo|playtest|prologue)$/.test(a.slice(b.length)) ? 'edition' : undefined
  return undefined
}
