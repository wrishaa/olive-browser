// local http api for ai agents. listens on 127.0.0.1 only. pairs with chromium's
// own CDP endpoint (remote-debugging-port) for full puppeteer/playwright control.
//
// requests from web pages are refused: we require the X-Olive-Agent header (a
// custom header forces a CORS preflight, which we never approve) and reject any
// request that carries an Origin header or a non-local Host.
const http = require('http');

function startAgentApi(mgr, port) {
  const server = http.createServer((req, res) => {
    handle(mgr, req, res).catch((err) => send(res, 500, { error: String(err?.message || err) }));
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
  note: 'send header X-Olive-Agent: 1 on every request. ids are olive tab ids; targetId is the CDP target id for the same page.',
  cdp: 'chromium devtools protocol is at the "cdp" url below (GET /json/version there for the browser websocket). playwright: chromium.connectOverCDP(cdp)',
  routes: {
    'GET /': 'this help + endpoints',
    'GET /tabs': 'list tabs in all windows',
    'POST /tabs {url, background?, windowId?, split?}': 'open a tab (split: true opens it next to the active tab)',
    'GET /tabs/:id': 'one tab',
    'POST /tabs/:id/activate': 'select it',
    'POST /tabs/:id/navigate {url}': 'load a url or search text, waits for load',
    'POST /tabs/:id/back | /forward | /reload | /close': '',
    'POST /tabs/:id/eval {expression}': 'run js in the page (awaits promises), returns {result}',
    'POST /tabs/:id/cdp {method, params}': 'send any CDP command to this tab via the built-in debugger',
    'GET /tabs/:id/screenshot': 'png of the visible page',
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

async function handle(mgr, req, res) {
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { error: 'bad host' });
  if (req.headers.origin) return send(res, 403, { error: 'requests from web pages are not allowed' });
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && parts.length === 0) return send(res, 200, { ...HELP, endpoints: mgr.agentInfo() });
  if (req.headers['x-olive-agent'] == null) return send(res, 401, { error: 'missing X-Olive-Agent header' });

  const m = req.method;
  if (parts[0] === 'tabs') {
    if (parts.length === 1) {
      if (m === 'GET') return send(res, 200, await Promise.all(mgr.allTabs().map(({ tab, win }) => describe(mgr, win, tab))));
      if (m === 'POST') {
        const b = await readJson(req);
        const win = (b.windowId && mgr.windows.find((w) => w.id === b.windowId)) || mgr.focusedWindow() || mgr.newWindow({});
        let tab;
        if (b.split) {
          const base = win.tabs.get(win.activeId);
          tab = win.createTab({ url: require('../core/url').toUrl(b.url || 'about:blank'), activate: false, afterId: base?.id });
          if (base) win.split(base.id, tab.id);
          else win.activate(tab.id);
        } else tab = win.createTab({ url: require('../core/url').toUrl(b.url || 'about:blank'), activate: !b.background });
        if (win.overlay === 'palette') win.setOverlay(null);
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
      win.ensureView(tab);
      const img = await tab.wc.capturePage();
      return send(res, 200, img.toPNG(), 'image/png');
    }
    if (m === 'GET' && action === 'text') {
      win.ensureView(tab);
      await waitLoad(tab);
      const text = await tab.wc.executeJavaScript('document.body ? document.body.innerText : ""', true);
      return send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const b = await readJson(req);
    switch (action) {
      case 'activate':
        win.win.focus();
        win.activate(tab.id);
        return send(res, 200, await describe(mgr, win, tab));
      case 'navigate':
        win.navigate(tab, b.url);
        await waitLoad(tab, b.timeout);
        return send(res, 200, await describe(mgr, win, tab));
      case 'back':
        tab.wc?.navigationHistory.goBack();
        await waitLoad(tab, b.timeout);
        return send(res, 200, await describe(mgr, win, tab));
      case 'forward':
        tab.wc?.navigationHistory.goForward();
        await waitLoad(tab, b.timeout);
        return send(res, 200, await describe(mgr, win, tab));
      case 'reload':
        win.reload(tab);
        await waitLoad(tab, b.timeout);
        return send(res, 200, await describe(mgr, win, tab));
      case 'close':
        win.closeTab(tab.id, { force: true }); // agents close for real, pinned or not
        return send(res, 200, { ok: true });
      case 'eval': {
        win.ensureView(tab);
        const result = await tab.wc.executeJavaScript(String(b.expression ?? ''), true);
        return send(res, 200, { result: result === undefined ? null : result });
      }
      case 'cdp': {
        win.ensureView(tab);
        const dbg = tab.wc.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const result = await dbg.sendCommand(String(b.method), b.params || {});
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
      const w = mgr.newWindow({ private: !!b.private, url: b.url });
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
