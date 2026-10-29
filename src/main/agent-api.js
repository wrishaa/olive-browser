// local http api for ai agents. listens on 127.0.0.1 only. pairs with chromium's
// own CDP endpoint (remote-debugging-port) for full puppeteer/playwright control.
//
// every request needs the secret token from <userData>/agent-token (mode 0600,
// created on first launch) as `Authorization: Bearer <token>` (or X-Olive-Token).
// on top of that, requests with an Origin header (web pages) or a non-local Host
// (dns rebinding) are refused before the token is even looked at.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AgentWake, withTimeout } = require('./agent-wake');

// agents work in the background: no call here may focus a window, activate the
// app, or (unless asked) change the tab the user is looking at.
const CDP_TIMEOUT_MS = 15000;
const SCREENSHOT_TIMEOUT_MS = 10000;

// load or create the token file. always 0600; regenerated if missing, short, or
// readable by group/others.
function loadToken(dir) {
  const file = path.join(dir, 'agent-token');
  try {
    const st = fs.statSync(file);
    const tok = fs.readFileSync(file, 'utf8').trim();
    if ((st.mode & 0o077) === 0 && st.uid === process.getuid() && /^[A-Za-z0-9_-]{32,}$/.test(tok)) return { file, token: tok };
  } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  try { fs.unlinkSync(file); } catch {}
  fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return { file, token };
}

function tokenOk(req, token) {
  const auth = req.headers.authorization || '';
  const given = (auth.match(/^Bearer\s+(\S+)$/i) || [])[1] || req.headers['x-olive-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startAgentApi(mgr, port, dir) {
  const { token, file } = loadToken(dir);
  mgr.agentTokenFile = file;
  mgr.agentWake = mgr.agentWake || new AgentWake();
  const server = http.createServer((req, res) => {
    handle(mgr, req, res, token).catch((err) => send(res, err?.code === 'ETIMEDOUT' ? 504 : 500, { error: String(err?.message || err) }));
  });
  return new Promise((resolve) => {
    server.once('error', (err) => {
      console.error('[olive] agent api failed to listen on', port, err.code);
      if (port !== 0) {
        server.listen(0, '127.0.0.1', () => resolve(server));
      } else resolve(null);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function send(res, code, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  res.writeHead(code, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5 * 1024 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const HELP = {
  name: 'olive agent api',
  note: 'send `Authorization: Bearer <token>` on every request; the token is in agent-token next to agent.json (mode 0600). ids are olive tab ids; targetId is the CDP target id for the same page.',
  cdp: 'chromium devtools protocol is at the "cdp" url below (GET /json/version there for the browser websocket). playwright: chromium.connectOverCDP(cdp)',
  routes: {
    'GET /': 'this help + endpoints',
    'GET /tabs': 'list tabs in all windows',
    'POST /tabs {url, activate?, windowId?, split?, group?}': 'open a tab in the background (shows in the sidebar, not selected). activate: true (or background: false) also selects it, still without focusing the window. split: true opens it next to the active tab. group: <group id> or {name, status?} opens it inside that agent tab group (created from {name}), collapsed at the bottom of the sidebar, always in the background',
    'GET /groups': 'tab groups in all windows: id, name, agent, section ("agent" for api-made, "list" for the user\'s), working, status, collapsed, tabIds',
    'POST /groups {name, status?, collapsed?, windowId?}': 'make an agent tab group (name 1-60 chars, a task noun phrase: "Flights to Lisbon"). it sits collapsed at the bottom of the sidebar; open tabs into it with POST /tabs {group: id}',
    'PATCH /groups/:id {name?, status?, working?, collapsed?}': 'rename (409 once the user renamed it), set the one-line status under the name (≤ 40 chars, present tense: "comparing 3 fares"), end the run with working:false (the pulse stops; an empty group is removed)',
    'POST /groups/:id/close': 'close every tab in the group and remove it',
    'GET /tabs/:id': 'one tab',
    'POST /tabs/:id/activate': 'select it inside its window. never focuses the window or brings olive forward',
    'POST /tabs/:id/navigate {url, frames?}': 'load a url or search text, waits for load',
    'POST /tabs/:id/back | /forward | /reload | /close {frames?}': '',
    'POST /tabs/:id/eval {expression, frames?}': 'run js in the page (awaits promises), returns {result}. a background tab runs timers at full speed during a step but draws ~1 frame/s; frames: true also draws at full frame rate (~60/s) for that step only',
    'POST /tabs/:id/cdp {method, params, timeout?, frames?}': 'send any CDP command to this tab via the built-in debugger (times out after `timeout` ms, default 15000, with 504). a size set with Emulation.setDeviceMetricsOverride is kept until you clear it',
    'POST /tabs/:id/frames {on?, ms?}': 'full frame rate for a background tab for `ms` (default 30000, max 600000), e.g. to watch an animation or video; on: false ends it now. off by default; ends by itself. returns {frames, framesUntil}',
    'GET /tabs/:id/screenshot': 'png of the page, works for background tabs without waking them',
    'GET /tabs/:id/text': 'document.body.innerText',
    'POST /tabs/:id/devtools': 'toggle docked devtools',
    'POST /tabs/:id/split {with}': 'show tab :id next to tab `with`',
    'GET /windows': 'windows',
    'POST /windows {private?, url?}': 'open a window',
    'GET /history?q=': 'browsing history',
    'GET /downloads': 'downloads',
    'POST /discard {olderThanMinutes?}': 'unload background tabs idle longer than that (default: settings.discardMinutes)',
    'GET /metrics': 'process count + memory',
  },
};

async function handle(mgr, req, res, token) {
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { error: 'bad host' });
  if (req.headers.origin != null || req.headers['sec-fetch-site'] != null) return send(res, 403, { error: 'requests from web pages are not allowed' });
  if (!tokenOk(req, token)) return send(res, 401, { error: 'missing or wrong token: send Authorization: Bearer <contents of agent-token next to agent.json>' });
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && parts.length === 0) return send(res, 200, { ...HELP, endpoints: mgr.agentInfo() });

  const m = req.method;
  if (parts[0] === 'tabs') {
    if (parts.length === 1) {
      if (m === 'GET') return send(res, 200, await Promise.all(mgr.allTabs().map(({ tab, win }) => describe(mgr, win, tab))));
      if (m === 'POST') {
        const b = await readJson(req);
        const win = (b.windowId && mgr.windows.find((w) => w.id === b.windowId)) || mgr.focusedWindow() || mgr.newWindow({ inactive: true });
        const activate = b.activate === true || b.background === false;
        let tab;
        if (b.group != null) {
          // tab group hook: open inside an agent group, always in the background (3.1)
          const g = resolveGroup(mgr, win, b.group);
          if (g.error) return send(res, g.code, { error: g.error });
          tab = g.win.createTab({ url: require('../core/url').toUrl(b.url || 'about:blank'), activate: false, focusPage: false, groupId: g.group.id });
          g.win.touchGroup(g.group.id);
          await waitLoad(tab, b.timeout);
          return send(res, 200, await describe(mgr, g.win, tab));
        }
        if (b.split) {
          const base = win.tabs.get(win.activeId);
          tab = win.createTab({ url: require('../core/url').toUrl(b.url || 'about:blank'), activate: false, afterId: base?.id });
          if (base) win.split(base.id, tab.id);
          else win.activate(tab.id, { focusPage: false });
        } else tab = win.createTab({ url: require('../core/url').toUrl(b.url || 'about:blank'), activate, focusPage: false });
        if (activate && win.overlay === 'palette') win.setOverlay(null);
        await waitLoad(tab, b.timeout);
        return send(res, 200, await describe(mgr, win, tab));
      }
    }
    const found = mgr.findTab(Number(parts[1]));
    if (!found) return send(res, 404, { error: 'no such tab' });
    const { tab, win } = found;
    const action = parts[2] || '';
    if (m === 'GET' && !action) return send(res, 200, await describe(mgr, win, tab));
    if (m === 'GET' && action === 'screenshot') {
      // stayHidden: capture without flipping the page to visible (which unthrottles it)
      const img = await mgr.agentWake.step(win, tab, () => captureHidden(tab.wc), { focus: false });
      if (img.isEmpty()) return send(res, 500, { error: 'empty screenshot' });
      return send(res, 200, img.toPNG(), 'image/png');
    }
    if (m === 'GET' && action === 'text') {
      const text = await mgr.agentWake.step(win, tab, async () => {
        await waitLoad(tab);
        return tab.wc.executeJavaScript('document.body ? document.body.innerText : ""', true);
      }, { focus: false });
      return send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const b = await readJson(req);
    // tab group hook: any api step on a grouped tab means its agent is working
    if (tab.groupId != null && win.groups.get(tab.groupId)?.agent && action !== 'close') win.touchGroup(tab.groupId);
    switch (action) {
      case 'activate':
        // select inside the window only. no win.focus()/app activation: that pulled
        // olive in front of whatever the user was doing.
        win.activate(tab.id, { focusPage: win.win.isFocused() });
        return send(res, 200, await describe(mgr, win, tab));
      case 'navigate':
        await mgr.agentWake.step(win, tab, async () => { win.navigate(tab, b.url); await waitLoad(tab, b.timeout); }, { frames: b.frames === true });
        return send(res, 200, await describe(mgr, win, tab));
      case 'back':
        await mgr.agentWake.step(win, tab, async () => { tab.wc?.navigationHistory.goBack(); await waitLoad(tab, b.timeout); }, { frames: b.frames === true });
        return send(res, 200, await describe(mgr, win, tab));
      case 'forward':
        await mgr.agentWake.step(win, tab, async () => { tab.wc?.navigationHistory.goForward(); await waitLoad(tab, b.timeout); }, { frames: b.frames === true });
        return send(res, 200, await describe(mgr, win, tab));
      case 'reload':
        await mgr.agentWake.step(win, tab, async () => { win.reload(tab); await waitLoad(tab, b.timeout); }, { frames: b.frames === true });
        return send(res, 200, await describe(mgr, win, tab));
      case 'close':
        // agents close for real, pinned or not. by:'agent' is the tab group hook: an agent
        // emptying its own working group keeps the group for the grace window (2.6)
        if (tab.groupId != null) win.touchGroup(tab.groupId);
        win.closeTab(tab.id, { force: true, by: 'agent' });
        return send(res, 200, { ok: true });
      case 'eval': {
        const result = await mgr.agentWake.step(win, tab, () => tab.wc.executeJavaScript(String(b.expression ?? ''), true), { frames: b.frames === true });
        return send(res, 200, { result: result === undefined ? null : result });
      }
      case 'cdp': {
        const timeout = Number(b.timeout) > 0 ? Number(b.timeout) : CDP_TIMEOUT_MS;
        tab.agentCdp = true; // the agent owns this debugger session now: keep it attached
        const method = String(b.method);
        const result = await mgr.agentWake.step(win, tab, async () => {
          const dbg = tab.wc.debugger;
          if (!dbg.isAttached()) dbg.attach('1.3');
          const sent = dbg.sendCommand(method, b.params || {});
          // a hidden view only draws when something asks for a frame: on a static
          // page Page.captureScreenshot waits forever. a stayHidden capturePage
          // makes the compositor draw without showing or unthrottling the page.
          const stop = { done: false };
          Promise.resolve(sent).then(() => { stop.done = true; }, () => { stop.done = true; });
          const pump = method === 'Page.captureScreenshot' && !win.visibleIds().includes(tab.id) ? pumpFrames(tab.wc, stop) : null;
          try {
            const r = await withTimeout(sent, timeout, `cdp ${method}`);
            mgr.agentWake.noteCdp(tab, method, b.params);
            return r;
          } finally {
            stop.done = true;
            await pump?.catch(() => {});
          }
        }, { frames: b.frames === true });
        return send(res, 200, { result });
      }
      case 'frames':
        return send(res, 200, { id: tab.id, ...(await mgr.agentWake.frames(win, tab, { on: b.on !== false, ms: b.ms })) });
      case 'devtools':
        win.toggleDevtools(tab);
        return send(res, 200, { ok: true, open: !!tab.devtools });
      case 'split': {
        const other = mgr.findTab(Number(b.with));
        if (!other || other.win !== win) return send(res, 400, { error: '`with` must be a tab id in the same window' });
        win.split(other.tab.id, tab.id);
        return send(res, 200, await describe(mgr, win, tab));
      }
      default:
        return send(res, 404, { error: 'unknown action' });
    }
  }
  if (parts[0] === 'groups') {
    // tab groups (notes/tab-groups-mac-design.md 3.3)
    if (parts.length === 1) {
      if (m === 'GET') return send(res, 200, mgr.windows.flatMap((w) => [...w.groups.values()].map((g) => w.groupInfo(g))));
      if (m === 'POST') {
        const b = await readJson(req);
        const win = (b.windowId && mgr.windows.find((w) => w.id === b.windowId)) || mgr.focusedWindow() || mgr.newWindow({ inactive: true });
        if (b.name != null && !require('../core/tab-groups').cleanName(String(b.name))) return send(res, 400, { error: 'name must be 1-60 characters' });
        const g = win.createAgentGroup({ name: b.name != null ? String(b.name) : '', status: b.status != null ? String(b.status) : '', collapsed: b.collapsed !== false });
        return send(res, 200, win.groupInfo(g));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    const found = findGroup(mgr, Number(parts[1]));
    if (!found) return send(res, 404, { error: 'no such group' });
    const { group, win } = found;
    const action = parts[2] || '';
    if (m === 'GET' && !action) return send(res, 200, win.groupInfo(group));
    if (m === 'PATCH' && !action) {
      const b = await readJson(req);
      const r = win.patchGroup(group.id, b);
      if (r.error) return send(res, r.code, { error: r.error });
      return send(res, 200, r.group ? win.groupInfo(r.group) : { ok: true, removed: true });
    }
    if (m === 'POST' && action === 'close') {
      win.closeGroup(group.id, { by: 'agent' });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown action' });
  }
  if (parts[0] === 'windows') {
    if (m === 'GET') return send(res, 200, mgr.windows.map((w) => ({ id: w.id, private: w.isPrivate, activeTabId: w.activeId, tabIds: w.allIds(), focused: mgr.focused === w })));
    if (m === 'POST') {
      const b = await readJson(req);
      const w = mgr.newWindow({ private: !!b.private, url: b.url, inactive: true });
      return send(res, 200, { id: w.id, private: w.isPrivate });
    }
  }
  if (parts[0] === 'history' && m === 'GET') {
    return send(res, 200, mgr.history.list({ query: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit') || 100) }));
  }
  if (parts[0] === 'downloads' && m === 'GET') return send(res, 200, mgr.downloads);
  if (parts[0] === 'discard' && m === 'POST') {
    const b = await readJson(req);
    return send(res, 200, { discarded: mgr.discardIdleTabs({ olderThanMinutes: b.olderThanMinutes ?? null }) });
  }
  if (parts[0] === 'metrics' && m === 'GET') {
    const { app } = require('electron');
    const procs = app.getAppMetrics();
    const mb = (k) => Math.round(procs.reduce((s, p) => s + (p.memory?.[k] || 0), 0) / 1024);
    return send(res, 200, { processes: procs.length, workingSetMB: mb('workingSetSize'), privateMB: mb('privateBytes'), loadedTabs: mgr.allTabs().filter((x) => x.tab.wc).length, tabs: mgr.allTabs().length });
  }
  return send(res, 404, { error: 'not found', help: 'GET /' });
}

function findGroup(mgr, id) {
  for (const win of mgr.windows) {
    const group = win.groups?.get(id);
    if (group) return { group, win };
  }
  return null;
}

// POST /tabs {group}: an existing group's id, or {name, status?} to make one in `win`
function resolveGroup(mgr, win, spec) {
  if (typeof spec === 'number' || (typeof spec === 'string' && /^\d+$/.test(spec))) {
    const found = findGroup(mgr, Number(spec));
    if (!found) return { error: 'no such group: make one with POST /groups or pass {name}', code: 404 };
    return found;
  }
  if (spec && typeof spec === 'object') {
    if (spec.name != null && !require('../core/tab-groups').cleanName(String(spec.name))) return { error: 'group.name must be 1-60 characters', code: 400 };
    const group = win.createAgentGroup({ name: spec.name != null ? String(spec.name) : '', status: spec.status != null ? String(spec.status) : '', collapsed: spec.collapsed !== false });
    return { group, win };
  }
  return { error: 'group must be an id or {name, status?}', code: 400 };
}

function waitLoad(tab, timeout = 30000) {
  return new Promise((resolve) => {
    const wc = tab.wc;
    if (!wc || !wc.isLoading()) return setTimeout(resolve, 50);
    const done = () => {
      clearTimeout(t);
      wc.off('did-stop-loading', done);
      resolve();
    };
    const t = setTimeout(done, timeout);
    wc.on('did-stop-loading', done);
  });
}

async function targetIdFor(tab) {
  const wc = tab.wc;
  if (!wc) return null;
  if (tab.targetId) return tab.targetId;
  try {
    const dbg = wc.debugger;
    const attached = dbg.isAttached();
    if (!attached) dbg.attach('1.3');
    const { targetInfo } = await dbg.sendCommand('Target.getTargetInfo');
    if (!attached) dbg.detach();
    tab.targetId = targetInfo.targetId;
  } catch {
    tab.targetId = null;
  }
  return tab.targetId;
}

// stayHidden capture that copes with a view that never drew: the first
// capture of a never-shown tab (or right after the step's size override)
// can fail with UnknownVizError or come back empty because the compositor has
// no frame yet. that first request makes it draw one, so retry a few times,
// still hidden, within the overall screenshot timeout.
const CAPTURE_RETRIES = 3;
async function captureHidden(wc, { timeoutMs = SCREENSHOT_TIMEOUT_MS, retries = CAPTURE_RETRIES, delayMs = 150 } = {}) {
  const until = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    let img, err;
    try {
      img = await withTimeout(wc.capturePage(undefined, { stayHidden: true }), Math.max(until - Date.now(), 1), 'screenshot');
    } catch (e) {
      if (e?.code === 'ETIMEDOUT' || !/viz/i.test(String(e?.message || e))) throw e;
      err = e;
    }
    if (img && !img.isEmpty()) return img;
    if (i >= retries || Date.now() + delayMs >= until || wc.isDestroyed()) {
      if (err) throw err;
      return img;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// keep the compositor of a hidden view drawing until stop.done (stayHidden
// captures, one at a time, each asks for one frame)
async function pumpFrames(wc, stop) {
  await new Promise((r) => setTimeout(r, 50));
  while (!stop.done && !wc.isDestroyed()) {
    await withTimeout(wc.capturePage(undefined, { stayHidden: true }), 2000, 'frame').catch(() => {});
    if (!stop.done) await new Promise((r) => setTimeout(r, 100));
  }
}

async function describe(mgr, win, tab) {
  const targetId = await targetIdFor(tab);
  const cdp = mgr.cdpPort;
  return {
    id: tab.id,
    windowId: win.id,
    private: win.isPrivate,
    title: tab.title,
    url: tab.errorFor || tab.url,
    active: win.activeId === tab.id,
    visible: win.visibleIds().includes(tab.id),
    pinned: tab.pinned,
    splitId: tab.splitId,
    groupId: tab.groupId ?? null,
    loading: tab.loading,
    loaded: !!tab.wc,
    frames: mgr.agentWake?.describe(win, tab).frames ?? false,
    targetId,
    webSocketDebuggerUrl: targetId && cdp ? `ws://127.0.0.1:${cdp}/devtools/page/${targetId}` : null,
  };
}

module.exports = { startAgentApi };
