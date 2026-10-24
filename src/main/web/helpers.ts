// Small scripts that run in a download page (in an isolated world) to show the user which button to press.
// They only read the page and highlight; the click is always the user's own, as the sites' rules require.

export type PageHelper = 'nexus' | 'moddb'

export interface PageHelperState {
  /** Which button is highlighted right now ('' = none found yet). */
  step: string
  loggedOut: boolean
}

export const MARK = `
const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
// Sites like Nexus render their download buttons inside web components, so searches go through open shadow roots too.
const all = (sel, root = document, out = []) => {
  out.push(...root.querySelectorAll(sel));
  for (const host of root.querySelectorAll('*')) if (host.shadowRoot) all(sel, host.shadowRoot, out);
  return out;
};
const find = (re) => all('button, a, [role="button"]').find((e) => visible(e) && re.test(txt(e)));
const mark = (el, label) => {
  // The page re-renders now and then and drops the outline or the tip; mark again whenever anything is missing.
  if (!el || (el.dataset.nexusforge === label && el.style.outline && document.getElementById('nexusforge-tip'))) return;
  all('[data-nexusforge]').forEach((x) => { x.style.outline = ''; x.style.boxShadow = ''; delete x.dataset.nexusforge; });
  document.getElementById('nexusforge-tip')?.remove();
  el.dataset.nexusforge = label;
  el.style.outline = '3px solid #a78bfa';
  el.style.outlineOffset = '3px';
  el.style.boxShadow = '0 0 0 10px rgba(167,139,250,.28)';
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const tip = document.createElement('div');
  tip.id = 'nexusforge-tip';
  tip.textContent = label;
  tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:14px;transform:translateX(-50%);background:#7c3aed;color:#fff;font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:none';
  document.body.appendChild(tip);
};`

const NEXUS = `(() => {
${MARK}
// Refuse optional cookies so the banner doesn't cover the page.
const deny = document.querySelector('#CybotCookiebotDialogBodyButtonDecline');
if (deny && visible(deny)) deny.click();
// Nexus only shows a "Log in" button to visitors; downloading needs a (free) account.
const login = find(/^log ?in$/i);
const loggedOut = !!login;
// Button texts can carry extra lines ("Slow download\\nFree"), so only the start has to match.
const slow = find(/^slow download\\b/i);
const manual = slow ? null : find(/^manual( download)?\\b/i);
if (loggedOut && (slow || manual)) mark(login, 'Log in first (free account, only once), then click “Slow download”');
else if (slow) mark(slow, 'Click “Slow download”: NexusForge installs the file right after');
else if (manual) mark(manual, 'Click “Manual download”');
return { step: slow ? 'slow' : manual ? 'manual' : '', loggedOut };
})()`

const MODDB = `(() => {
${MARK}
const link = [...document.querySelectorAll('a[href*="/downloads/mirror/"], a[href*="/downloads/start/"]')].find(visible);
if (link) mark(link, 'Click this download link');
return { step: link ? 'link' : '', loggedOut: false };
})()`

export const PAGE_HELPERS: Record<PageHelper, { script: string; hint(state: PageHelperState): string | undefined }> = {
  nexus: {
    script: NEXUS,
    hint: (s) =>
      s.loggedOut
        ? 'Log in with your free Nexus Mods account (only needed once; NexusForge remembers it), then click the highlighted “Slow download”.'
        : s.step === 'slow'
          ? 'Click the highlighted “Slow download” button. NexusForge downloads and installs the file by itself.'
          : s.step === 'manual'
            ? 'Click the highlighted “Manual download”, then “Slow download”.'
            : undefined
  },
  moddb: {
    script: MODDB,
    hint: (s) => (s.step === 'link' ? 'ModDB is preparing the file. If it doesn’t start, click the highlighted link.' : undefined)
  }
}
