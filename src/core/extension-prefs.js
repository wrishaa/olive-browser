// Per-extension preferences (pure): blocking on/off and whether the extension's
// button is shown in Olive's sidebar toolbar. Toolbar buttons default to hidden;
// hiding a button never changes what the extension does.
const DEFAULTS = Object.freeze({ enabled: true, showInToolbar: false });
function parsePrefs(raw) {
  let data = {};
  try { data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { data = {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return { enabled: data.enabled !== false, showInToolbar: data.showInToolbar === true };
}
function serializePrefs(prefs) {
  const p = parsePrefs(prefs);
  return JSON.stringify({ enabled: p.enabled, showInToolbar: p.showInToolbar });
}
function applyChange(prefs, key, value) {
  const p = parsePrefs(prefs);
  if (!['enabled', 'showInToolbar'].includes(key)) throw new Error('unknown extension setting');
  if (typeof value !== 'boolean') throw new Error('extension setting must be boolean');
  return { ...p, [key]: value };
}
function toolbarVisible(status, isPrivate = false) {
  return !isPrivate && !!status && status.showInToolbar === true;
}
// Rows for the Extensions settings page: only fields that page shows.
function extensionRows(statuses) {
  return (statuses || []).filter(Boolean).map(s => ({
    id: s.id || null, name: s.name || 'Extension', version: s.version || '', icon: s.icon || null,
    installed: !!s.installed, enabled: !!s.enabled, showInToolbar: s.showInToolbar === true,
    hasOptions: !!(s.installed && s.optionsPage), note: s.gap || '', error: s.error || '',
  }));
}
module.exports = { DEFAULTS, parsePrefs, serializePrefs, applyChange, toolbarVisible, extensionRows };
