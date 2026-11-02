// olive:// addresses: Olive's own pages are normal tabs with real urls (served by the olive
// scheme handler, src/main/internal-pages.js). Pure: no electron, no fs.
//
//   olive://settings                         Settings > General
//   olive://settings/general|shortcuts|activities|extensions[?section=..]
//   olive://extensions                       -> olive://settings/extensions
//   olive://extensions/ublock                Olive's uBO Lite page (on/off, links)
//   olive://extensions/ublock/options        uBO Lite's own dashboard (chrome-extension page,
//   olive://extensions/ublock/dashboard        loaded in the tab; the address bar keeps the
//   olive://extensions/ublock/popup            olive:// url, never chrome-extension://)
//   olive://ledger                           Activity Event Log
//   olive://profiles                         Profiles
//   olive://onboarding[/<step>]              Set Up Olive (the step in the url follows the
//                                            saved step; main owns it)
//   olive://site-settings?origin=<origin>    -> Settings > General > Site permissions
//   old page names (olive://shortcuts, olive://activities, olive://unloading, ...) redirect.
const TABS = Object.freeze(['general', 'shortcuts', 'activities', 'extensions']);
const TAB_TITLES = Object.freeze({ general: 'General', shortcuts: 'Keyboard Shortcuts', activities: 'Activities', extensions: 'Extensions' });
const SETTINGS_FILES = Object.freeze({ general: 'settings-general.html', shortcuts: 'shortcuts.html', activities: 'site-time.html', extensions: 'extensions.html' });
const ONBOARDING_STEPS = Object.freeze(['welcome', 'calls', 'import', 'screen', 'done']);
const SECTIONS = Object.freeze(['unloading', 'permissions', 'agent']);
const PAGES = Object.freeze({ ledger: 'ledger.html', profiles: 'profiles.html' });
const TITLES = Object.freeze({ settings: 'Settings', extensions: 'uBO Lite', ledger: 'Activity Event Log', profiles: 'Profiles', onboarding: 'Set Up Olive' });
// old names -> where they live now
const HOST_ALIASES = Object.freeze({
  preferences: ['general'], prefs: ['general'], general: ['general'],
  unloading: ['general', 'unloading'], permissions: ['general', 'permissions'],
  shortcuts: ['shortcuts'], keyboard: ['shortcuts'],
  activities: ['activities'], activity: ['activities'], 'site-time': ['activities'],
});
const SUB_ALIASES = Object.freeze({ unloading: ['general', 'unloading'], permissions: ['general', 'permissions'], preferences: ['general'], keyboard: ['shortcuts'], activity: ['activities'], 'site-time': ['activities'] });
const ASSET = /^[a-z0-9][a-z0-9-]*\.(js|css|svg|png)$/;

function webOrigin(raw) {
  try { const u = new URL(String(raw)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null; } catch { return null; }
}

function settingsUrl(tab = 'general', { section = null, origin = null } = {}) {
  tab = TABS.includes(tab) ? tab : 'general';
  const q = new URLSearchParams();
  if (section && SECTIONS.includes(section)) q.set('section', section);
  const o = origin && webOrigin(origin);
  if (o) q.set('origin', o);
  const qs = q.toString();
  return (tab === 'general' && !qs ? 'olive://settings' : `olive://settings/${tab}`) + (qs ? '?' + qs : '');
}

function isOliveUrl(raw) { return /^olive:/i.test(String(raw || '').trim()); }

// -> null (not ours / unknown) or { url, host, sub, query, kind, ... }
//   kind 'page'     { file, title, tab? (settings), step? (onboarding) }
//   kind 'redirect' { location }
//   kind 'asset'    { asset } (css/js next to the pages; same origin as the page that asked)
//   kind 'extension'{ extension: 'ublock', extensionPath: 'dashboard.html' | 'popup.html' | ... }
function parseOliveUrl(raw) {
  let s = String(raw || '').trim();
  if (!isOliveUrl(s)) return null;
  if (/^olive:(?!\/\/)/i.test(s)) s = 'olive://' + s.slice(6);
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'olive:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return '\0'; } });
  if (parts.some(p => p === '.' || p === '..' || p.includes('\0') || p.includes('/') || p.includes('\\'))) return null;
  const query = Object.fromEntries(u.searchParams);
  const base = { url: u.href, host, sub: parts.join('/'), query, hash: u.hash };
  const last = parts[parts.length - 1] || '';
  if (ASSET.test(last) && !/-preload\.js$/.test(last) && (host in TITLES || host === 'settings')) return { ...base, kind: 'asset', asset: last };
  const redirect = (tab, section) => ({ ...base, kind: 'redirect', location: settingsUrl(tab, { section: section || query.section, origin: query.origin }) });

  if (host === 'settings') {
    if (parts.length === 0) return { ...base, kind: 'page', file: SETTINGS_FILES.general, tab: 'general', title: TITLES.settings };
    if (parts.length > 1) return null;
    const sub = parts[0].toLowerCase();
    if (TABS.includes(sub)) return { ...base, kind: 'page', file: SETTINGS_FILES[sub], tab: sub, title: TITLES.settings };
    if (SUB_ALIASES[sub]) return redirect(...SUB_ALIASES[sub]);
    return null;
  }
  if (HOST_ALIASES[host] && parts.length === 0) return redirect(...HOST_ALIASES[host]);
  if (host === 'site-settings' && parts.length === 0) return redirect('general', 'permissions');
  if (host === 'extensions') {
    if (parts.length === 0) return redirect('extensions');
    if (parts[0] !== 'ublock' || parts.length > 2) return null;
    if (parts.length === 1) return { ...base, kind: 'page', file: 'extension.html', title: TITLES.extensions, extension: 'ublock' };
    const page = parts[1].toLowerCase();
    if (!/^[a-z0-9-]+$/.test(page)) return null;
    const file = page === 'options' || page === 'dashboard' ? 'dashboard.html' : `${page}.html`;
    return { ...base, kind: 'extension', extension: 'ublock', extensionPage: page, extensionPath: file };
  }
  if (PAGES[host] && parts.length === 0) return { ...base, kind: 'page', file: PAGES[host], title: TITLES[host] };
  if (host === 'onboarding' && parts.length <= 1) {
    const step = (parts[0] || '').toLowerCase();
    if (step && !ONBOARDING_STEPS.includes(step)) return null;
    return { ...base, kind: 'page', file: 'onboarding.html', title: TITLES.onboarding, step: step || null };
  }
  return null;
}

// chrome-extension://<id>/<page>.html[?..][#..] -> olive://extensions/ublock/<name>[?..][#..]
function extensionDisplayUrl(raw, extId) {
  if (!extId) return null;
  let u; try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'chrome-extension:' || u.hostname !== extId) return null;
  const m = /^\/([a-z0-9-]+)\.html$/i.exec(u.pathname);
  if (!m) return null;
  const name = m[1].toLowerCase() === 'dashboard' ? 'options' : m[1].toLowerCase();
  return `olive://extensions/ublock/${name}${u.search}${u.hash}`;
}
// olive://extensions/ublock/<name> -> the chrome-extension url to load in the tab
function extensionLoadUrl(raw, extId) {
  const r = parseOliveUrl(raw);
  if (!r || r.kind !== 'extension' || !extId) return null;
  const u = new URL(r.url);
  return `chrome-extension://${extId}/${r.extensionPath}${u.search}${u.hash}`;
}

// a Settings deep link: { tab, section?, origin? } or null (old API, kept for callers)
function parseSettingsUrl(raw) {
  let r = parseOliveUrl(raw);
  if (r?.kind === 'redirect') r = parseOliveUrl(r.location);
  if (!r || r.host !== 'settings' || r.kind !== 'page') return null;
  const out = { tab: r.tab };
  if (r.query.section && SECTIONS.includes(r.query.section)) out.section = r.query.section;
  if (r.query.origin && webOrigin(r.query.origin)) out.origin = webOrigin(r.query.origin);
  return out;
}
function validTab(tab) { return TABS.includes(tab) ? tab : 'general'; }

module.exports = {
  TABS, TAB_TITLES, SETTINGS_FILES, ONBOARDING_STEPS, SECTIONS, TITLES,
  parseOliveUrl, isOliveUrl, settingsUrl, parseSettingsUrl, validTab, webOrigin,
  extensionDisplayUrl, extensionLoadUrl,
};
