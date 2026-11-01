const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/core/extension-prefs');

test('missing or broken prefs: blocking on, toolbar button hidden', () => {
  for (const raw of [undefined, null, '', '{', '[]', '"x"', '{}']) assert.deepEqual(P.parsePrefs(raw), { enabled: true, showInToolbar: false });
});
test('old prefs file with only enabled keeps the toolbar hidden', () => {
  assert.deepEqual(P.parsePrefs('{"enabled":false}'), { enabled: false, showInToolbar: false });
  assert.deepEqual(P.parsePrefs('{"enabled":true}'), { enabled: true, showInToolbar: false });
});
test('only strict true shows the toolbar button', () => {
  assert.equal(P.parsePrefs({ showInToolbar: 'yes' }).showInToolbar, false);
  assert.equal(P.parsePrefs({ showInToolbar: 1 }).showInToolbar, false);
  assert.equal(P.parsePrefs({ showInToolbar: true }).showInToolbar, true);
});
test('serialize round-trips and drops unknown keys', () => {
  const s = P.serializePrefs({ enabled: false, showInToolbar: true, junk: 1 });
  assert.deepEqual(JSON.parse(s), { enabled: false, showInToolbar: true });
  assert.deepEqual(P.parsePrefs(s), { enabled: false, showInToolbar: true });
});
test('applyChange validates key and value', () => {
  assert.deepEqual(P.applyChange({}, 'showInToolbar', true), { enabled: true, showInToolbar: true });
  assert.deepEqual(P.applyChange({ showInToolbar: true }, 'enabled', false), { enabled: false, showInToolbar: true });
  assert.throws(() => P.applyChange({}, 'evil', true));
  assert.throws(() => P.applyChange({}, 'enabled', 'false'));
});
test('toolbarVisible: hidden by default, never in private windows', () => {
  assert.equal(P.toolbarVisible(null), false);
  assert.equal(P.toolbarVisible({ installed: true, enabled: true }), false);
  assert.equal(P.toolbarVisible({ showInToolbar: true }), true);
  assert.equal(P.toolbarVisible({ showInToolbar: true }, true), false);
});
test('extensionRows exposes only page fields', () => {
  const [row] = P.extensionRows([{ id: 'abc', name: 'uBO Lite', version: '1', installed: true, enabled: true, showInToolbar: false, optionsPage: 'dashboard.html', gap: 'g', rulesets: ['x'], storeId: 's' }, null]);
  assert.deepEqual(row, { id: 'abc', name: 'uBO Lite', version: '1', icon: null, installed: true, enabled: true, showInToolbar: false, hasOptions: true, note: 'g', error: '' });
  assert.equal(P.extensionRows([{ installed: false, optionsPage: 'x' }])[0].hasOptions, false);
});
