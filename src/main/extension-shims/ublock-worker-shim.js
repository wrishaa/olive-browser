// Olive shim for uBO Lite's service worker (copied into the profile-local
// extension as olive/worker-shim.js; the vendored CWS bytes stay untouched).
// Electron's extension worker has no chrome.permissions, chrome.windows or
// chrome.commands, so uBOL's background.js threw on its first line touching
// them and never answered the dashboard. These stand-ins only report what the
// manifest already grants; they never grant anything new.
// uBOL uses self.browser when present (Electron defines it), else self.chrome.
const targets = [globalThis.browser, globalThis.chrome].filter((t, i, a) => t && a.indexOf(t) === i);
const api = targets[0];
const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; }, hasListeners() { return false; } });
const define = (name, value) => {
  for (const t of targets) {
    if (t[name]) continue;
    Object.defineProperty(t, name, { value, configurable: true, enumerable: true, writable: true });
  }
};
const manifest = api.runtime.getManifest();
const granted = () => ({
  permissions: [...(manifest.permissions || [])],
  origins: [...(manifest.host_permissions || [])],
});
const covered = (req = {}) => {
  const g = granted();
  const all = g.origins.includes('<all_urls>') || g.origins.includes('*://*/*');
  return (req.permissions || []).every(p => g.permissions.includes(p))
    && (req.origins || []).every(o => all || g.origins.includes(o));
};
define('permissions', {
  getAll: async () => granted(),
  contains: async req => covered(req),
  // No prompt in Olive: a request succeeds only for what the manifest grants.
  request: async req => covered(req),
  remove: async () => false,
  onAdded: event(),
  onRemoved: event(),
});
define('commands', { onCommand: event(), getAll: async () => [] });
// uBOL opens its pages (report, picker windows) via windows.*; Olive shows
// extension pages inline, so window management is a no-op that never throws.
define('windows', {
  WINDOW_ID_CURRENT: -2,
  create: async () => ({ id: -1, tabs: [] }),
  update: async () => ({ id: -1 }),
  get: async () => ({ id: -1, focused: true }),
  getCurrent: async () => ({ id: -1, focused: true }),
  getAll: async () => [],
  onRemoved: event(),
  onFocusChanged: event(),
});

// Olive's on/off switch is authoritative. uBOL re-applies its own ruleset list
// whenever its worker starts a session, which would silently turn blocking back
// on. While Olive has blocking off (storage key below, written by Olive), the
// worker sees a virtual ruleset list and the real static rulesets stay off.
// Olive restores that list when blocking is turned back on.
const KEY = 'oliveBlocking';
const storage = api.storage.local;
const gate = async () => (await storage.get(KEY))[KEY];
for (const t of targets) {
  const dnr = t.declarativeNetRequest;
  if (!dnr || dnr.__olive) continue;
  const update = dnr.updateEnabledRulesets.bind(dnr);
  const get = dnr.getEnabledRulesets.bind(dnr);
  const patch = (name, value) => Object.defineProperty(dnr, name, { value, configurable: true, writable: true });
  patch('updateEnabledRulesets', async (options = {}) => {
    const g = await gate();
    if (g?.enabled !== false) return update(options);
    const set = new Set(g.rulesets || []);
    for (const id of options.disableRulesetIds || []) set.delete(id);
    for (const id of options.enableRulesetIds || []) set.add(id);
    await storage.set({ [KEY]: { enabled: false, rulesets: [...set] } });
    if (options.disableRulesetIds?.length) await update({ disableRulesetIds: options.disableRulesetIds });
  });
  patch('getEnabledRulesets', async () => {
    const g = await gate();
    return g?.enabled === false ? [...(g.rulesets || [])] : get();
  });
  patch('__olive', true);
}
