// site permissions: what pages see before / after the user decides (src/main/permissions.js
// siteState + check/request handlers with a fake electron) and the page-world shim
// (src/ui/site-permissions-preload.js) run in a vm with fake PermissionStatus / Notification.
// native check: scripts/media-perms-native-test.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');

function setup() {
  const handlers = {}, ipc = {}, sent = [];
  let status = 'granted';
  const frame = { origin: 'https://meet.google.com', send: (ch, s) => sent.push(s) };
  const ses = { setPermissionCheckHandler: f => handlers.check = f, setPermissionRequestHandler: f => handlers.request = f, setDisplayMediaRequestHandler: f => handlers.display = f };
  const wc = new EventEmitter(); wc.isDestroyed = () => false; wc.getURL = () => 'https://meet.google.com/abc-defg-hij'; wc.session = ses; wc.mainFrame = { framesInSubtree: [frame] }; wc.id = 7;
  const toasts = [], settingsShown = [];
  const win = { tabs: new Map([[1, { wc }]]), activeId: 1, isPrivate: false, send: (ch, msg) => toasts.push(msg) };
  const electron = {
    ipcMain: { on: (n, f) => ipc[n] = f, handle: (n, f) => ipc[n] = f },
    systemPreferences: { getMediaAccessStatus: () => status, askForMediaAccess: async () => { status = 'denied'; return false; } },
    desktopCapturer: { getSources: async () => [] }, webContents: { fromFrame: f => f.wc, getAllWebContents: () => [wc] }, shell: { openExternal: async () => {} }, app: { isPackaged: false },
  };
  const sandbox = { require: n => n === 'electron' ? electron : n === './app-panel' ? { AppPanel: class {} } : require(n), module: { exports: {} }, __dirname: path.resolve(__dirname, '../src/main'), process: { platform: 'darwin' }, URL, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/main/permissions'), 'utf8'), sandbox);
  const choices = {}; let saves = 0;
  const mgr = { windows: [win], perms: { data: choices, save: () => saves++ } };
  const p = new sandbox.module.exports.Permissions(mgr); p.refresh = () => {}; p.showSettings = (w, src) => settingsShown.push(src);
  p.install(ses, true);
  // what the preload's sendSync gets for this frame
  const pageState = () => { const e = { sender: wc, senderFrame: frame }; ipc['olive:site-permission-state'](e); return e.returnValue; };
  const request = (permission, details = {}) => { let result; handlers.request(wc, permission, v => result = v, { requestingUrl: wc.getURL(), ...details }); return () => result; };
  const last = () => [...p.pending.values()].at(-1);
  // site settings panel for this tab (the ipc handler checks the sender is the panel)
  const panel = { id: 99 }; p.settings.set(99, { view: { webContents: panel, close() {} }, win, wc, origin: 'https://meet.google.com', choices });
  const setSetting = (key, value) => ipc['olive:site-settings']({ sender: panel }, 'set', { key, value });
  return { p, handlers, choices, sent, pageState, request, last, setSetting, wc, toasts, settingsShown, setStatus: s => status = s, saves: () => saves };
}

test('ask: page sees prompt, check stays false (no device labels), olive prompt opens on request', () => {
  const t = setup();
  const s = t.pageState();
  assert.equal(s.camera, 'prompt'); assert.equal(s.microphone, 'prompt'); assert.equal(s.notifications, 'prompt'); assert.equal(s.geolocation, 'prompt');
  assert.equal(t.handlers.check(t.wc, 'media', 'https://meet.google.com', { mediaType: 'video' }), false);
  assert.equal(t.handlers.check(t.wc, 'media', 'https://meet.google.com', { mediaType: 'audio' }), false);
  t.request('media', { mediaTypes: ['audio', 'video'] });
  assert.equal(t.p.pending.size, 1); assert.equal(t.last().label, 'microphone and camera');
  // opaque / non-web frames get nothing (the preload then leaves the page alone)
  assert.equal(t.p.siteState(t.choices, t.wc, 'null'), null);
  assert.equal(t.p.siteState(t.choices, t.wc, 'file:///x'), null);
});

test('allow is remembered per origin: granted in page + check, pushed to frames', async () => {
  const t = setup();
  const result = t.request('media', { mediaTypes: ['audio', 'video'] });
  await t.p.finish(t.last(), true, true);
  assert.equal(result(), true);
  assert.equal(t.choices['https://meet.google.com|media:audio'], true); assert.equal(t.choices['https://meet.google.com|media:video'], true);
  assert.ok(t.saves() > 0);
  assert.equal(t.pageState().camera, 'granted'); assert.equal(t.pageState().microphone, 'granted');
  assert.equal(t.sent.at(-1).camera, 'granted');
  assert.equal(t.handlers.check(t.wc, 'media', 'https://meet.google.com', { mediaType: 'video' }), true);
  assert.equal(t.handlers.check(t.wc, 'media', 'https://other.example', { mediaType: 'video' }), false);
  assert.equal(t.p.siteState(t.choices, t.wc, 'https://other.example').camera, 'prompt');
  // later requests do not prompt again
  const again = t.request('media', { mediaTypes: ['video'] }); await new Promise(r => setTimeout(r, 0)); assert.equal(again(), true); assert.equal(t.p.pending.size, 0);
});

test('allow once: granted for this document only', async () => {
  const t = setup();
  t.request('media', { mediaTypes: ['audio'] }); await t.p.finish(t.last(), true, false);
  assert.equal(t.pageState().microphone, 'granted'); assert.equal(t.pageState().camera, 'prompt');
  assert.equal(Object.keys(t.choices).length, 0);
  t.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(t.pageState().microphone, 'prompt');
});

test('block is remembered: denied in page, no prompt next time', async () => {
  const t = setup();
  const result = t.request('media', { mediaTypes: ['audio', 'video'] });
  await t.p.finish(t.last(), false, true);
  assert.equal(result(), false);
  assert.equal(t.pageState().camera, 'denied'); assert.equal(t.sent.at(-1).microphone, 'denied');
  const again = t.request('media', { mediaTypes: ['audio'] }); assert.equal(again(), false); assert.equal(t.p.pending.size, 0);
  // notifications / geolocation use the same flow
  const n = t.request('notifications'); await t.p.finish(t.last(), false, true); assert.equal(n(), false); assert.equal(t.pageState().notifications, 'denied');
  const g = t.request('geolocation'); await t.p.finish(t.last(), true, true); assert.equal(g(), true); assert.equal(t.pageState().geolocation, 'granted');
});

test('site settings edits change what the page sees, and are pushed live', async () => {
  const t = setup();
  t.request('media', { mediaTypes: ['video'] }); await t.p.finish(t.last(), false, true);
  assert.equal(t.pageState().camera, 'denied');
  let st = await t.setSetting('media:video', 'allow');
  assert.equal(st.permissions.find(x => x.key === 'media:video').value, 'allow');
  assert.equal(t.pageState().camera, 'granted'); assert.equal(t.sent.at(-1).camera, 'granted');
  st = await t.setSetting('media:video', 'ask');
  assert.equal(t.pageState().camera, 'prompt'); assert.equal(t.sent.at(-1).camera, 'prompt');
  await t.setSetting('notifications', 'block');
  assert.equal(t.pageState().notifications, 'denied');
  // reset clears everything for the origin back to prompt
  t.p.reset({ tabs: new Map([[1, { wc: t.wc }]]), activeId: 1, isPrivate: false, send: () => {} });
  assert.equal(t.pageState().notifications, 'prompt');
});

test('macOS denied: allow keeps the site choice, page call fails, toast + site settings shown', async () => {
  const t = setup(); t.setStatus('not-determined');
  const result = t.request('media', { mediaTypes: ['audio'] });
  await t.p.finish(t.last(), true, true);
  assert.equal(result(), false);
  assert.equal(t.choices['https://meet.google.com|media:audio'], true);
  assert.match(t.toasts.at(-1), /macOS blocked microphone\/camera/);
  assert.equal(t.settingsShown.length, 1);
});

// ---------- page-world shim ----------

function shim(initial) {
  let main = null, onUpdate = null; const sync = [];
  const electron = {
    ipcRenderer: { sendSync: (ch) => { sync.push(ch); return initial; }, on: (ch, f) => { onUpdate = f; } },
    contextBridge: { executeInMainWorld: ({ func, args }) => {
      // a fake "main world" with chromium-like classes, natively reporting 'denied' (check false)
      main = vm.createContext({ WeakRef, WeakMap, Set, Event: class Event { constructor(type) { this.type = type; } }, Object, Promise });
      vm.runInContext(`
        class PermissionStatus { constructor(n){ this._n = n; this.events = 0; } get state(){ return 'denied'; } dispatchEvent(e){ if (e.type === 'change') { this.events++; if (this.onchange) this.onchange(e); } return true; } }
        class Permissions { query(d){ if (!d || !d.name) return Promise.reject(new TypeError('bad')); return Promise.resolve(new PermissionStatus(d.name)); } }
        class Notification { static get permission(){ return 'denied'; } }
        globalThis.PermissionStatus = PermissionStatus; globalThis.Permissions = Permissions; globalThis.Notification = Notification;
        globalThis.navigator = { permissions: new Permissions() };`, main);
      // electron serializes func and runs it in the main world, like this
      main.__args = args;
      return vm.runInContext(`(${func.toString()})(...__args)`, main);
    } },
  };
  const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/site-permissions-preload.js'), 'utf8');
  vm.runInNewContext(src, { require: n => { if (n !== 'electron') throw new Error(n); return electron; }, console });
  return { main, push: s => onUpdate && onUpdate({}, s), sync, run: code => vm.runInContext(code, main) };
}

test('shim: query says prompt while asking, follows decisions, fires change; Notification.permission default', async () => {
  const base = { camera: 'prompt', microphone: 'prompt', notifications: 'prompt', geolocation: 'prompt', push: 'prompt' };
  const s = shim(base);
  assert.deepEqual(s.sync, ['olive:site-permission-state']);
  const cam = await s.run(`navigator.permissions.query({ name: 'camera' })`);
  assert.equal(cam.state, 'prompt');
  assert.equal(s.run('Notification.permission'), 'default');
  const midi = await s.run(`navigator.permissions.query({ name: 'midi' })`);
  assert.equal(midi.state, 'denied'); // untracked names stay chromium's own
  await assert.rejects(s.run(`navigator.permissions.query({})`));
  s.push({ ...base, camera: 'granted' });
  assert.equal(cam.state, 'granted'); assert.equal(cam.events, 1);
  s.push({ ...base, camera: 'granted' });
  assert.equal(cam.events, 1); // no change, no event
  s.push({ ...base, camera: 'denied', notifications: 'denied' });
  assert.equal(cam.state, 'denied'); assert.equal(cam.events, 2); assert.equal(s.run('Notification.permission'), 'denied');
  s.push({ ...base, notifications: 'granted' });
  assert.equal(s.run('Notification.permission'), 'granted');
});

test('shim: non-web frames (no state) leave the page untouched', () => {
  const s = shim(null);
  assert.equal(s.main, null);
});
