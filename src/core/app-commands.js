// Omnibar destinations are local app actions, never URL/search history.
const APP_COMMANDS = Object.freeze([
  { id: 'activities', title: 'Activities — Site Time', sub: 'Time spent on each site · on this Mac', terms: ['activities', 'activity', 'site time', 'screen time', 'time spent', 'usage', 'stats', 'statistics'] },
  { id: 'shortcuts', title: 'Keyboard Shortcuts', sub: 'Settings · view and remap shortcuts', terms: ['shortcuts', 'shortcut', 'keyboard', 'keys', 'remap', 'settings', 'preferences'] },
  { id: 'profiles', title: 'Profiles', sub: 'Separate tabs, sign-ins and site settings', terms: ['profiles', 'profile', 'settings', 'preferences'] },
  { id: 'sitePermissions', title: 'Site Settings', sub: 'Permissions for the current site', terms: ['settings', 'site settings', 'permissions', 'camera', 'microphone'] },
  { id: 'importBrowser', title: 'Import from Browser', sub: 'Signed-in sessions from Chrome, Brave, Edge or Arc', terms: ['import', 'import from browser', 'browser import', 'chrome', 'brave', 'edge', 'arc', 'cookies', 'sign-ins'] },
  { id: 'onboarding', title: 'Set Up Olive', sub: 'Calls, screen sharing and browser import', terms: ['setup', 'set up', 'import', 'onboarding'] },
  { id: 'ledger', title: 'Activity Event Log', sub: 'Local browsing-event metadata', terms: ['event log', 'ledger', 'activity log'] },
]);
const ids = new Set(APP_COMMANDS.map(c => c.id));
function isAppCommand(id) { return ids.has(id); }
function commandSuggestions(query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return APP_COMMANDS.slice(0, 2).map(item);
  // Domain-like input stays a URL; never turn e.g. settings.example into a command.
  if (/[.:/]/.test(q)) return [];
  return APP_COMMANDS.map(c => ({ c, score: Math.max(...c.terms.map(t => t === q ? 100 : t.startsWith(q) ? 60 : t.split(' ').some(word => word.startsWith(q)) ? 30 : 0)) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, 4).map(x => item(x.c));
}
function item(c) { return { kind: 'command', commandId: c.id, title: c.title, sub: c.sub }; }
module.exports = { APP_COMMANDS, commandSuggestions, isAppCommand };
