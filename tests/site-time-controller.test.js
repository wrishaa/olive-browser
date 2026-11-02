const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const powerMonitor = new EventEmitter(), handlers = {};
let seq = 0, response = 0, dialogOptions, dialogParent, dialogResolve;
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { ipcMain: { handle: (key, fn) => handlers[key] = fn }, powerMonitor,
    dialog: { showMessageBox: async (parent, options) => { dialogParent = parent; dialogOptions = options; if (response === 'pending') return new Promise(resolve => dialogResolve = resolve); return { response }; } } };
  return load.call(this, id, ...args);
};
const { SiteTimeController, foregroundPage, cachedFavicons, rasterData } = require('../src/main/site-time');
Module._load = load;
const { InternalPages } = require('../src/main/internal-pages');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-site-time-controller-'));
  let wall = new Date('2026-10-27T12:00:00').getTime(), mono = 0;
  const flags = { focused: true, visible: true, minimized: false, destroyed: false, view: true, wc: false };
  const win = Object.assign(new EventEmitter(), { isFocused: () => flags.focused, isVisible: () => flags.visible, isMinimized: () => flags.minimized, isDestroyed: () => flags.destroyed });
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => flags.wc, getURL: () => tab.url });
  const tab = { id: 1, wc, url: 'https://www.example.com/private?token=secret', view: { getVisible: () => flags.view, getBounds: () => ({ width: 800, height: 600 }) } };
  const mgr = { dataPath: dir, windows: [] }, owner = { mgr, win, activeId: 1, tabs: new Map([[1, tab]]), visibleIds: () => [1], createTab: data => owner.opened = data, activate: id => { owner.activeId = id; } };
  mgr.windows.push(owner); mgr.focusedWindow = () => owner;
  mgr.internal = new InternalPages(mgr); // the real olive:// sender check
  const controller = new SiteTimeController(mgr, { tickMs: 0, now: () => wall, monotonicNow: () => mono });
  // stand-in for src/main/settings-page.js: Settings > Activities is a tab at
  // olive://settings/activities (the real one goes to a normal window from a private one)
  const f = { mgr, owner, tab, flags, controller, dir, settings: null };
  mgr.settingsPage = { show(o = mgr.focusedWindow(), section) {
    if (section !== 'activities' || !o || o.isPrivate) return null;
    if (!f.settings) {
      const url = 'olive://settings/activities';
      const wc = Object.assign(new EventEmitter(), { id: ++seq, mainFrame: { url }, isDestroyed: () => false });
      f.settings = { id: 100 + seq, url, wc };
      o.tabs.set(f.settings.id, f.settings);
    }
    o.activate(f.settings.id);
    return f.settings;
  } };
  t.after(() => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return Object.assign(f, { advance(ms) { wall += ms; mono += ms; }, state() { return controller.state('all'); }, event() { return { sender: f.settings.wc, senderFrame: f.settings.wc.mainFrame }; },
    // the Settings tab goes somewhere else (another section, a site)
    leave(url) { f.settings.url = url; f.settings.wc.mainFrame.url = url; } });
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
test('activities IPC accepts only the top frame of a Settings > Activities tab, never in private windows', async t => {
  const f = fixture(t); f.owner.isPrivate = true; f.controller.show(); assert.equal(f.settings, null); f.owner.isPrivate = false;
  f.advance(1000); f.controller.show(); const tab = f.settings; assert.equal(tab.url, 'olive://settings/activities');
  const invoke = handlers['olive:site-time'];
  assert.equal(await invoke({sender:{id:tab.wc.id}},'get'), null);
  assert.equal(await invoke({sender:tab.wc,senderFrame:{url:tab.url}},'get'), null, 'a subframe');
  assert.equal(await invoke({sender:f.tab.wc,senderFrame:f.tab.wc.mainFrame},'get'), null, 'a web tab');
  const event = f.event(); assert.equal((await invoke(event,'get',{range:'all'})).totalSeconds,1);
  f.advance(10000); assert.equal((await invoke(event,'get',{range:'all'})).totalSeconds,1, 'the olive:// tab in front accrues nothing');
  await invoke(event,'open',{site:'evil.example'}); assert.equal(f.owner.opened,undefined);
  await invoke(event,'open',{site:'example.com'}); assert.deepEqual(f.owner.opened,{url:'https://example.com/',activate:true,afterId:tab.id});
  f.owner.isPrivate = true; assert.equal(await invoke(event,'get'),null, 'a private window never gets it'); f.owner.isPrivate = false;
  f.leave('olive://settings/general'); assert.equal(await invoke(event,'get'),null, 'another section');
});
test('reset is a native attached confirmation with Cancel default; no ledger or history access', async t => {
  const f = fixture(t); f.advance(2000); f.controller.show(); const invoke=handlers['olive:site-time'], event=f.event();
  response=0; let state=await invoke(event,'reset',{range:'all'}); assert.equal(state.totalSeconds,2); assert.equal(dialogParent,f.owner.win); assert.equal(dialogOptions.defaultId,0); assert.equal(dialogOptions.cancelId,0); assert.match(dialogOptions.detail,/cookies.*activity event log/);
  response=1; state=await invoke(event,'reset',{range:'all'}); assert.equal(state.totalSeconds,0); f.advance(5000); assert.equal(f.state().totalSeconds,0); response=0;
});
test('pending reset cannot clear another profile or a replacement page', async t => {
  const f=fixture(t); f.advance(1000); f.controller.show(); response='pending'; const result=handlers['olive:site-time'](f.event(),'reset',{range:'all'});
  f.leave('https://example.com/'); dialogResolve({response:1}); assert.equal(await result,null); assert.equal(f.state().totalSeconds,1); response=0;
});
test('profile reload: the old profile\'s Activities tab is gone and data stays per profile', t => {
  const f=fixture(t); f.advance(1000); f.controller.show(); const event=f.event(); f.controller.pause(); f.mgr.windows.splice(0); /* switchProfile closes every window, Settings tabs too */ f.mgr.dataPath=path.join(f.dir,'Profiles','other'); f.controller.reload();
  assert.ok(!f.controller.trusted(event)); assert.equal(f.state().totalSeconds,0);
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
