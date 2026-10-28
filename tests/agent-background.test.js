// agent api must never pull olive forward, and hidden agent tabs only run at full
// speed during an agent step. fakes only: no electron, no real profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AgentWake, withTimeout } = require('../src/main/agent-wake');
const { startAgentApi } = require('../src/main/agent-api');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDebugger({ hang = new Set() } = {}) {
  const d = { attached: false, sent: [], detaches: 0 };
  d.isAttached = () => d.attached;
  d.attach = () => { d.attached = true; };
  d.detach = () => { d.attached = false; d.detaches++; };
  d.sendCommand = (method, params) => {
    d.sent.push([method, params]);
    if (hang.has(method)) return new Promise(() => {});
    if (method === 'Target.getTargetInfo') return Promise.resolve({ targetInfo: { targetId: 'T' } });
    return Promise.resolve({ ok: method });
  };
  return d;
}

function fakeTab(id, dbgOpts) {
  const tab = { id, title: 't' + id, url: 'https://example.com/' + id, pinned: false, splitId: null, loading: false };
  tab.bounds = { x: 0, y: 0, width: 0, height: 0 };
  tab.view = { getBounds: () => tab.bounds, setBounds: (r) => { tab.bounds = r; } };
  tab.captureOpts = [];
  tab.wc = {
    debugger: fakeDebugger(dbgOpts),
    isLoading: () => false,
    isDestroyed: () => false,
    focusCalls: 0,
    focus() { this.focusCalls++; },
    executeJavaScript: async (expr) => `ran:${expr}`,
    capturePage: async (rect, opts) => { tab.captureOpts.push(opts); return { isEmpty: () => false, toPNG: () => Buffer.from('PNG') }; },
    on() {}, off() {},
    navigationHistory: { goBack() {}, goForward() {} },
  };
  return tab;
}

function fakeWindow(id, tabs, activeId) {
  const w = {
    id, isPrivate: false, activeId, tabs: new Map(tabs.map((t) => [t.id, t])), overlay: null,
    focusCalls: 0, activateCalls: [], created: [],
    win: { focused: false, isFocused() { return this.focused; }, focus: () => { w.focusCalls++; } },
    visibleIds: () => [w.activeId],
    allIds: () => [...w.tabs.keys()],
    ensureView: () => {},
    hiddenPaneRect: () => ({ x: 250, y: 8, width: 1000, height: 700 }),
    activate(tid, opts = {}) { w.activateCalls.push([tid, opts]); w.activeId = tid; if (opts.focusPage !== false) w.tabs.get(tid).wc.focus(); },
    createTab({ url, activate, focusPage } = {}) {
      const t = fakeTab(100 + w.created.length);
      t.url = url;
      w.tabs.set(t.id, t);
      w.created.push({ id: t.id, activate, focusPage });
      if (activate) w.activate(t.id, { focusPage });
      return t;
    },
    setOverlay: (o) => { w.overlay = o; },
    navigate() {}, reload() {}, closeTab: (tid) => w.tabs.delete(tid),
  };
  return w;
}

function fakeMgr() {
  const t1 = fakeTab(1), t2 = fakeTab(2);
  const win = fakeWindow(1, [t1, t2], 1);
  const mgr = {
    windows: [win], cdpPort: null, newWindowCalls: [],
    focusedWindow: () => win,
    newWindow(o) { mgr.newWindowCalls.push(o); return win; },
    allTabs: () => [...win.tabs.values()].map((tab) => ({ tab, win })),
    findTab: (id) => (win.tabs.has(id) ? { tab: win.tabs.get(id), win } : null),
    agentInfo: () => ({}),
  };
  return { mgr, win, t1, t2 };
}

async function api(t, mgr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-agent-bg-'));
  mgr.agentWake = new AgentWake({ lingerMs: 30 });
  const server = await startAgentApi(mgr, 0, dir);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(path.join(dir, 'agent-token'), 'utf8').trim();
  const port = server.address().port;
  return (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const s = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: j ?? s }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('activate selects the tab without focusing the window or the page', async (t) => {
  const { mgr, win, t2 } = fakeMgr();
  const call = await api(t, mgr);
  const r = await call('POST', '/tabs/2/activate');
  assert.equal(r.status, 200);
  assert.equal(win.activeId, 2);
  assert.equal(win.focusCalls, 0, 'no win.focus()');
  assert.equal(t2.wc.focusCalls, 0, 'unfocused window: page focus untouched');
  assert.deepEqual(win.activateCalls.at(-1), [2, { focusPage: false }]);
});

test('POST /tabs opens in the background by default, activate:true selects without focus', async (t) => {
  const { mgr, win } = fakeMgr();
  const call = await api(t, mgr);
  let r = await call('POST', '/tabs', { url: 'example.org' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false);
  assert.equal(win.activeId, 1, 'active tab unchanged');
  assert.equal(win.created[0].activate, false);
  assert.equal(win.tabs.get(win.created[0].id).wc.debugger.attached, false, 'opening alone attaches nothing');
  r = await call('POST', '/tabs', { url: 'example.org', background: true });
  assert.equal(win.activeId, 1);
  r = await call('POST', '/tabs', { url: 'example.org', activate: true });
  assert.equal(r.body.active, true);
  assert.equal(win.created.at(-1).focusPage, false);
  assert.equal(win.focusCalls, 0);
});

test('POST /windows opens an inactive window', async (t) => {
  const { mgr } = fakeMgr();
  const call = await api(t, mgr);
  await call('POST', '/windows', {});
  assert.equal(mgr.newWindowCalls[0].inactive, true);
});

test('screenshot of a hidden tab: stayHidden, size override only, no focus emulation', async (t) => {
  const { mgr, t2 } = fakeMgr();
  const call = await api(t, mgr);
  const r = await call('GET', '/tabs/2/screenshot');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'PNG');
  assert.deepEqual(t2.captureOpts, [{ stayHidden: true }]);
  const emu = t2.wc.debugger.sent.filter(([m]) => m.startsWith('Emulation'));
  assert.deepEqual(emu, [['Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 0, mobile: false }]]);
  await wait(80);
  assert.equal(t2.wc.debugger.attached, false, 'override dropped (detached) after the linger');
});

test('eval on a hidden tab emulates focus only during the step, then re-throttles and detaches', async (t) => {
  const { mgr, t2 } = fakeMgr();
  const call = await api(t, mgr);
  const r = await call('POST', '/tabs/2/eval', { expression: '1+1' });
  assert.equal(r.body.result, 'ran:1+1');
  const dbg = t2.wc.debugger;
  assert.deepEqual(dbg.sent.filter(([m]) => m.startsWith('Emulation')).map(([m, p]) => m + (p.enabled !== undefined ? ':' + p.enabled : '')), ['Emulation.setDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled:true']);
  assert.ok(mgr.agentWake.isAwake(t2));
  await wait(80);
  assert.equal(mgr.agentWake.isAwake(t2), false);
  assert.equal(dbg.attached, false, 'detached again: overrides gone, idle discarding sees it');
});

test('eval on the visible tab does not touch the debugger', async (t) => {
  const { mgr, t1 } = fakeMgr();
  const call = await api(t, mgr);
  await call('POST', '/tabs/1/eval', { expression: 'x' });
  assert.equal(t1.wc.debugger.sent.length, 0);
});

test('/cdp times out with 504 instead of hanging, and keeps the agent session attached', async (t) => {
  const { mgr, t2 } = fakeMgr();
  t2.wc.debugger = fakeDebugger({ hang: new Set(['Page.captureScreenshot']) });
  const call = await api(t, mgr);
  const t0 = Date.now();
  const r = await call('POST', '/tabs/2/cdp', { method: 'Page.captureScreenshot', timeout: 200 });
  assert.equal(r.status, 504);
  assert.match(r.body.error, /timed out/);
  assert.ok(Date.now() - t0 < 2000);
  await wait(80);
  assert.equal(t2.wc.debugger.attached, true, '/cdp users keep their session');
  const tail = t2.wc.debugger.sent.filter(([m]) => m.startsWith('Emulation')).slice(-2).map(([m, p]) => m + (p.enabled !== undefined ? ':' + p.enabled : ''));
  assert.deepEqual(tail, ['Emulation.setFocusEmulationEnabled:false', 'Emulation.clearDeviceMetricsOverride'], 'overrides turned off explicitly');
});

test('overlapping steps keep the tab awake until the last one ends', async () => {
  const wake = new AgentWake({ lingerMs: 10 });
  const tab = fakeTab(5);
  const win = fakeWindow(1, [fakeTab(1), tab], 1);
  let release;
  const slow = wake.step(win, tab, () => new Promise((r) => { release = r; }));
  await wake.step(win, tab, async () => 1);
  await wait(30);
  assert.ok(wake.isAwake(tab), 'still awake while the slow step runs');
  release();
  await slow;
  await wait(30);
  assert.equal(wake.isAwake(tab), false);
  assert.equal(tab.wc.debugger.sent.filter(([, p]) => p?.enabled === true).length, 1, 'woken once');
});

test('selecting the tab for real drops the overrides at once', async () => {
  const wake = new AgentWake({ lingerMs: 10000 });
  const tab = fakeTab(5);
  const win = fakeWindow(1, [fakeTab(1), tab], 1);
  await wake.step(win, tab, async () => 1);
  assert.ok(wake.isAwake(tab));
  await wake.sleep(tab);
  assert.equal(wake.isAwake(tab), false);
  assert.equal(tab.wc.debugger.attached, false);
});

test('withTimeout passes values through and rejects late ones', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'x'), { code: 'ETIMEDOUT' });
});
