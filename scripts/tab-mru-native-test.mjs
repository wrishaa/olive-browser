import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
// Ctrl+Tab MRU walk, end to end through before-input-event. Spec: notes/tab-mru-spec.md.
// Disposable Electron fixture only (temp profile); never attaches to installed Olive.
// No focus grabs: Olive is booted through scripts/no-focus-preload.cjs, which turns
// window show() into showInactive(), disables win.focus()/app.focus() and sets the
// 'prohibited' activation policy, so the fixture never becomes the key app.
//
// Because the window is never key, macOS keyboard routing is modelled: keys go to the
// webcontents that last had webContents.focus() called on it (what AppKit's first
// responder would be), or to the ui after a simulated sidebar click. Delivery itself
// is real Chromium: webContents.sendInputEvent -> before-input-event, and Chromium
// decides whether a hidden / not-yet-loaded view receives it.
// Run: node scripts/tab-mru-native-test.mjs [--only a,b,...]
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-mru-fixture-'));
const boot = path.join(root, 'boot');
fs.mkdirSync(boot);
fs.writeFileSync(path.join(boot, 'package.json'), JSON.stringify({ name: 'olive-mru-fixture', main: path.join(repo, 'scripts/no-focus-preload.cjs') }));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const scenarioResults = {};
let scenario = '';
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, scenario, label, detail });
  if (!ok) scenarioResults[scenario] = false;
  else if (scenarioResults[scenario] !== false) scenarioResults[scenario] = true;
  console.log((ok ? 'PASS ' : 'FAIL ') + `[${scenario}] ` + label + (ok ? '' : ' ' + JSON.stringify(detail)));
};
const pause = ms => new Promise(r => setTimeout(r, ms));

// Reference model (the spec), independent of src/main/tab-mru.js.
class Ref {
  constructor(order) { this.order = [...order]; this.walk = null; this.i = 0; }
  get active() { return this.walk ? this.walk[this.i] : this.order[0]; }
  activate(id) { this.release(); this.order = [id, ...this.order.filter(x => x !== id)]; }
  press(dir) {
    if (!this.walk) { this.walk = [...this.order]; this.i = 0; }
    if (this.walk.length) this.i = (this.i + dir + this.walk.length) % this.walk.length;
  }
  release() { if (!this.walk) return; const id = this.walk[this.i]; this.walk = null; this.order = [id, ...this.order.filter(x => x !== id)]; }
  close(id) {
    if (this.walk) {
      const cur = this.walk[this.i];
      this.release();
      this.order = this.order.filter(x => x !== id);
      if (cur === id) this.order = this.order; // olive picks a neighbour; caller syncs
      return;
    }
    this.order = this.order.filter(x => x !== id);
  }
}

let app;
const ev = (fn, arg) => app.evaluate(fn, arg);
// --- in-app helpers --------------------------------------------------------
async function install() {
  await ev(async ({ webContents }) => {
    while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
    global.olive.onboarding?.close?.();
    const w = global.olive.focusedWindow();
    w.win.setTitle('olive mru disposable fixture');
    // model AppKit's first responder: the last webcontents focus() was called on
    const proto = Object.getPrototypeOf(w.ui.webContents);
    if (!proto.__mruFocusPatched) {
      const focus = proto.focus;
      proto.focus = function () { global.__kbd = this; return focus.call(this); };
      proto.__mruFocusPatched = true;
    }
    global.__kbd = w.ui.webContents;
  });
}
async function reset(n, { unloadOthers = false } = {}) {
  return ev(async (_, { n, unloadOthers }) => {
    const w = global.olive.focusedWindow();
    w.finishTabWalk();
    w.inlinePage?.close();
    w.setOverlay(null);
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    w.closedStack = [];
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(w.createTab({ url: `data:text/html,<title>t${i}</title><body>tab ${i}</body>`, activate: true }).id);
    await new Promise(r => setTimeout(r, 400));
    if (unloadOthers) for (const id of ids) if (id !== w.activeId) w.unload(w.tabs.get(id));
    w.setOverlay(null);
    return { ids, order: [...w.tabMRU.order], active: w.activeId };
  }, { n, unloadOthers });
}
const snap = () => ev(() => {
  const w = global.olive.focusedWindow();
  return { active: w.activeId, order: [...w.tabMRU.order], walk: w.tabMRU.walk && [...w.tabMRU.walk], kbd: global.__kbd === w.ui.webContents ? 'ui' : [...w.tabs.values()].find(t => t.wc === global.__kbd)?.id ?? null };
});
// target: 'kbd' (modelled first responder), 'ui', 'none' (lost: e.g. released while
// focus was in an unwired surface), or a tab id
async function key(type, keyCode, modifiers = [], target = 'kbd') {
  await ev((_, { type, keyCode, modifiers, target }) => {
    const w = global.olive.focusedWindow();
    let wc = target === 'kbd' ? global.__kbd : target === 'ui' ? w.ui.webContents : target === 'none' ? null : w.tabs.get(target)?.wc;
    if (!wc || wc.isDestroyed()) return;
    if (global.__mruDebug) {
      if (!wc.__mruLog) { wc.__mruLog = true; wc.on('before-input-event', (_e, i) => console.log('BIE', wc.id, i.type, i.key, i.control, i.shift)); }
      const tabId = [...w.tabs.values()].find(t => t.wc === wc)?.id ?? 'ui';
      console.log('SEND', wc.id, 'tab', tabId, type, keyCode, 'visible', w.tabs.get(tabId)?.view?.getVisible?.(), 'active', w.activeId, 'walk', !!w.tabMRU.walk);
    }
    wc.sendInputEvent({ type, keyCode, modifiers });
  }, { type, keyCode, modifiers, target });
  await pause(25);
}
const mods = shift => shift ? ['control', 'shift'] : ['control'];
async function ctrlDown(shift = false, target) { await key('keyDown', 'Control', ['control'], target); if (shift) await key('keyDown', 'Shift', mods(true), target); }
async function tab(shift = false, target) { await key('keyDown', 'Tab', mods(shift), target); await key('keyUp', 'Tab', mods(shift), target); }
async function ctrlUp(shift = false, target) { if (shift) await key('keyUp', 'Shift', ['control'], target); await key('keyUp', 'Control', [], target); }
async function tap(shift = false) { await ctrlDown(shift); await tab(shift); await ctrlUp(shift); }
async function hold(n, shift = false) { await ctrlDown(shift); for (let i = 0; i < n; i++) await tab(shift); await ctrlUp(shift); }
const settled = async () => { await pause(40); return snap(); };
const eqArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function expectState(ref, label) {
  const s = await settled();
  check(s.active === ref.active && eqArr(s.order, ref.order) && !s.walk, label, { got: s, want: { active: ref.active, order: ref.order } });
}

const scenarios = {
  async a() {
    const { order } = await reset(4);
    const ref = new Ref(order);
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'first tap goes to previous tab');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'second tap returns to original');
  },
  async a5() {
    // esc while the modifier is held cancels: back to the start tab, mru unchanged,
    // esc never reaches the page, and the later modifier release does nothing.
    const escLog = () => ev(async () => {
      const w = global.olive.focusedWindow();
      const out = {};
      for (const t of w.tabs.values()) if (t.wc && !t.wc.isDestroyed()) out[t.id] = await t.wc.executeJavaScript('window.__esc || 0').catch(() => -1);
      return out;
    });
    const armEsc = () => ev(async () => {
      for (const t of global.olive.focusedWindow().tabs.values()) if (t.wc) await t.wc.executeJavaScript("window.__esc = 0; addEventListener('keydown', e => { if (e.key === 'Escape') window.__esc++; }, true); addEventListener('keyup', e => { if (e.key === 'Escape') window.__esc++; }, true); 0").catch(() => {});
    });
    const esc = async (m, target) => { await key('keyDown', 'Escape', m, target); await key('keyUp', 'Escape', m, target); };
    // 'cmd': a remapped hold walk (Cmd+Alt+K, as in shortcuts-native-test); olive rejects
    // Alt+Tab as a shortcut, so there is no alt-tab walk.
    for (const style of ['control', 'cmd']) {
      const { order } = await reset(4);
      const start = order[0];
      if (style === 'cmd') await ev(() => { global.olive.shortcuts.overrides.mruNext = 'Cmd+Alt+K'; global.olive.shortcuts.overrides.mruPrev = 'Cmd+Alt+Shift+K'; });
      // force every tab's view so the page listeners can be armed
      await ev(async () => { const w = global.olive.focusedWindow(); for (const t of w.tabs.values()) w.ensureView(t); await new Promise(r => setTimeout(r, 300)); });
      await armEsc();
      const cmd = style === 'cmd';
      const held = cmd ? ['meta', 'alt'] : ['control'];
      const K = cmd ? 'Meta' : 'Control', step = cmd ? 'K' : 'Tab';
      const down = (k, h = true) => key('keyDown', k, h ? held : []);
      const up = (k, h = true) => key('keyUp', k, h ? held : []);
      await down(K);
      for (let i = 0; i < 2; i++) { await down(step); await up(step); }
      let s = await settled();
      check(s.walk && s.active === order[2], `${style}: hold walk previews mru[2]`, s);
      await down('Escape'); await up('Escape');
      s = await settled();
      check(!s.walk && s.active === start && eqArr(s.order, order), `${style}: esc cancels back to the start tab, mru unchanged`, { got: s, want: { start, order } });
      await up(K, false);
      s = await settled();
      check(!s.walk && s.active === start && eqArr(s.order, order), `${style}: releasing the modifier after esc does nothing`, s);
      const log = await escLog();
      check(Object.values(log).every(n => n === 0), `${style}: esc never reached a page`, log);
      // the next tap still toggles to the previous tab
      await down(K); await down(step); await up(step); await up(K, false);
      s = await settled();
      check(s.active === order[1] && s.order[0] === order[1] && s.order[1] === start, `${style}: next tap after a cancel toggles normally`, s);
      // esc with no walk open still reaches the page
      await esc([]);
      const after = await escLog();
      check(after[s.active] > 0, `${style}: esc outside a walk still reaches the page`, after);
      if (style === 'cmd') await ev(() => { delete global.olive.shortcuts.overrides.mruNext; delete global.olive.shortcuts.overrides.mruPrev; });
    }
    // palette open (focus stays in ui): esc cancels the walk, palette stays open
    const { order } = await reset(4);
    await ev(() => global.olive.focusedWindow().openPalette('new'));
    await pause(100);
    await ev(() => global.olive.focusedWindow().ui.webContents.focus());
    await ctrlDown(); await tab(); await tab();
    await esc(['control']);
    await ctrlUp();
    const s = await settled();
    const ov = await ev(() => global.olive.focusedWindow().overlay);
    check(!s.walk && s.active === order[0] && eqArr(s.order, order) && ov === 'palette', 'palette: esc cancels the walk and is not taken by the palette', { s, ov });
    await ev(() => global.olive.focusedWindow().setOverlay(null));
  },
  async b() {
    const { order } = await reset(4);
    const ref = new Ref(order);
    await ctrlDown();
    for (let i = 1; i <= 3; i++) {
      await tab(); ref.press(1);
      const s = await settled();
      check(s.active === ref.active && eqArr(s.order, order), `hold: press ${i} previews mru[${i}] without reordering`, { got: s, want: ref.active });
    }
    await ctrlUp(); ref.release();
    await expectState(ref, 'release commits the walked-to tab');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'next tap returns to where the walk started');
  },
  async c() {
    const { order } = await reset(4);
    const ref = new Ref(order);
    const seen = [];
    for (let i = 0; i < 20; i++) { await tap(); ref.press(1); ref.release(); seen.push((await snap()).active); }
    check(new Set(seen).size === 2 && seen.every((x, i) => x === (i % 2 ? order[0] : order[1])), '20 quick taps alternate between the two most recent', seen);
    await expectState(ref, 'mru after 20 taps');
  },
  async c2() {
    // the walked-to tab has no view yet: ensureView creates it inside activate()
    const { order } = await reset(4, { unloadOthers: true });
    const ref = new Ref(order);
    const seen = [];
    for (let i = 0; i < 6; i++) { await tap(); ref.press(1); ref.release(); seen.push((await snap()).active); }
    check(seen.every((x, i) => x === (i % 2 ? order[0] : order[1])), 'taps into not-yet-loaded tab views keep toggling', { seen, order });
    await expectState(ref, 'mru after taps into fresh views');
  },
  async c3() {
    // hold walk across several not-yet-loaded views
    const { order } = await reset(5, { unloadOthers: true });
    const ref = new Ref(order);
    await hold(3); ref.press(1); ref.press(1); ref.press(1); ref.release();
    await expectState(ref, 'hold 3 through fresh views commits the third');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'then a tap returns to the start');
  },
  async d1() {
    const { ids, order } = await reset(5);
    const ref = new Ref(order);
    // sidebar click: ui gets the mouse (first responder), then main activates the tab
    await ev((_, id) => { const w = global.olive.focusedWindow(); global.__kbd = w.ui.webContents; w.cmd('activate', { id }); }, ids[1]);
    ref.activate(ids[1]);
    await expectState(ref, 'sidebar activate updates mru');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'tap after sidebar click returns to the tab before the click');
    // ctrl+tab while the ui webcontents has keyboard focus (e.g. after clicking sidebar chrome)
    await ev(() => { const w = global.olive.focusedWindow(); w.ui.webContents.focus(); });
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'tap starting from ui focus');
    // walk from ui while the palette is open (activate() doesn't move focus to the page)
    await ev(() => global.olive.focusedWindow().openPalette('new'));
    await pause(100);
    await ev(() => { const w = global.olive.focusedWindow(); w.ui.webContents.focus(); });
    await hold(2); ref.press(1); ref.press(1); ref.release();
    await expectState(ref, 'hold 2 with palette open (focus stays in ui) commits on release');
    await ev(() => global.olive.focusedWindow().setOverlay(null));
  },
  async d2() {
    const { ids, order } = await reset(4);
    const ref = new Ref(order);
    // split the active tab (ids[3]) with ids[0]; then click into ids[0]'s pane
    await ev((_, { a, b }) => { const w = global.olive.focusedWindow(); w.split(a, b); w.activate(a); }, { a: ids[3], b: ids[0] });
    ref.activate(ids[3]);
    await pause(150);
    await ev((_, b) => { const w = global.olive.focusedWindow(); const wc = w.tabs.get(b).wc; wc.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 }); global.__kbd = wc; }, ids[0]);
    await pause(100);
    ref.activate(ids[0]);
    await expectState(ref, 'click into split pane makes it most recent');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'tap returns to the other pane');
    await ev(() => { const w = global.olive.focusedWindow(); w.unsplit(w.activeId); });
  },
  async d3() {
    const { ids, order } = await reset(5);
    const ref = new Ref(order);
    await ev(() => global.olive.focusedWindow().cmd('selectIndex', { index: 1 }));
    const s = await snap(); ref.activate(s.active);
    await expectState(ref, 'cmd+1 updates mru');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'tap after cmd+1 returns');
    await ev(() => global.olive.focusedWindow().openPalette('edit'));
    await ev((_, id) => { const w = global.olive.focusedWindow(); w.cmd('activate', { id }); w.setOverlay(null); }, ids[2]);
    ref.activate(ids[2]);
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'tap after palette pick returns');
  },
  async d4() {
    // ctrl released where olive never sees the keyUp: a fresh view, or an unwired surface
    let { order } = await reset(4);
    let ref = new Ref(order);
    await ctrlDown(); await tab(); ref.press(1);
    await key('keyUp', 'Tab', ['control']);
    await key('keyUp', 'Control', [], 'none'); ref.release();
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'lost ctrl keyUp: next tap starts fresh (back to start), not a stale walk');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'lost ctrl keyUp: and keeps toggling');
    // same, but the lost walk is followed by a menu-dispatched ctrl+tab
    ({ order } = await reset(4)); ref = new Ref(order);
    await ctrlDown(); await tab(); ref.press(1); await key('keyUp', 'Control', [], 'none'); ref.release();
    await ev(() => global.olive.focusedWindow().cmd('mruNext')); ref.press(1); ref.release();
    await expectState(ref, 'lost ctrl keyUp then menu ctrl+tab: toggles back');
    // ctrl released while keyboard focus sits in the ui webcontents
    ({ order } = await reset(4)); ref = new Ref(order);
    await ctrlDown(); await tab(); ref.press(1);
    await key('keyUp', 'Control', [], 'ui'); ref.release();
    await expectState(ref, 'ctrl released in ui webcontents commits');
    // walk previews an unloaded tab; ctrl keyUp goes wherever focus went
    ({ order } = await reset(4, { unloadOthers: true })); ref = new Ref(order);
    await ctrlDown(); await tab(); ref.press(1);
    await ctrlUp(); ref.release();
    await expectState(ref, 'ctrl released right after previewing a just-created view commits');
    await tap(); ref.press(1); ref.release();
    await expectState(ref, 'and the next tap returns');
  },
  async d5() {
    const { order } = await reset(4);
    const ref = new Ref(order);
    for (let i = 0; i < 4; i++) { await ev(() => global.olive.focusedWindow().cmd('mruNext')); ref.press(1); ref.release(); }
    await expectState(ref, 'menu-dispatched ctrl+tab toggles like a tap');
    await ev(() => global.olive.focusedWindow().cmd('mruPrev')); ref.press(-1); ref.release();
    await expectState(ref, 'menu-dispatched ctrl+shift+tab goes to least recent');
  },
  async e() {
    const { ids, order } = await reset(10);
    const ref = new Ref(order);
    let seed = 7;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let bad = 0;
    for (let step = 0; step < 60; step++) {
      const r = rnd(10);
      let what;
      if (r < 4) { const id = ids[rnd(ids.length)]; what = 'activate ' + id; await ev((_, id) => global.olive.focusedWindow().cmd('activate', { id }), id); ref.activate(id); }
      else if (r < 7) { what = 'tap'; await tap(); ref.press(1); ref.release(); }
      else { const n = 1 + rnd(4); const shift = rnd(4) === 0; what = `hold ${n}${shift ? ' shift' : ''}`; await hold(n, shift); for (let i = 0; i < n; i++) ref.press(shift ? -1 : 1); ref.release(); }
      const s = await settled();
      if (s.active !== ref.active || !eqArr(s.order, ref.order) || s.walk) { bad++; if (bad <= 3) check(false, `step ${step} (${what}) matches reference`, { got: s, want: { active: ref.active, order: ref.order } }); ref.order = s.order; if (ref.walk) ref.walk = null; }
    }
    check(bad === 0, `60 random steps match the reference mru model (${bad} mismatches)`);
  },
  async f1() {
    const { order } = await reset(4);
    const ref = new Ref(order);
    await ctrlDown(true);
    for (let i = 1; i <= 2; i++) { await tab(true); ref.press(-1); const s = await settled(); check(s.active === ref.active, `ctrl+shift hold: press ${i} previews from the end`, { got: s.active, want: ref.active }); }
    // drop shift mid-walk: same snapshot, forward again
    await key('keyUp', 'Shift', ['control']);
    await tab(false); ref.press(1);
    await ctrlUp(); ref.release();
    await expectState(ref, 'releasing shift mid-walk reverses within the same snapshot, ctrl release commits');
  },
  async f2() {
    let { ids, order } = await reset(5);
    let ref = new Ref(order);
    await ctrlDown(); await tab(); await tab(); ref.press(1); ref.press(1);
    const previewed = (await snap()).active;
    // close a non-previewed tab mid-walk (e.g. cmd+w can't, but an agent/page can)
    await ev((_, id) => global.olive.focusedWindow().closeTab(id), ids[0]);
    let s = await snap();
    check(s.active === previewed && !s.order.includes(ids[0]), 'closing another tab mid-walk keeps the preview and drops the closed tab', s);
    await tab();
    await ctrlUp();
    s = await settled();
    check(!s.walk && s.order[0] === s.active && s.order.length === 4 && s.tabsOk !== false, 'walk keeps working after a mid-walk close and commits on release', s);
    // close the previewed tab mid-walk
    ({ ids, order } = await reset(5)); ref = new Ref(order);
    await ctrlDown(); await tab(); await tab();
    const p2 = (await snap()).active;
    await ev((_, id) => global.olive.focusedWindow().closeTab(id), p2);
    await tab(); await ctrlUp();
    s = await settled();
    check(!s.walk && s.active != null && !s.order.includes(p2) && s.order[0] === s.active && s.order.length === 4, 'closing the previewed tab mid-walk is safe', s);
    const before = s.order[1];
    await tap();
    s = await settled();
    check(s.active === before, 'next tap after close toggles to the previous tab', { s, before });
  },
};

try {
  app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [boot], cwd: repo,
    env: { ...process.env, OLIVE_FIXTURE_MAIN: path.join(repo, 'src/main/main.js'), OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'mru-regression', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' },
    timeout: 30000,
  });
  await install();
  if (process.env.MRU_DEBUG) await ev(() => { global.__mruDebug = true; });
  app.process().stdout.on('data', d => process.env.MRU_DEBUG && process.stdout.write(String(d).split('\n').filter(l => /BIE|SEND/.test(l)).map(l => '   ' + l + '\n').join('')));
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name) && !only.includes(name[0])) continue;
    scenario = name;
    try { await fn(); } catch (error) { check(false, 'exception', String(error.stack || error)); }
  }
} catch (error) { results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) }); console.error(error); }
finally {
  if (app) await app.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('scenarios: ' + Object.entries(scenarioResults).map(([k, v]) => `${k}:${v ? 'pass' : 'FAIL'}`).join(' '));
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
if (results.some(r => !r.ok)) process.exitCode = 1;
