const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TU = require('../src/core/tab-unload');
const { loadSettings, saveSettings, normalizeSetting, DEFAULTS } = require('../src/core/app-settings');

const MIN = 60000;
const NOW = 10_000 * MIN;
// a loaded background tab idle for `idle` minutes
const tab = (id, idle, extra = {}) => ({ id, pinned: false, loaded: true, lastActive: NOW - idle * MIN, ...extra });
const ids = r => r.map(x => x.id);

test('defaults: non-pinned 120 min, pinned 480 min, cap off', () => {
  assert.deepEqual({ ...TU.DEFAULTS }, { unloadAfterMinutes: 120, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 0 });
  const tabs = [tab(1, 119), tab(2, 120), tab(3, 300, { pinned: true }), tab(4, 480, { pinned: true }), tab(5, 9999)];
  assert.deepEqual(TU.plan(tabs, TU.DEFAULTS, { now: NOW }), [{ id: 2, reason: 'idle' }, { id: 4, reason: 'idle' }, { id: 5, reason: 'idle' }]);
});

test('custom values and 0 = never', () => {
  const tabs = [tab(1, 10), tab(2, 50, { pinned: true }), tab(3, 4)];
  assert.deepEqual(ids(TU.plan(tabs, { unloadAfterMinutes: 5, pinnedUnloadAfterMinutes: 45, maxLoadedTabs: 0 }, { now: NOW })), [1, 2]);
  assert.deepEqual(ids(TU.plan(tabs, { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 45, maxLoadedTabs: 0 }, { now: NOW })), [2]);
  assert.deepEqual(ids(TU.plan(tabs, { unloadAfterMinutes: 5, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 0 }, { now: NOW })), [1]);
  assert.deepEqual(TU.plan([tab(1, 1e6), tab(2, 1e6, { pinned: true })], { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 0 }, { now: NOW }), []);
});

test('idle counts from the latest of activation, last on screen and load', () => {
  const s = { unloadAfterMinutes: 60, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 0 };
  assert.deepEqual(ids(TU.plan([tab(1, 500, { loadedAt: NOW - 10 * MIN })], s, { now: NOW })), [], 'opened in the background 10 min ago');
  assert.deepEqual(ids(TU.plan([tab(1, 500, { lastVisible: NOW - 10 * MIN })], s, { now: NOW })), [], 'split pane on screen 10 min ago');
  assert.deepEqual(ids(TU.plan([{ id: 1, loaded: true, lastActive: 0 }], s, { now: NOW })), [1]);
  assert.deepEqual(TU.plan([tab(1, 500, { loaded: false })], s, { now: NOW }), [], 'already unloaded');
});

test('max loaded: off by default, oldest-idle non-pinned first, pinned only if still over', () => {
  const s = { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 3 };
  const tabs = [tab(1, 5), tab(2, 50), tab(3, 20), tab(4, 900, { pinned: true }), tab(5, 1, { visible: true })];
  // 5 loaded, cap 3: evict the 2 oldest non-pinned (2 then 3), the much older pinned tab stays
  assert.deepEqual(TU.plan(tabs, s, { now: NOW }), [{ id: 2, reason: 'max' }, { id: 3, reason: 'max' }]);
  // cap 1: all non-pinned candidates go, then the pinned one; the visible tab never
  assert.deepEqual(ids(TU.plan(tabs, { ...s, maxLoadedTabs: 1 }, { now: NOW })), [2, 3, 1, 4]);
  const pins = [tab(1, 5, { pinned: true }), tab(2, 50, { pinned: true }), tab(3, 1)];
  assert.deepEqual(ids(TU.plan(pins, { ...s, maxLoadedTabs: 1 }, { now: NOW })), [3, 2]);
  assert.deepEqual(TU.plan(tabs, { ...s, maxLoadedTabs: 0 }, { now: NOW }), [], 'cap off');
  // idle unloads count toward the cap first
  assert.deepEqual(TU.plan(tabs, { ...s, unloadAfterMinutes: 40, maxLoadedTabs: 3 }, { now: NOW }), [{ id: 2, reason: 'idle' }, { id: 3, reason: 'max' }]);
});

test('every exemption keeps an idle tab and is skipped by the cap', () => {
  const s = { unloadAfterMinutes: 1, pinnedUnloadAfterMinutes: 1, maxLoadedTabs: 1 };
  for (const reason of TU.EXEMPT) {
    const t = tab(1, 1e5, { [reason]: true });
    assert.equal(TU.exemptReason(t), reason);
    assert.deepEqual(TU.plan([t, tab(2, 0.1, { visible: true })], s, { now: NOW }), [], reason);
    assert.deepEqual(TU.plan([t, tab(2, 0.1, { visible: true })], s, { now: NOW, olderThanMinutes: 0 }), [], `${reason} (agent api)`);
    assert.ok(TU.EXEMPT_LABELS[reason]);
  }
  assert.deepEqual(TU.EXEMPT, ['visible', 'loading', 'audible', 'capturing', 'agent', 'devtools', 'dirty']);
});

test('agent api olderThanMinutes overrides both thresholds, 0 = all background', () => {
  const tabs = [tab(1, 10), tab(2, 10, { pinned: true }), tab(3, 2), tab(4, 1, { visible: true })];
  assert.deepEqual(ids(TU.plan(tabs, TU.DEFAULTS, { now: NOW, olderThanMinutes: 5 })), [1, 2]);
  assert.deepEqual(ids(TU.plan(tabs, { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 0 }, { now: NOW, olderThanMinutes: 0 })), [1, 2, 3]);
});

test('normalize: whole minutes, empty = 0, rejects junk', () => {
  assert.equal(TU.normalize('unloadAfterMinutes', '45'), 45);
  assert.equal(TU.normalize('maxLoadedTabs', ''), 0);
  assert.equal(TU.normalize('maxLoadedTabs', null), 0);
  for (const bad of [-1, 1.5, 'abc', NaN, Infinity, {}, '1e9']) assert.throws(() => TU.normalize('unloadAfterMinutes', bad), String(bad));
  assert.throws(() => TU.normalize('maxLoadedTabs', 501));
  assert.throws(() => TU.normalize('nope', 1));
  assert.equal(normalizeSetting('cdp', true), true);
  assert.throws(() => normalizeSetting('agentApi', 'yes'));
});

test('legacy migration: discardMinutes and the old cap default', () => {
  const m = raw => TU.migrate(raw).settings;
  // no settings at all
  assert.deepEqual(pick(m({})), TU.DEFAULTS);
  // old defaults (30 / 16): ignored, cap goes off
  assert.deepEqual(pick(m({ discardMinutes: 30, maxLoadedTabs: 16 })), TU.DEFAULTS);
  // user-set discardMinutes becomes the non-pinned threshold, once; pinned keeps its default
  const x = m({ discardMinutes: 45, maxLoadedTabs: 8, cdp: true });
  assert.deepEqual(pick(x), { unloadAfterMinutes: 45, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 8 });
  assert.equal(x.cdp, true); assert.equal('discardMinutes' in x, false); assert.equal(x.tabUnloadVersion, TU.VERSION);
  assert.equal(m({ discardMinutes: 0 }).unloadAfterMinutes, 0, 'discarding was off: stays off');
  // already migrated: an explicit 16 is the user's choice now and stays
  assert.equal(m({ tabUnloadVersion: 1, maxLoadedTabs: 16 }).maxLoadedTabs, 16);
  assert.equal(TU.migrate({ tabUnloadVersion: 1, maxLoadedTabs: 16, unloadAfterMinutes: 120, pinnedUnloadAfterMinutes: 480 }).changed, false);
  // a new key already present wins over the legacy one
  assert.equal(m({ discardMinutes: 45, unloadAfterMinutes: 90 }).unloadAfterMinutes, 90);
  // junk falls back to defaults
  assert.deepEqual(pick(m({ unloadAfterMinutes: -3, pinnedUnloadAfterMinutes: 'x', maxLoadedTabs: 2.5, tabUnloadVersion: 1 })), TU.DEFAULTS);
  assert.deepEqual(pick(m(null)), TU.DEFAULTS);
});

test('settings.json persists across a relaunch (write, read back)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-unload-'));
  const file = path.join(dir, 'settings.json');
  let { settings, changed } = loadSettings(file);
  assert.equal(changed, false, 'no file: nothing to rewrite');
  assert.deepEqual(pick(settings), TU.DEFAULTS);
  assert.equal(settings.agentApi, true); assert.equal(settings.cdp, false);
  settings.unloadAfterMinutes = 15; settings.pinnedUnloadAfterMinutes = 0; settings.maxLoadedTabs = 16;
  saveSettings(file, settings);
  ({ settings } = loadSettings(file));
  assert.deepEqual(pick(settings), { unloadAfterMinutes: 15, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 16 }, 'explicit 16 survives once migrated');
  // a legacy file from before this change
  fs.writeFileSync(file, JSON.stringify({ cdp: true, agentApi: false, discardMinutes: 30, maxLoadedTabs: 16 }));
  ({ settings, changed } = loadSettings(file));
  assert.equal(changed, true);
  assert.deepEqual(pick(settings), TU.DEFAULTS);
  assert.equal(settings.cdp, true); assert.equal(settings.agentApi, false);
  saveSettings(file, settings);
  ({ settings, changed } = loadSettings(file));
  assert.equal(changed, false, 'migrates once');
  assert.deepEqual(Object.keys(DEFAULTS).sort(), ['agentApi', 'cdp', 'maxLoadedTabs', 'pinnedUnloadAfterMinutes', 'unloadAfterMinutes']);
  fs.rmSync(dir, { recursive: true, force: true });
});

function pick(s) { return { unloadAfterMinutes: s.unloadAfterMinutes, pinnedUnloadAfterMinutes: s.pinnedUnloadAfterMinutes, maxLoadedTabs: s.maxLoadedTabs }; }
