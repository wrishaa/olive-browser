import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';
// browser-wide cookie / storage clears are blocked on the agent api (src/main/cdp-guard.js);
// per-site deletes and clears inside a throwaway Target.createBrowserContext still work.
// disposable electron fixture only (temp OLIVE_USER_DATA_DIR, api port 0, no raw cdp port);
// never touches installed olive. prints cookie COUNTS only, never values.
// run: node scripts/cdp-guard-native-test.mjs
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-cdp-guard-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const BLOCK = 'blocked by olive: browser-wide clear; use per-site delete';
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
let app, site;
try {
  // a throwaway test site: two hosts (localhost and 127.0.0.1) on one loopback port
  site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>cdp guard fixture</title><body>fixture</body>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const P = site.address().port;
  const A = `http://localhost:${P}`, B = `http://127.0.0.1:${P}`;
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'cdp-guard-regression', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  const info = await app.evaluate(async ({ app: eapp }) => { while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding.close(); return { api: global.olive.apiPort, cdp: global.olive.cdpPort, userData: eapp.getPath('userData') }; });
  if (!info.userData.startsWith(root) || !info.api || info.api === 9333 || info.cdp) throw new Error('fixture is not isolated: ' + JSON.stringify({ api: info.api, cdp: info.cdp }));
  const token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${info.api}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
  const id = tab.json?.id;
  check(tab.status === 200 && id, 'opened a background tab on the throwaway origin', tab);
  const cdp = (method, params) => api('POST', `/tabs/${id}/cdp`, { method, params });
  const base = await counts();
  check(base.a === 3 && base.b === 2, 'seeded 3 + 2 cookies on two throwaway hosts', base);

  const targetId = tab.json?.targetId;
  const blocked = [
    ['Network.clearBrowserCookies', {}],
    ['network.CLEARBROWSERCOOKIES', {}],
    ['Storage.clearCookies', {}],
    ['Storage.clearCookies', { browserContextId: 'not-a-created-context' }],
    ['Storage.clearDataForOrigin', { origin: '*', storageTypes: 'all' }],
    ['Storage.clearDataForOrigin', { origin: '', storageTypes: 'all' }],
    ['Storage.clearDataForOrigin', { storageTypes: 'all' }],
    ['Storage.clearDataForStorageKey', { storageKey: '*', storageTypes: 'all' }],
    ['Storage.clearDataForStorageKey', { storageKey: '', storageTypes: 'all' }],
    ['Network.deleteCookies', { name: 'a1' }],
    ['Target.sendMessageToTarget', { targetId, message: JSON.stringify({ id: 1, method: 'Network.clearBrowserCookies', params: {} }) }],
    ['Target.sendMessageToTarget', { sessionId: 'x', message: JSON.stringify({ id: 1, method: 'Target.sendMessageToTarget', params: { sessionId: 'y', message: JSON.stringify({ id: 2, method: 'storage.clearCookies' }) } }) }],
    ['Target.exposeDevToolsProtocol', { targetId, bindingName: 'cdp' }],
  ];
  for (const [method, params] of blocked) {
    await seed(); // each op starts from the same 3 + 2 (base on the old code wiped them)
    const r = await cdp(method, params);
    const after = await counts();
    check(r.status === 403 && r.json?.error === BLOCK && r.json?.blocked === true, `${method} ${JSON.stringify(params).slice(0, 60)} is refused with a 403 json error`, { status: r.status, error: r.json?.error });
    check(after.total === base.total && after.a === base.a && after.b === base.b, `${method} left the cookie count unchanged`, { before: base, after });
  }

  // per-site deletes keep working
  await seed();
  let r = await cdp('Network.deleteCookies', { name: 'a1', url: A + '/' });
  let c = await counts();
  check(r.status === 200 && c.a === 2 && c.b === 2, 'Network.deleteCookies name+url deletes one cookie on that site only', { status: r.status, error: r.json?.error, c });
  r = await cdp('Network.deleteCookies', { name: 'a2', domain: 'localhost' });
  c = await counts();
  check(r.status === 200 && c.a === 1 && c.b === 2, 'Network.deleteCookies name+domain deletes one cookie on that site only', { status: r.status, error: r.json?.error, c });
  r = await cdp('Storage.clearDataForOrigin', { origin: A, storageTypes: 'cookies' });
  c = await counts();
  check(r.status === 200 && c.a === 0 && c.b === 2, 'Storage.clearDataForOrigin with a real origin clears that site only', { status: r.status, error: r.json?.error, c });

  // a throwaway browser context created in this session can be cleared
  r = await cdp('Target.createBrowserContext', { disposeOnDetach: true });
  const ctx = r.json?.result?.browserContextId;
  // a tab's debugger is a page session: chromium itself answers "Not allowed" for
  // Target.createBrowserContext / browserContextId there. olive must not be the one refusing.
  // (the context exemption is covered by tests/cdp-guard.test.js.)
  check(r.status !== 403 && (ctx || /not allowed/i.test(r.json?.error || '')), 'Target.createBrowserContext is not refused by olive (chromium: page sessions cannot make contexts)', { status: r.status, error: r.json?.error });
  if (ctx) {
    r = await cdp('Storage.setCookies', { browserContextId: ctx, cookies: [{ name: 't1', value: 'x', domain: 'localhost', path: '/' }, { name: 't2', value: 'x', domain: 'localhost', path: '/' }] });
    let got = await cdp('Storage.getCookies', { browserContextId: ctx });
    const seeded = got.json?.result?.cookies?.length;
    r = await cdp('Storage.clearCookies', { browserContextId: ctx });
    got = await cdp('Storage.getCookies', { browserContextId: ctx });
    c = await counts();
    check(seeded === 2 && r.status === 200 && got.json?.result?.cookies?.length === 0 && c.b === 2, 'Storage.clearCookies inside the created context clears it and leaves the profile alone', { seeded, status: r.status, error: r.json?.error, left: got.json?.result?.cookies?.length, c });
    r = await cdp('Target.disposeBrowserContext', { browserContextId: ctx });
    r = await cdp('Storage.clearCookies', { browserContextId: ctx });
    c = await counts();
    check(r.status === 403 && c.b === 2, 'a disposed context id no longer unlocks Storage.clearCookies', { status: r.status, c });
  }
  // the agent api still works for ordinary cdp
  r = await cdp('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  check(r.status === 200 && r.json?.result?.result?.value === 2, 'ordinary cdp commands still pass', { status: r.status });

  // phase 2: the opt-in raw cdp port goes through olive's guarded proxy (src/main/cdp-proxy.js)
  await app.close(); app = null;
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'cdp-guard-regression', OLIVE_CDP: '1', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  const px = await app.evaluate(async () => { while (!global.olive?.ready || !global.olive.apiPort) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding.close(); return { cdp: global.olive.cdpPort, raw: global.olive.cdpRawPort, agent: global.olive.agentInfo().cdp }; });
  check(px.cdp && px.raw && px.cdp !== px.raw && ![9222, 9333].includes(px.cdp) && px.agent === `http://127.0.0.1:${px.cdp}`, 'raw cdp is advertised on olive\'s proxy port, chromium\'s own port is a different one', px);
  const ver = await (await fetch(`http://127.0.0.1:${px.cdp}/json/version`)).json();
  check(ver.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${px.cdp}/`), '/json/version through the proxy points websockets at the proxy', { url: ver.webSocketDebuggerUrl?.replace(/[0-9a-f-]{36}/, '<id>') });
  check(fs.readFileSync(path.join(root, 'DevToolsActivePort'), 'utf8').split('\n')[0] === String(px.cdp), 'DevToolsActivePort names the proxy port');
  await seed();
  const api2 = async (method, route, body) => (await fetch(`http://127.0.0.1:${(await app.evaluate(() => global.olive.apiPort))}${route}`, { method, headers: { authorization: `Bearer ${fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const t2 = await api2('POST', '/tabs', { url: A + '/' });
  check(t2.targetId, 'opened a fixture tab after relaunch', { id: t2.id });
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const raw = (method, params = {}, sessionId) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const att = await raw('Target.attachToTarget', { targetId: t2.targetId, flatten: true });
  const sid = att.result?.sessionId;
  check(sid, 'attached a flat session to the fixture page through the proxy', { error: att.error?.message });
  const pbase = await counts();
  for (const [method, params, session] of [
    ['Storage.clearCookies', {}], ['STORAGE.clearcookies', {}], ['Network.clearBrowserCookies', {}, sid], ['network.clearbrowsercookies', {}, sid],
    ['Storage.clearDataForOrigin', { origin: '*', storageTypes: 'all' }], ['Storage.clearDataForOrigin', { origin: '', storageTypes: 'all' }, sid],
    ['Storage.clearCookies', { browserContextId: 'not-a-created-context' }],
    ['Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 9, method: 'Network.clearBrowserCookies' }) }],
  ]) {
    await seed();
    const r = await raw(method, params, session);
    const after = await counts();
    check(r.error?.message === BLOCK && after.total === pbase.total && after.a === pbase.a, `raw port: ${method}${session ? ' (flat session)' : ''} ${JSON.stringify(params).slice(0, 40)} refused, cookie count unchanged`, { error: r.error?.message, before: pbase, after });
  }
  await seed();
  let q = await raw('Network.deleteCookies', { name: 'a1', url: A + '/' }, sid);
  let qc = await counts();
  check(!q.error && qc.a === 2 && qc.b === 2, 'raw port: per-site Network.deleteCookies works', { error: q.error?.message, qc });
  // (the browser target's Storage acts on chromium's default context, not olive's
  // persist:olive session: per-site clears go through the page's session)
  q = await raw('Storage.clearDataForOrigin', { origin: B, storageTypes: 'cookies' }, sid);
  qc = await counts();
  check(!q.error && qc.b === 0 && qc.a === 2, 'raw port: Storage.clearDataForOrigin on one real origin clears only it', { error: q.error?.message, qc });
  q = await raw('Target.createBrowserContext', { disposeOnDetach: true });
  const pctx = q.result?.browserContextId;
  // electron doesn't implement Target.createBrowserContext ("Failed to create browser
  // context."): the context exemption is unit-tested; here olive just must not be the one refusing
  check(pctx || (q.error && q.error.message !== BLOCK), 'raw port: Target.createBrowserContext not refused by olive', { error: q.error?.message });
  if (pctx) {
    await raw('Storage.setCookies', { browserContextId: pctx, cookies: [{ name: 't1', value: 'x', domain: 'localhost', path: '/' }, { name: 't2', value: 'x', domain: 'localhost', path: '/' }] });
    const before = (await raw('Storage.getCookies', { browserContextId: pctx })).result?.cookies?.length;
    q = await raw('Storage.clearCookies', { browserContextId: pctx });
    const left = (await raw('Storage.getCookies', { browserContextId: pctx })).result?.cookies?.length;
    qc = await counts();
    check(before === 2 && !q.error && left === 0 && qc.a === 2, 'raw port: Storage.clearCookies inside the created context clears it, profile untouched', { before, error: q.error?.message, left, qc });
    await raw('Target.disposeBrowserContext', { browserContextId: pctx });
    q = await raw('Storage.clearCookies', { browserContextId: pctx });
    check(q.error?.message === BLOCK, 'raw port: a disposed context no longer unlocks Storage.clearCookies', { error: q.error?.message });
  }
  // a second connection didn't create that context
  ws.close();
  const pw = await chromium.connectOverCDP(`http://127.0.0.1:${px.cdp}`);
  const pwPages = pw.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith(A));
  check(pwPages.length >= 1 && (await pwPages[0].evaluate(() => 1 + 1)) === 2, 'playwright connectOverCDP works through the proxy');
  let pwErr = null; try { const s2 = await pwPages[0].context().newCDPSession(pwPages[0]); await s2.send('Network.clearBrowserCookies'); } catch (e) { pwErr = String(e.message); }
  qc = await counts();
  check(pwErr?.includes(BLOCK) && qc.a === 2, 'playwright cdp session: Network.clearBrowserCookies refused, cookie count unchanged', { pwErr: pwErr?.slice(0, 120), qc });
  await pw.close().catch(() => {});
} catch (error) { results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) }); console.error(error); }
finally {
  if (app) await app.close().catch(() => {});
  site?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
