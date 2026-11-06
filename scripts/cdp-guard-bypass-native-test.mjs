import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
// tries to get a browser-wide cookie / storage clear past olive's raw-port proxy
// (src/main/cdp-proxy.js -> src/main/cdp-guard.js) and the agent api (/tabs/:id/cdp):
// browser-level ws (/json/version) and page-level ws (/json/list), flat sessions from
// Target.attachToTarget / Target.setAutoAttach, Target.sendMessageToTarget, json parser
// tricks (duplicate keys, binary frames), plain http /json/*, and the hidden real port.
// disposable electron fixture only (temp OLIVE_USER_DATA_DIR, api + cdp port 0); never
// touches installed olive, 9222/9333 or a real profile. prints cookie COUNTS only.
// run: node scripts/cdp-guard-bypass-native-test.mjs
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-cdp-bypass-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const BLOCK = 'blocked by olive: browser-wide clear; use per-site delete';
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const info = (label, detail) => console.log('INFO ' + label + ' ' + JSON.stringify(detail));
let app, site; const sockets = [];
const wsOpen = async (url) => {
  const ws = new WebSocket(url); sockets.push(ws);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws open failed ' + url.replace(/[0-9A-F-]{32,36}/gi, '<id>'))); });
  let seq = 1000; const waiting = new Map(); const events = [];
  ws.onmessage = async (e) => { const text = typeof e.data === 'string' ? e.data : Buffer.from(await e.data.arrayBuffer()).toString(); const m = JSON.parse(text); if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) events.push(m); };
  const wait = (id, ms = 4000) => new Promise((r) => { waiting.set(id, r); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); r({ timeout: true }); } }, ms); });
  return {
    ws, events,
    send: (method, params = {}, sessionId) => { const id = ++seq; const p = wait(id); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return p; },
    sendText: (build) => { const id = ++seq; const p = wait(id); ws.send(build(id)); return p; },
    sendBinary: (obj) => { const id = ++seq; const p = wait(id); ws.send(Buffer.from(JSON.stringify({ id, ...obj }))); return p; },
  };
};
try {
  site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>cdp bypass fixture</title><body>fixture</body>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const P = site.address().port;
  const A = `http://localhost:${P}`, B = `http://127.0.0.1:${P}`;
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'cdp-bypass-regression', OLIVE_CDP: '1', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  const px = await app.evaluate(async ({ app: eapp }) => { while (!global.olive?.ready || !global.olive.apiPort) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding.close(); return { api: global.olive.apiPort, cdp: global.olive.cdpPort, raw: global.olive.cdpRawPort, userData: eapp.getPath('userData') }; });
  if (!px.userData.startsWith(root) || !px.api || !px.cdp || [9222, 9333].includes(px.api) || [9222, 9333].includes(px.cdp)) throw new Error('fixture is not isolated: ' + JSON.stringify({ api: px.api, cdp: px.cdp }));
  const token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${px.api}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  const seed = () => app.evaluate(async (_, { A, B }) => {
    const c = global.olive.session.cookies;
    for (const [url, names] of [[A, ['a1', 'a2', 'a3']], [B, ['b1', 'b2']]]) for (const name of names) await c.set({ url, name, value: 'x', expirationDate: Date.now() / 1000 + 3600 });
  }, { A, B });
  const counts = () => app.evaluate(async (_, { A, B }) => {
    const all = await global.olive.session.cookies.get({});
    const host = (h) => all.filter((c) => c.domain === h).length;
    return { total: all.length, a: host(new URL(A).hostname), b: host(new URL(B).hostname) };
  }, { A, B });
  await seed();
  const tab = await api('POST', '/tabs', { url: A + '/' });
  check(tab.status === 200 && tab.json?.targetId, 'opened a fixture tab', { status: tab.status });
  const targetId = tab.json?.targetId;
  const base = await counts();
  check(base.a === 3 && base.b === 2, 'seeded 3 + 2 cookies on two throwaway hosts', base);

  // the wipe list, every one must be refused with the olive error and leave the count alone
  const WIPES = [
    ['Network.clearBrowserCookies', {}],
    ['Storage.clearCookies', {}],
    ['Storage.clearCookies', { browserContextId: 'not-a-created-context' }],
    ['Storage.clearDataForOrigin', { origin: '*', storageTypes: 'all' }],
    ['Storage.clearDataForOrigin', { origin: '', storageTypes: 'all' }],
    ['Storage.clearDataForOrigin', { storageTypes: 'all' }],
    ['Storage.clearDataForStorageKey', { storageKey: '*', storageTypes: 'all' }],
    ['Storage.clearDataForStorageKey', { storageKey: '', storageTypes: 'all' }],
    ['Storage.clearDataForStorageKey', { storageTypes: 'all' }],
    ['Storage.clearSharedStorageEntries', { ownerOrigin: '*' }],
    ['Storage.deleteStorageBucket', { bucket: { storageKey: '*', name: 'x' } }],
    ['Network.deleteCookies', { name: 'a1' }],
  ];
  const tryWipe = async (label, run) => {
    await seed();
    const before = await counts();
    const r = await run();
    const after = await counts();
    check(r?.error?.message === BLOCK && after.total === before.total && after.a === before.a && after.b === before.b, label, { error: r?.error?.message, timeout: r?.timeout, before, after });
  };

  // 1. agent api /tabs/:id/cdp (port 9333 in real olive; fixture port here)
  for (const [m, p] of WIPES) await tryWipe(`agent api: ${m} ${JSON.stringify(p).slice(0, 50)}`, async () => { const r = await api('POST', `/tabs/${tab.json.id}/cdp`, { method: m, params: p }); return { error: { message: r.status === 403 ? r.json?.error : `status ${r.status}` } }; });
  for (const [m, p] of [['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }], ['Target.attachToBrowserTarget', {}]]) {
    const r = await api('POST', `/tabs/${tab.json.id}/cdp`, { method: m, params: p });
    info(`agent api: ${m} (no sessionId routing on this endpoint)`, { status: r.status, error: r.json?.error?.slice?.(0, 60) });
  }
  await tryWipe('agent api: Target.sendMessageToTarget wrapping Network.clearBrowserCookies', async () => { const r = await api('POST', `/tabs/${tab.json.id}/cdp`, { method: 'Target.sendMessageToTarget', params: { targetId, message: JSON.stringify({ id: 1, method: 'Network.clearBrowserCookies' }) } }); return { error: { message: r.status === 403 ? r.json?.error : `status ${r.status}` } }; });

  // 2. raw port, browser-level ws from /json/version, page-level ws from /json/list
  const ver = await (await fetch(`http://127.0.0.1:${px.cdp}/json/version`)).json();
  const list = await (await fetch(`http://127.0.0.1:${px.cdp}/json/list`)).json();
  const pageEntry = list.find((t) => t.id === targetId);
  check(ver.webSocketDebuggerUrl?.includes(`:${px.cdp}/`) && pageEntry?.webSocketDebuggerUrl?.includes(`:${px.cdp}/`), '/json/version and /json/list hand out proxy websockets', { page: !!pageEntry });
  const bodies = JSON.stringify([ver, list]);
  check(!bodies.includes(`:${px.raw}`), 'no /json body names chromium\'s hidden port');
  const browser = await wsOpen(ver.webSocketDebuggerUrl);
  const page = await wsOpen(pageEntry.webSocketDebuggerUrl);
  const att = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const sid = att.result?.sessionId;
  check(sid, 'browser ws: Target.attachToTarget flatten:true gives a session', { error: att.error?.message });
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await new Promise((r) => setTimeout(r, 500));
  const auto = browser.events.find((e) => e.method === 'Target.attachedToTarget' && e.params?.targetInfo?.targetId === targetId)?.params?.sessionId;
  info('browser ws: Target.setAutoAttach session for the fixture page', { got: !!auto });
  const bpAtt = await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  info('page ws: Target.setAutoAttach', { error: bpAtt.error?.message || null });
  for (const [m, p] of WIPES) {
    await tryWipe(`raw browser ws: ${m} ${JSON.stringify(p).slice(0, 50)}`, () => browser.send(m, p));
    await tryWipe(`raw page ws: ${m} ${JSON.stringify(p).slice(0, 50)}`, () => page.send(m, p));
    await tryWipe(`raw flat attachToTarget session: ${m} ${JSON.stringify(p).slice(0, 50)}`, () => browser.send(m, p, sid));
    if (auto) await tryWipe(`raw setAutoAttach session: ${m} ${JSON.stringify(p).slice(0, 50)}`, () => browser.send(m, p, auto));
  }
  await tryWipe('raw browser ws: Target.sendMessageToTarget(sessionId) wrapping Network.clearBrowserCookies', () => browser.send('Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 7, method: 'Network.clearBrowserCookies' }) }));
  await tryWipe('raw browser ws: Target.sendMessageToTarget(targetId) wrapping Storage.clearDataForOrigin *', () => browser.send('Target.sendMessageToTarget', { targetId, message: JSON.stringify({ id: 8, method: 'Storage.clearDataForOrigin', params: { origin: '*', storageTypes: 'all' } }) }));
  await tryWipe('raw browser ws: Target.attachToBrowserTarget session + Network.clearBrowserCookies', async () => { const b2 = (await browser.send('Target.attachToBrowserTarget', {})).result?.sessionId; return browser.send('Network.clearBrowserCookies', {}, b2); });
  // json parser differences: what the guard reads must be what chromium runs. pass = no
  // browser-wide wipe (host A, never named, keeps its cookies), refused by olive or chromium
  const noWipe = async (label, run) => {
    await seed();
    const before = await counts();
    const r = await run();
    const after = await counts();
    check(after.a === before.a && (r?.error || after.b === before.b || after.b === 0), label, { error: r?.error?.message, before, after });
  };
  await noWipe('raw: duplicate "method" key (allowed one last)', () => page.sendText((id) => `{"id":${id},"method":"Network.clearBrowserCookies","params":{},"method":"Runtime.evaluate"}`));
  await noWipe('raw: duplicate "method" key (allowed one first)', () => page.sendText((id) => `{"id":${id},"method":"Runtime.evaluate","params":{},"method":"Network.clearBrowserCookies"}`));
  await noWipe('raw: duplicate "params" key on Storage.clearDataForOrigin', () => page.sendText((id) => `{"id":${id},"method":"Storage.clearDataForOrigin","params":{"origin":"*","storageTypes":"all"},"params":{"origin":"${B}","storageTypes":"cookies"}}`));
  await noWipe('raw: duplicate "origin" key inside params', () => page.sendText((id) => `{"id":${id},"method":"Storage.clearDataForOrigin","params":{"origin":"*","storageTypes":"all","origin":"${B}"}}`));
  await noWipe('raw: duplicate "origin" key inside params (real one first)', () => page.sendText((id) => `{"id":${id},"method":"Storage.clearDataForOrigin","params":{"origin":"${B}","storageTypes":"all","origin":"*"}}`));
  await tryWipe('raw: \\u-escaped method name', () => page.sendText((id) => `{"id":${id},"method":"Network.clear\\u0042rowserCookies"}`));
  await tryWipe('raw: binary websocket frame', () => page.sendBinary({ method: 'Network.clearBrowserCookies' }));
  // plain http on the proxy: /json/new etc must not carry a cdp command
  const httpCodes = {};
  for (const p of ['/json/new?about:blank', '/json/protocol', '/json', '/devtools/browser/x?method=Network.clearBrowserCookies']) {
    try { const r = await fetch(`http://127.0.0.1:${px.cdp}${p}`, { method: 'PUT' }); httpCodes[p.split('?')[0]] = r.status; } catch (e) { httpCodes[p] = String(e.message); }
  }
  const hc = await counts();
  check(hc.total === base.total || hc.a === 3, 'plain http on the proxy (/json/new, /json, /devtools/... GET) clears nothing', { httpCodes, hc });

  // per-site deletes still work (raw page ws and agent api)
  await seed();
  let q = await page.send('Network.deleteCookies', { name: 'a1', domain: 'localhost' });
  let qc = await counts();
  check(!q.error && qc.a === 2 && qc.b === 2, 'raw page ws: Network.deleteCookies with domain deletes one cookie', { error: q.error?.message, qc });
  q = await page.send('Storage.clearDataForOrigin', { origin: B, storageTypes: 'cookies' });
  qc = await counts();
  check(!q.error && qc.b === 0 && qc.a === 2, 'raw page ws: Storage.clearDataForOrigin on one real origin clears only it', { error: q.error?.message, qc });
  await seed();
  const r1 = await api('POST', `/tabs/${tab.json.id}/cdp`, { method: 'Network.deleteCookies', params: { name: 'b1', domain: '127.0.0.1' } });
  qc = await counts();
  check(r1.status === 200 && qc.b === 1 && qc.a === 3, 'agent api: Network.deleteCookies with domain deletes one cookie', { status: r1.status, qc });


  // 4. POST /clear-site {origin}: one origin, olive's own session
  for (const bad of [undefined, '', '*', 'https://*', '*.localhost', 'localhost', 'file:///', 'olive://settings', `${A}/path`, `${A}, ${B}`]) {
    await seed();
    const r = await api('POST', '/clear-site', bad === undefined ? {} : { origin: bad });
    const c = await counts();
    check(r.status === 400 && c.total === 5, `clear-site refuses origin ${JSON.stringify(bad)}`, { status: r.status, c });
  }
  await seed();
  const cs = await api('POST', '/clear-site', { origin: B });
  qc = await counts();
  check(cs.status === 200 && cs.json?.origin === B && qc.b === 0 && qc.a === 3, 'clear-site clears one origin\'s cookies, the other host keeps its 3', { status: cs.status, qc });
  // 3. the hidden real port: never advertised. reachable directly? (loopback, same user)
  const dtap = fs.readFileSync(path.join(root, 'DevToolsActivePort'), 'utf8');
  const agentJson = fs.readFileSync(path.join(root, 'agent.json'), 'utf8');
  const help = JSON.stringify((await api('GET', '/')).json || '');
  check(!dtap.split('\n')[0].includes(String(px.raw)) && dtap.split('\n')[0] === String(px.cdp), 'DevToolsActivePort names the proxy, not the hidden port');
  check(!agentJson.includes(`:${px.raw}`) && !help.includes(`:${px.raw}`), 'agent.json and the api help never name the hidden port');
  let direct = 'unreachable';
  try {
    const dv = await (await fetch(`http://127.0.0.1:${px.raw}/json/version`)).json();
    direct = dv.webSocketDebuggerUrl ? 'reachable' : 'http only';
    if (process.env.OLIVE_STRICT_RAW_PORT === '1') check(false, 'hidden port is not reachable directly', { direct });
  } catch {}
  info('hidden chromium port reachable directly on loopback (known limit, see cdp-proxy.js header)', { direct });
} catch (error) { results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) }); console.error(error); }
finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  if (app) await app.close().catch(() => {});
  site?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
