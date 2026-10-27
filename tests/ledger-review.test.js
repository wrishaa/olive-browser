const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const { Ledger } = require('../src/core/ledger');
const fs = require('fs');
const os = require('os');
const path = require('path');
let seq = 0;
const windows = [];
const handlers = {};
const dialogParents = [];
class Window extends EventEmitter {
  constructor(owner, options) { super(); this.owner = owner; this.options = options; owner.appPanel?.close(); owner.appPanel = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.id = ++seq; this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; this.dead = false; windows.push(this); }
  isDestroyed() { return this.dead; }
  close() { this.dead = true; this.emit('closed'); }
  show() {} focus() {} loadFile(file) { this.file = file; }
}
const original = Module._load;
Module._load = function(id, ...rest) { if (id === './app-panel') return { AppPanel: Window }; if (id === 'electron') return { ipcMain: { handle: (key, fn) => { handlers[key] = fn; } }, dialog: { showMessageBox: async parent => { dialogParents.push(parent); return { response: 1 }; } } }; return original.call(this, id, ...rest); };
const { LedgerUI } = require('../src/main/ledger-review');
const { OliveWindow } = require('../src/main/window');
Module._load = original;

test('review only trusts its own chrome sender, dynamically follows manager ledger, and closes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-ledger-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mgr = { ledger: new Ledger(path.join(dir, 'one.json')) };
  const owner = { mgr, isPrivate: true, win: new EventEmitter() };
  const ui = new LedgerUI(mgr);
  ui.show(owner); assert.equal(windows.length, 0);
  owner.isPrivate = false; ui.show(owner); assert.equal(windows.length, 1);
  const win = windows[0];
  assert.equal(win.owner, owner);
  assert.equal(win.options.title, 'activity ledger');
  assert.equal(win.openHandler().action, 'deny');
  let prevented = false; win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }); assert.ok(prevented);
  const invoke = handlers['olive:ledger'];
  assert.equal(await invoke({ sender: { id: win.webContents.id } }, 'get'), null);
  assert.equal(await invoke({ sender: win.webContents, senderFrame: {} }, 'get'), null);
  mgr.ledger.record('visit', { url: 'https://example.com/?secret=hidden' });
  let state = await invoke({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'get'); assert.equal(state.total, 1);
  mgr.ledger.flush();
  mgr.ledger = new Ledger(path.join(dir, 'two.json'));
  state = await invoke({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'get'); assert.equal(state.total, 0);
  mgr.ledger.record('permission', { permission: 'camera', allowed: true });
  state = await invoke({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'delete', { filter: {} }); assert.equal(state.total, 0);
  assert.equal(dialogParents.at(-1), owner.win);
  assert.equal(await invoke({ sender: win.webContents, senderFrame: {} }, 'close'), null);
  assert.equal(win.isDestroyed(), false);
  await invoke({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'close');
  assert.ok(win.isDestroyed());
  ui.dispose();
  assert.equal(await invoke({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'get'), null);
  mgr.ledger.close();
});
test('window hook blocks every private event and adds window id to normal metadata', () => {
  const calls = [];
  const owner = { isPrivate: true, id: 42, mgr: { ledger: { record: (...args) => calls.push(args) } } };
  OliveWindow.prototype.recordActivity.call(owner, 'visit', { url: 'https://private.example/' });
  assert.equal(calls.length, 0);
  owner.isPrivate = false;
  OliveWindow.prototype.recordActivity.call(owner, 'tab-open', { tabId: 7 });
  assert.deepEqual(calls, [['tab-open', { tabId: 7, windowId: 42 }]]);
});
