const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
let handler;
const original = Module._load;
Module._load = function(id, ...rest) {
  if (id === 'electron') return { ipcMain: { handle: (name, fn) => { assert.equal(name, 'olive:profiles'); handler = fn; } } };
  return original.call(this, id, ...rest);
};
const { ProfileControls } = require('../src/main/profile-controls');
Module._load = original;
const { fakeBrowser, FakeWindow, eventFrom } = require('./helpers/fake-browser');

test('olive://profiles is a tab: focused if open, ipc only from its main frame', async () => {
  let switched = null;
  const mgr = fakeBrowser({ broadcast() {}, switchProfile: async id => { switched = id; }, profiles: { list: () => [{ id: 'default', name: 'Default', active: true }], create: () => ({ id: 'new' }), rename() {} } });
  const one = new FakeWindow(mgr), two = new FakeWindow(mgr);
  mgr.focused = one;
  const controls = new ProfileControls(mgr);
  const tab = controls.show();
  assert.equal(tab.url, 'olive://profiles'); assert.ok(one.tabs.has(tab.id));
  mgr.focused = two;
  assert.equal(controls.show(), tab, 'any window: the open profiles tab is focused');
  await assert.rejects(handler({ sender: {} }, 'get'), /Not a profile settings page/);
  await assert.rejects(handler(eventFrom(tab, {}), 'get'), /Not a profile settings page/);
  const web = two.createTab({ url: 'https://example.com/' });
  await assert.rejects(handler(eventFrom(web), 'get'), /Not a profile settings page/);
  assert.equal((await handler(eventFrom(tab), 'get')).profiles[0].id, 'default');
  await handler(eventFrom(tab), 'switch', { id: 'default' }); assert.equal(switched, 'default');
  assert.match((await handler(eventFrom(tab), 'close')).error, /Unknown profile action/, 'no close: it is a tab');
  one.navigate(tab, 'olive://ledger');
  await assert.rejects(handler(eventFrom(tab), 'get'), /Not a profile settings page/);
});
