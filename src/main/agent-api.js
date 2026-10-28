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
    'POST /tabs {url, activate?, windowId?, split?}': 'open a tab in the background (shows in the sidebar, not selected). activate: true (or background: false) also selects it, still without focusing the window. split: true opens it next to the active tab',
    'GET /tabs/:id': 'one tab',
    'POST /tabs/:id/activate': 'select it inside its window. never focuses the window or brings olive forward',
    'POST /tabs/:id/navigate {url}': 'load a url or search text, waits for load',
    'POST /tabs/:id/back | /forward | /reload | /close': '',
    'POST /tabs/:id/eval {expression}': 'run js in the page (awaits promises), returns {result}',
    'POST /tabs/:id/cdp {method, params, timeout?}': 'send any CDP command to this tab via the built-in debugger (times out after `timeout` ms, default 15000, with 504)',
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
      const img = await mgr.agentWake.step(win, tab, () => withTimeout(tab.wc.capturePage(undefined, { stayHidden: true }), SCREENSHOT_TIMEOUT_MS, 'screenshot'), { focus: false });
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
    switch (action) {
      case 'activate':
        // select inside the window only. no win.focus()/app activation: that pulled
        // olive in front of whatever the user was doing.
        win.activate(tab.id, { focusPage: win.win.isFocused() });
        return send(res, 200, await describe(mgr, win, tab));
      case 'navigate':
        await mgr.agentWake.step(win, tab, async () => { win.navigate(tab, b.url); await waitLoad(tab, b.timeout); });
        return send(res, 200, await describe(mgr, win, tab));
      case 'back':
        await mgr.agentWake.step(win, tab, async () => { tab.wc?.navigationHistory.goBack(); await waitLoad(tab, b.timeout); });
        return send(res, 200, await describe(mgr, win, tab));
      case 'forward':
        await mgr.agentWake.step(win, tab, async () => { tab.wc?.navigationHistory.goForward(); await waitLoad(tab, b.timeout); });
        return send(res, 200, await describe(mgr, win, tab));
      case 'reload':
        await mgr.agentWake.step(win, tab, async () => { win.reload(tab); await waitLoad(tab, b.timeout); });
        return send(res, 200, await describe(mgr, win, tab));
      case 'close':
        win.closeTab(tab.id, { force: true }); // agents close for real, pinned or not
        return send(res, 200, { ok: true });
      case 'eval': {
        const result = await mgr.agentWake.step(win, tab, () => tab.wc.executeJavaScript(String(b.expression ?? ''), true));
        return send(res, 200, { result: result === undefined ? null : result });
      }
      case 'cdp': {
        const timeout = Number(b.timeout) > 0 ? Number(b.timeout) : CDP_TIMEOUT_MS;
        tab.agentCdp = true; // the agent owns this debugger session now: keep it attached
        const result = await mgr.agentWake.step(win, tab, () => {
          const dbg = tab.wc.debugger;
          if (!dbg.isAttached()) dbg.attach('1.3');
          return withTimeout(dbg.sendCommand(String(b.method), b.params || {}), timeout, `cdp ${b.method}`);
        });
        return send(res, 200, { result });
      }
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
    loading: tab.loading,
    loaded: !!tab.wc,
    targetId,
    webSocketDebuggerUrl: targetId && cdp ? `ws://127.0.0.1:${cdp}/devtools/page/${targetId}` : null,
  };
}

module.exports = { startAgentApi };
