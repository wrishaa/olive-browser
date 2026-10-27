const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
let handler;
class Panel extends EventEmitter {
  constructor(owner, options) {
    super(); owner.appPanel?.close(); owner.appPanel = this;
    this.owner = owner; this.options = options; this.dead = false;
    this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
    this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
  }
  close() { this.dead = true; this.emit('closed'); }
  isDestroyed() { return this.dead; }
  setMenu() {} show() {} focus() {} loadFile(file) { this.file = file; }
}
const original = Module._load;
Module._load = function(id, ...rest) {
  if (id === 'electron') return { ipcMain: { handle: (name, fn) => { assert.equal(name, 'olive:profiles'); handler = fn; } } };
  if (id === './app-panel') return { AppPanel: Panel };
  return original.call(this, id, ...rest);
};
const { ProfileControls } = require('../src/main/profile-controls');
Module._load = original;

test('profiles embed in focused Olive owner, authenticate main frame, and follow owner changes', async () => {
  const one = { win: { isDestroyed: () => false } }, two = { win: { isDestroyed: () => false } };
  let owner = one, switched = null;
  const mgr = { focusedWindow: () => owner, broadcast() {}, switchProfile: async id => { switched = id; }, profiles: { list: () => [{ id: 'default', name: 'Default', active: true }], create: () => ({ id: 'new' }), rename() {} } };
  const controls = new ProfileControls(mgr);
  controls.show();
  const view = controls.view;
  assert.equal(view.owner, one); assert.equal(view.options.title, 'profiles');
  assert.equal(view.openHandler().action, 'deny');
  let blocked = false; view.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }); assert.ok(blocked);
  controls.show(); assert.equal(controls.view, view);
  await assert.rejects(handler({ sender: {} }, 'get'), /Not a profile settings window/);
  await assert.rejects(handler({ sender: view.webContents, senderFrame: {} }, 'get'), /Not a profile settings window/);
  const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  assert.equal((await handler(event, 'get')).profiles[0].id, 'default');
  await handler(event, 'switch', { id: 'default' }); assert.equal(switched, 'default');
  owner = two; controls.show(); assert.ok(view.isDestroyed()); assert.equal(controls.view.owner, two);
  await assert.rejects(handler(event, 'get'), /Not a profile settings window/);
  const latest = controls.view;
  await assert.rejects(handler({ sender: latest.webContents, senderFrame: {} }, 'close'), /Not a profile settings window/);
  assert.equal(latest.isDestroyed(), false);
  await handler({ sender: latest.webContents, senderFrame: latest.webContents.mainFrame }, 'close');
  assert.equal(controls.view, null);
  owner = null; controls.show(); assert.equal(controls.view, null);
});
