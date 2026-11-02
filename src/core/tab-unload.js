// Tab unloading ("discarding"): which loaded background tabs give their renderer back.
// Pure logic, no electron. src/main/main.js gathers the tab facts and calls plan().
//
// settings (settings.json, see notes/settings-and-unloading.md):
//   unloadAfterMinutes        non-pinned tabs idle this long unload. 0 = never. default 120
//   pinnedUnloadAfterMinutes  pinned tabs idle this long unload. 0 = never. default 480
//   maxLoadedTabs             cap on loaded tabs across all windows. 0 = off (default)
//
// never unloaded (exempt): on screen (active tab / any split pane, every window), playing
// audio, capturing camera / mic / screen, driven by an agent (debugger attached or an agent
// step running), devtools open, unsaved typing in a form field, still loading.

const DEFAULTS = Object.freeze({ unloadAfterMinutes: 120, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 0 });
const KEYS = Object.keys(DEFAULTS);
const LIMITS = Object.freeze({ unloadAfterMinutes: 60 * 24 * 30, pinnedUnloadAfterMinutes: 60 * 24 * 30, maxLoadedTabs: 500 });
// the settings.json shape this module understands; older files get migrate()d once
const VERSION = 1;
const LEGACY_DISCARD_DEFAULT = 30; // old discardMinutes default (one threshold for every tab)
const LEGACY_MAX_DEFAULT = 16; // old maxLoadedTabs default (cap on): now means "never chosen"
const PREFILL_MAX = 16; // what the settings page puts in the cap field when the cap is turned on

const EXEMPT = Object.freeze(['visible', 'loading', 'audible', 'capturing', 'agent', 'devtools', 'dirty']);
const EXEMPT_LABELS = Object.freeze({
  visible: 'on screen', loading: 'still loading', audible: 'playing audio', capturing: 'using camera, microphone or screen',
  agent: 'used by an agent', devtools: 'developer tools open', dirty: 'unsaved form input',
});

// '' / null / undefined -> 0 (never / off). throws on anything else that isn't a whole number in range.
function normalize(key, value) {
  if (!KEYS.includes(key)) throw new Error(`unknown tab unloading setting: ${key}`);
  if (value === '' || value == null || value === false) return 0;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || Math.floor(n) !== n) throw new Error('Enter a whole number, 0 or more.');
  if (n > LIMITS[key]) throw new Error(`Enter ${LIMITS[key]} or less.`);
  return n;
}

// one-time upgrade of a settings object read from disk. returns { settings, changed }.
// - discardMinutes (old, one threshold for all tabs): its old default 30 or absent is
//   ignored; any other value the user had set becomes unloadAfterMinutes, once.
// - maxLoadedTabs 16 was the old default (cap on). stored 16 from before = never chosen,
//   so the cap goes off. other stored values are the user's and stay.
// - bad values fall back to the defaults.
function migrate(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  let changed = false;
  if (s.tabUnloadVersion !== VERSION) {
    if (!Object.hasOwn(s, 'unloadAfterMinutes') && Object.hasOwn(s, 'discardMinutes')) {
      const legacy = Number(s.discardMinutes);
      if (Number.isInteger(legacy) && legacy >= 0 && legacy !== LEGACY_DISCARD_DEFAULT && legacy <= LIMITS.unloadAfterMinutes) s.unloadAfterMinutes = legacy;
    }
    if (s.maxLoadedTabs === LEGACY_MAX_DEFAULT) delete s.maxLoadedTabs;
    delete s.discardMinutes;
    s.tabUnloadVersion = VERSION;
    changed = true;
  }
  for (const key of KEYS) {
    if (!Object.hasOwn(s, key)) { s[key] = DEFAULTS[key]; continue; }
    try { s[key] = normalize(key, s[key]); } catch { s[key] = DEFAULTS[key]; changed = true; }
  }
  return { settings: s, changed };
}

function exemptReason(t) {
  for (const reason of EXEMPT) if (t[reason]) return reason;
  return null;
}

// idle since: the later of last activation, last time on screen, and when it was loaded
// (a background tab opened a minute ago is not "idle for hours" because it was never activated)
function idleMs(t, now) {
  return now - Math.max(t.lastActive || 0, t.lastVisible || 0, t.loadedAt || 0);
}

// tabs: [{ id, pinned, loaded, lastActive, lastVisible?, loadedAt?, visible?, loading?, audible?,
//          capturing?, agent?, devtools?, dirty? }]
// settings: { unloadAfterMinutes, pinnedUnloadAfterMinutes, maxLoadedTabs }
// olderThanMinutes (agent api POST /discard): one threshold for pinned and non-pinned tabs
// instead of the settings, 0 = every non-exempt background tab. exemptions always apply.
// returns [{ id, reason: 'idle' | 'max' }] in unload order.
function plan(tabs, settings = DEFAULTS, { now = Date.now(), olderThanMinutes = null } = {}) {
  const min = Number(settings.unloadAfterMinutes) || 0;
  const pinnedMin = Number(settings.pinnedUnloadAfterMinutes) || 0;
  const max = Number(settings.maxLoadedTabs) || 0;
  const loaded = tabs.filter(t => t.loaded);
  const candidates = loaded.filter(t => !exemptReason(t));
  const out = [];
  const gone = new Set();
  for (const t of candidates) {
    let threshold;
    if (olderThanMinutes != null) threshold = Math.max(0, Number(olderThanMinutes) || 0);
    else {
      threshold = t.pinned ? pinnedMin : min;
      if (!(threshold > 0)) continue; // 0 = never
    }
    if (idleMs(t, now) >= threshold * 60000) { out.push({ id: t.id, reason: 'idle' }); gone.add(t.id); }
  }
  if (max > 0) {
    let count = loaded.length - gone.size;
    // oldest-idle non-pinned first; pinned (oldest-idle first) only if still over the cap
    const order = candidates.filter(t => !gone.has(t.id)).sort((a, b) => (a.pinned - b.pinned) || (idleMs(b, now) - idleMs(a, now)));
    for (const t of order) {
      if (count <= max) break;
      out.push({ id: t.id, reason: 'max' });
      count--;
    }
  }
  return out;
}

module.exports = { DEFAULTS, KEYS, LIMITS, VERSION, PREFILL_MAX, LEGACY_DISCARD_DEFAULT, LEGACY_MAX_DEFAULT, EXEMPT, EXEMPT_LABELS, normalize, migrate, exemptReason, idleMs, plan };
