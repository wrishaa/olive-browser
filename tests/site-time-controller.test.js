const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const powerMonitor = new EventEmitter(), handlers = {};
let seq = 0, response = 0, dialogOptions, dialogParent, dialogResolve;
class Panel extends EventEmitter {
  constructor(owner, options) { super(); this.owner = owner; this.options = options; this.dead = false; owner.appPanel?.close(); owner.appPanel = owner.inlinePage = this; this.webContents = { id: ++seq, mainFrame: {} }; }
  isDestroyed() { return this.dead; }
  show() {} focus() {} loadFile(file) { this.file = file; }
  close() { if (this.dead) return; this.dead = true; this.owner.appPanel = this.owner.inlinePage = null; this.emit('closed'); }
}
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === './app-panel') return { AppPanel: Panel };
  if (id === 'electron') return { ipcMain: { handle: (key, fn) => handlers[key] = fn }, powerMonitor,
    dialog: { showMessageBox: async (parent, options) => { dialogParent = parent; dialogOptions = options; if (response === 'pending') return new Promise(resolve => dialogResolve = resolve); return { response }; } } };
  return load.call(this, id, ...args);
};
const { SiteTimeController, foregroundPage, cachedFavicons, rasterData } = require('../src/main/site-time');
Module._load = load;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-site-time-controller-'));
  let wall = new Date('2026-10-27T12:00:00').getTime(), mono = 0;
  const flags = { focused: true, visible: true, minimized: false, destroyed: false, view: true, wc: false };
  const win = Object.assign(new EventEmitter(), { isFocused: () => flags.focused, isVisible: () => flags.visible, isMinimized: () => flags.minimized, isDestroyed: () => flags.destroyed });
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => flags.wc, getURL: () => tab.url });
  const tab = { id: 1, wc, url: 'https://www.example.com/private?token=secret', view: { getVisible: () => flags.view, getBounds: () => ({ width: 800, height: 600 }) } };
  const mgr = { dataPath: dir, windows: [] }, owner = { mgr, win, activeId: 1, tabs: new Map([[1, tab]]), visibleIds: () => [1], createTab: data => owner.opened = data };
  mgr.windows.push(owner); mgr.focusedWindow = () => owner;
  const controller = new SiteTimeController(mgr, { tickMs: 0, now: () => wall, monotonicNow: () => mono });
  // stand-in for src/main/settings-page.js: hosts the Activities tab and lets the controller adopt it
  // (the real one moves to a normal window instead of a private one; never inside a private window)
  mgr.settingsPage = { show(o = mgr.focusedWindow(), tab) {
    if (tab !== 'activities' || !o || o.isPrivate) return null;
    if (controller.view && !controller.view.isDestroyed()) return controller.view;
    const v = new Panel(o, { title: 'Settings' }); v.loadFile('/x/src/ui/site-time.html'); controller.adopt(v); return v;
  } };
  t.after(() => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { mgr, owner, tab, flags, controller, dir, advance(ms) { wall += ms; mono += ms; }, state() { return controller.state('all'); }, event() { return { sender: controller.view.webContents, senderFrame: controller.view.webContents.mainFrame }; } };
}
test('native focus and actual active visible page are the only foreground authority', t => {
  const f = fixture(t); assert.ok(foregroundPage(f.mgr));
  for (const [key, value] of [['focused', false], ['visible', false], ['minimized', true], ['destroyed', true], ['view', false], ['wc', true]]) { const old = f.flags[key]; f.flags[key] = value; assert.equal(foregroundPage(f.mgr), null, key); f.flags[key] = old; }
  for (const key of ['isPrivate', 'inlinePage', 'appPanel', 'overlay', 'destroyed']) { f.owner[key] = true; assert.equal(foregroundPage(f.mgr), null, key); delete f.owner[key]; }
  for (const key of ['quitting', 'switchingProfile']) { f.mgr[key] = true; assert.equal(foregroundPage(f.mgr), null); delete f.mgr[key]; }
  for (const key of ['crashed', 'errorFor']) { f.tab[key] = true; assert.equal(foregroundPage(f.mgr), null); delete f.tab[key]; }
  f.tab.url = 'file:///tmp/a'; assert.equal(foregroundPage(f.mgr), null);
  f.tab.url = 'https://example.com/'; assert.equal(foregroundPage(f.mgr, { suspended: true }), null); assert.equal(foregroundPage(f.mgr, { locked: true }), null);
});
test('window and committed navigation event boundaries account immediately without double count', t => {
  const f = fixture(t); f.advance(1234); f.tab.url = 'https://second.example/a'; f.tab.wc.emit('did-navigate'); f.advance(2000);
  f.flags.focused = false; f.owner.win.emit('blur'); f.advance(5000);
  const state = f.state(); assert.equal(state.totalSeconds, 3.234); assert.deepEqual(state.entries.map(e => [e.site,e.seconds]), [['second.example',2],['example.com',1.234]]);
  f.flags.focused = true; f.owner.win.emit('focus'); f.advance(1000); assert.equal(f.state().totalSeconds, 4.234);
});
test('suspend and screen locking pause, flush and do not backfill time on resume', t => {
  const f = fixture(t); f.advance(1000); powerMonitor.emit('suspend'); f.advance(3600000); assert.equal(f.state().totalSeconds, 1);
  powerMonitor.emit('resume'); f.advance(2000); powerMonitor.emit('lock-screen'); f.advance(100000); assert.equal(f.state().totalSeconds, 3);
  powerMonitor.emit('unlock-screen'); f.advance(1000); assert.equal(f.state().totalSeconds, 4);
  assert.equal(fs.statSync(path.join(f.dir,'site-time.json')).mode & 0o777, 0o600);
});
test('activities IPC accepts only its own top frame, cannot appear in private windows', async t => {
  const f = fixture(t); f.owner.isPrivate = true; f.controller.show(); assert.equal(f.controller.view, null); f.owner.isPrivate = false;
  f.advance(1000); f.controller.show(); const view = f.controller.view; assert.match(view.file, /site-time\.html$/);
  const invoke = handlers['olive:site-time'];
  assert.equal(await invoke({sender:{id:view.webContents.id}},'get'), null);
  assert.equal(await invoke({sender:view.webContents,senderFrame:{}},'get'), null);
  const event = f.event(); assert.equal((await invoke(event,'get',{range:'all'})).totalSeconds,1);
  f.advance(10000); assert.equal((await invoke(event,'get',{range:'all'})).totalSeconds,1);
  await invoke(event,'open',{site:'evil.example'}); assert.equal(f.owner.opened,undefined);
  await invoke(event,'open',{site:'example.com'}); assert.deepEqual(f.owner.opened,{url:'https://example.com/',activate:true});
  assert.equal(await invoke(event,'get'),null);
});
test('reset is a native attached confirmation with Cancel default; no ledger or history access', async t => {
  const f = fixture(t); f.advance(2000); f.controller.show(); const invoke=handlers['olive:site-time'], event=f.event();
  response=0; let state=await invoke(event,'reset',{range:'all'}); assert.equal(state.totalSeconds,2); assert.equal(dialogParent,f.owner.win); assert.equal(dialogOptions.defaultId,0); assert.equal(dialogOptions.cancelId,0); assert.match(dialogOptions.detail,/cookies.*activity event log/);
  response=1; state=await invoke(event,'reset',{range:'all'}); assert.equal(state.totalSeconds,0); f.advance(5000); assert.equal(f.state().totalSeconds,0); response=0;
});
test('pending reset cannot clear another profile or a replacement page', async t => {
  const f=fixture(t); f.advance(1000); f.controller.show(); response='pending'; const result=handlers['olive:site-time'](f.event(),'reset',{range:'all'});
  f.controller.closeView(); dialogResolve({response:1}); assert.equal(await result,null); assert.equal(f.state().totalSeconds,1); response=0;
});
test('profile reload closes old trusted page and keeps per-profile data separate', t => {
  const f=fixture(t); f.advance(1000); f.controller.show(); const event=f.event(); f.controller.pause(); f.mgr.dataPath=path.join(f.dir,'Profiles','other'); f.controller.reload();
  assert.equal(f.controller.view,null); assert.equal(f.controller.trusted(event),false); assert.equal(f.state().totalSeconds,0);
  f.mgr.dataPath=f.dir; f.controller.reload(); assert.equal(f.state().totalSeconds,1);
});
test('favicons are raster data from normal in-memory entries only, never remote requests or private tabs', () => {
  const icon='data:image/png;base64,YQ=='; assert.equal(rasterData(icon),icon); assert.equal(rasterData('https://remote.example/icon.png'),null); assert.equal(rasterData('data:image/svg+xml;base64,YQ=='),null);
  const mgr={windows:[{isPrivate:true,tabs:new Map([[1,{url:'https://private.example/',favicon:icon}]])},{tabs:new Map([[2,{url:'https://www.example.com/',favicon:icon}]])}],history:{map:new Map([[3,{url:'https://history.example/',favicon:'https://remote.example/'}]])}};
  assert.deepEqual([...cachedFavicons(mgr,new Set(['private.example','example.com','history.example']))],[['example.com',icon]]);
});
test('dispose removes native, power and webcontents listeners and cannot restart counting', t => {
  const f=fixture(t); assert.ok(f.tab.wc.listenerCount('did-navigate')); f.advance(1000); f.controller.dispose();
  assert.equal(f.tab.wc.listenerCount('did-navigate'),0); assert.equal(f.owner.win.listenerCount('focus'),0); assert.equal(powerMonitor.listenerCount('suspend'),0); f.advance(1000); f.controller.refresh(); assert.equal(f.controller.tracker.snapshot('all').totalSeconds,1);
});
