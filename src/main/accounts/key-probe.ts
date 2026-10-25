import { MARK } from '../web/helpers'

/** What the key page probe needs to know about a site. */
export interface KeyPageDef {
  /** Key patterns, as regex sources. */
  keyPattern: string
  /** Heading near the user's own key ("Personal API Key"), preferred over other keys on the page. */
  section: string
  /**
   * Exact heading of the box that holds the user's own key, when the page has other keys and buttons too
   * (Nexus lists ~60 third-party apps, each with its own "Request Api Key" button, above the personal one).
   * Keys and the create button are then only taken from that box.
   */
  sectionHeading?: string
  /** Button that creates a key when there is none. */
  createButton: string
  /** Page text that means "not signed in". */
  loggedOutText: string
}

export interface KeyPageState {
  keys: string[]
  loggedOut: boolean
  canCreate: boolean
  clicked: boolean
  /** Whether the `sectionHeading` box was found (null without one). */
  section: boolean | null
}

/**
 * Runs in the key page (isolated world): finds key-looking strings, preferring the user's own section. With a
 * `sectionHeading`, only that box counts; `click` presses its create button instead of only highlighting it.
 */
export function keyProbe(def: KeyPageDef, markLabel: string, click = false): string {
  return `(() => {
${MARK}
const KEY = new RegExp(${JSON.stringify(def.keyPattern)}, 'g');
const SECTION = new RegExp(${JSON.stringify(def.section)}, 'i');
const HEADING = ${def.sectionHeading ? `new RegExp(${JSON.stringify(def.sectionHeading)}, 'i')` : 'null'};
const CREATE = new RegExp(${JSON.stringify(def.createButton)}, 'i');
const LOGGED_OUT = new RegExp(${JSON.stringify(def.loggedOutText)}, 'i');
const body = document.body ? (document.body.innerText || '') : '';
const loggedOut = LOGGED_OUT.test(body);
// The user's own box: the smallest element around the heading that also holds a button, field or code.
let box = null;
if (HEADING) {
  const head = all('h1, h2, h3, h4, h5, h6, p, span, div, strong, label, legend').find((el) => HEADING.test(txt(el)) && visible(el));
  for (box = head; box && !box.querySelector('button, [role="button"], input, textarea, code, pre'); ) box = box.parentElement;
}
const within = (sel) => (HEADING ? (box ? all(sel, box) : []) : all(sel));
const preferred = [], other = [];
const push = (s, el) => {
  if (!s) return;
  for (const m of String(s).matchAll(KEY)) {
    let near = !!box;
    for (let p = el, i = 0; !near && p && i < 8; p = p.parentElement || (p.getRootNode && p.getRootNode().host), i++) {
      if (SECTION.test((p.innerText || p.textContent || '').slice(0, 4000))) near = true;
    }
    (near ? preferred : other).push(m[0]);
  }
};
for (const el of within('input, textarea')) push(el.value, el);
for (const el of within('code, pre, kbd, samp, span, p, div, td, li, dd')) if (!el.children.length) push(el.textContent, el);
for (const el of within('[value], [data-key], [data-value], [data-clipboard-text]')) push(el.getAttribute('value') || el.getAttribute('data-key') || el.getAttribute('data-value') || el.getAttribute('data-clipboard-text'), el);
const keys = [...new Set([...preferred, ...other])].slice(0, 8);
let canCreate = false, clicked = false;
if (!keys.length && !loggedOut) {
  const btn = within('button, a, [role="button"]').find((e) => visible(e) && CREATE.test(txt(e)));
  if (btn) {
    canCreate = true;
    mark(btn, ${JSON.stringify(markLabel)});
    if (${click ? 'true' : 'false'} && !btn.disabled) { btn.click(); clicked = true; }
  }
}
return { keys, loggedOut, canCreate, clicked, section: HEADING ? !!box : null };
})()`
}
