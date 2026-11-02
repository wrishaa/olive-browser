// olive:// addresses for the settings page. only the cmd+l palette reads them (no protocol
// handler: web pages can't link here). olive://settings, olive://settings/<tab>, plus the old
// page names as aliases (olive://shortcuts, olive://extensions, olive://activities, ...).
const TABS = Object.freeze(['general', 'shortcuts', 'activities', 'extensions']);
const TAB_TITLES = Object.freeze({ general: 'General', shortcuts: 'Keyboard Shortcuts', activities: 'Activities', extensions: 'Extensions' });
const ALIASES = Object.freeze({
  settings: 'general', preferences: 'general', general: 'general', unloading: 'general', permissions: 'general',
  shortcuts: 'shortcuts', keyboard: 'shortcuts',
  activities: 'activities', activity: 'activities', 'site-time': 'activities',
  extensions: 'extensions',
});

// -> { tab, section? } or null. 'olive:settings' (no slashes) is accepted too.
function parseSettingsUrl(raw) {
  const m = /^olive:(?:\/\/)?([a-z-]+)(?:\/([a-z-]*))?\/?(?:[?#].*)?$/i.exec(String(raw || '').trim());
  if (!m) return null;
  const host = m[1].toLowerCase(), sub = (m[2] || '').toLowerCase();
  if (host === 'settings') {
    if (!sub) return { tab: 'general' };
    if (TABS.includes(sub)) return { tab: sub };
    const alias = ALIASES[sub];
    return alias ? { tab: alias, ...(sub === 'unloading' || sub === 'permissions' ? { section: sub } : {}) } : null;
  }
  if (sub || !ALIASES[host]) return null;
  return { tab: ALIASES[host], ...(host === 'unloading' || host === 'permissions' ? { section: host } : {}) };
}

function settingsUrl(tab) { return tab && tab !== 'general' ? `olive://settings/${tab}` : 'olive://settings'; }
function validTab(tab) { return TABS.includes(tab) ? tab : 'general'; }

module.exports = { TABS, TAB_TITLES, parseSettingsUrl, settingsUrl, validTab };
