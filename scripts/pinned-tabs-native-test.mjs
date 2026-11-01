// pinned tabs, native: domain lock + reset, rename tab, pinned tabs never split.
// Disposable Electron fixture only (temp OLIVE_USER_DATA_DIR, random cdp/api ports); never
// attaches to the installed Olive or its profile, never focuses windows.
// pages come from a local http server on 127.0.0.1; "localhost" on the same port is another site.
// Run: node scripts/pinned-tabs-native-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(repo, 'notes/test-shots');
fs.mkdirSync(shots, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-pinned-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, tries = 120) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await pause(50); } return v; };

// ---------- local sites ----------
const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:15px -apple-system;padding:24px">${body}</body>`;
const server = http.createServer((req, res) => {
  const host = req.headers.host;
  const port = server.address().port;
  const A = `http://127.0.0.1:${port}`;
  const B = `http://localhost:${port}`;
  const u = new URL(req.url, 'http://x');
  const send = (title, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(title, body)); };
  if (u.pathname === '/redirect-away') { res.writeHead(302, { location: `${B}/landed` }); return res.end(); }
  if (u.pathname === '/home') return send('Pinned Home', `<h1>home on ${host}</h1>
    <a id=same href="${A}/page2">same site</a> <a id=cross href="${B}/other">other site</a>
    <a id=redir href="${A}/redirect-away">server redirect</a> <a id=auth href="${B}/oauth/authorize?client_id=1">sign in</a>`);
  if (u.pathname === '/page2') return send('Page Two', `<h1>page2 on ${host}</h1><a id=back href="${A}/home">home</a>`);
  if (u.pathname === '/title') return send(u.searchParams.get('t') || 'Title', `<h1>${u.searchParams.get('t') || 'title'}</h1>`);
  return send(`${u.pathname.slice(1)} on ${host}`, `<h1>${u.pathname} on ${host}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const A = `http://127.0.0.1:${PORT}`;
const B = `http://localhost:${PORT}`;

let app, ui;
const appPath = path.join(repo, 'node_modules/electron/dist/Electron.app');
async function launch() {
  app = await _electron.launch({
    executablePath: path.join(appPath, 'Contents/MacOS/Electron'), args: [repo], cwd: repo, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'pinned-tabs-fixture', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' },
  });
  await app.evaluate(async ({ nativeTheme }) => {
    while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50));
    global.olive.onboarding.close();
    nativeTheme.themeSource = 'light';
    const w = global.olive.focusedWindow() || global.olive.windows[0];
    w.win.setTitle('Olive pinned tabs synthetic fixture');
    w.win.setSize(1440, 900);
    w.setSidebarWidth(252);
    w.setOverlay(null);
  });
  ui = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/index.html')));
  await ui.emulateMedia({ colorScheme: 'light' });
}
// main-process helpers: w() is the window
const main = (fn, arg) => app.evaluate(`(${fn.toString()})(global.olive.windows[0], ${JSON.stringify(arg ?? null)})`);
const tabs = () => main((w) => w.allIds().map((id) => { const t = w.tabs.get(id); return { id, url: t.url, pinned: t.pinned, pinnedUrl: t.pinnedUrl, title: t.snapshot().title, pageTitle: t.title, customTitle: t.customTitle, splitId: t.splitId, loading: t.loading }; }));
const tab = async (id) => (await tabs()).find((t) => t.id === id);
const loaded = (id, re) => poll(async () => { const t = await tab(id); return t && !t.loading && re.test(t.url) && t; });
const clickIn = (id, sel) => main((w, a) => w.tabs.get(a.id).wc.executeJavaScript(`document.querySelector(${JSON.stringify(a.sel)}).click()`), { id, sel });
const shot = async (name) => {
  await pause(250);
  const file = path.join(shots, name);
  await ui.screenshot({ path: file, clip: { x: 0, y: 0, width: 300, height: 420 } });
  return file;
};
const shotsTaken = [];

try {
  await launch();
  // a clean window: one pinned tab on 127.0.0.1/home
  const P = await main((w, a) => {
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    w.setOverlay(null);
    const p = w.createTab({ url: a.A + '/home', pinned: true, focusPage: false });
    return p.id;
  }, { A });
  await loaded(P, /\/home$/);
  let t = await tab(P);
  check(t.pinned && t.pinnedUrl === `${A}/home`, 'item2: pinned tab remembers its pinned url', t);

  // ---------- item 2: domain lock ----------
  await clickIn(P, '#same');
  t = await loaded(P, /\/page2$/);
  check(t && (await tabs()).length === 1, 'item2: same-site link stays in the pinned tab', await tabs());
  await poll(() => ui.locator(`#pinned .row[data-id="${P}"] .reset`).count());
  check(await ui.locator(`#pinned .row[data-id="${P}"] .reset`).count() === 1, 'item2: drifted pinned row shows the reset affordance');
  shotsTaken.push(await shot('pinned-reset-affordance-light.png'));
  await ui.locator(`#pinned .row[data-id="${P}"] .reset`).click();
  t = await loaded(P, /\/home$/);
  check(!!t, 'item2: clicking reset navigates back to the pinned url', await tab(P));
  await poll(async () => (await ui.locator(`#pinned .row[data-id="${P}"] .reset`).count()) === 0);
  check(await ui.locator(`#pinned .row[data-id="${P}"] .reset`).count() === 0, 'item2: reset affordance gone once back home');

  await clickIn(P, '#cross');
  const opened = await poll(async () => (await tabs()).find((x) => !x.pinned && x.url.startsWith(B + '/other')));
  t = await tab(P);
  check(!!opened && t.url === `${A}/home`, 'item2: cross-site link opens a new normal tab, pinned tab stays put', { opened, pinned: t });
  check(await main((w, id) => w.activeId === id, opened?.id), 'item2: the new tab is selected', null);
  const list = await main((w) => ({ pinned: w.pinned, unpinned: w.unpinned }));
  check(list.unpinned[0] === opened?.id, 'item2: new tab lands at the top of the list, next to the pinned strip', list);

  await main((w, a) => { w.activate(a.P, { focusPage: false }); w.tabs.get(a.P).wc.executeJavaScript(`location.href=${JSON.stringify(a.B + '/scripted')}`); }, { P, B });
  const scripted = await poll(async () => (await tabs()).find((x) => x.url.startsWith(B + '/scripted')));
  check(scripted && !scripted.pinned && (await tab(P)).url === `${A}/home`, 'item2: scripted cross-site location change also opens a new tab', scripted);

  await clickIn(P, '#redir');
  t = await loaded(P, /\/landed$/);
  check(!!t && t.url === `${B}/landed`, 'item2: same-site link with a cross-site server redirect completes in place (sso hops)', await tab(P));
  await main((w, id) => w.resetPinned(id), P);
  await loaded(P, /\/home$/);

  await clickIn(P, '#auth');
  t = await loaded(P, /oauth\/authorize/);
  check(!!t && t.url.startsWith(B), 'item2: cross-site sign-in page (oauth path) loads in place', await tab(P));
  await main((w, id) => w.navigate(w.tabs.get(id), w.tabs.get(id).pinnedUrl), P);
  await loaded(P, /\/home$/);

  // set current url as pinned url
  await clickIn(P, '#same');
  await loaded(P, /\/page2$/);
  await main((w, id) => w.tabMenuTemplate(id).find((x) => x.label === 'Set Current URL as Pinned URL').click(), P);
  t = await tab(P);
  check(t.pinnedUrl === `${A}/page2`, 'item2: Set Current URL as Pinned URL', t);
  await main((w, a) => w.setPinnedUrl(a.P, a.A + '/home'), { P, A });

  // ---------- item 3: rename tab ----------
  const N = await main((w, a) => w.createTab({ url: a.A + '/title?t=Original%20Page', activate: true, focusPage: false }).id, { A });
  await loaded(N, /title\?t=/);
  await poll(async () => (await tab(N)).pageTitle === 'Original Page');
  const rowN = ui.locator(`#unpinned .row[data-id="${N}"]`);
  await rowN.locator('.title').dblclick();
  const field = rowN.locator('input.tab-rename');
  check(await poll(() => field.count()) === 1, 'item3: double-click on the row title opens the inline rename field');
  check(await field.evaluate((el) => el.value === 'Original Page' && el.selectionStart === 0 && el.selectionEnd === el.value.length), 'item3: field starts with the title, all selected');
  await field.pressSequentially('Reading list');
  shotsTaken.push(await shot('tab-rename-field-light.png'));
  await field.press('Enter');
  await poll(async () => (await tab(N)).customTitle === 'Reading list');
  check(await poll(async () => (await rowN.locator('.title').textContent()) === 'Reading list'), 'item3: enter keeps the custom title in the sidebar', await tab(N));
  await main((w, id) => w.tabs.get(id).wc.executeJavaScript(`document.title = 'Page Retitled Itself'`), N);
  await poll(async () => (await tab(N)).pageTitle === 'Page Retitled Itself');
  await pause(100);
  check((await rowN.locator('.title').textContent()) === 'Reading list' && (await tab(N)).title === 'Reading list', 'item3: custom title sticks over page title changes', await tab(N));
  shotsTaken.push(await shot('tab-renamed-light.png'));
  // escape cancels
  await rowN.locator('.title').dblclick();
  await field.fill('nope');
  await field.press('Escape');
  await pause(100);
  check((await tab(N)).customTitle === 'Reading list', 'item3: escape cancels the edit', await tab(N));
  // clearing the field resets to the page title
  await rowN.locator('.title').dblclick();
  await field.fill('');
  await field.press('Enter');
  await poll(async () => (await tab(N)).customTitle === '');
  check(await poll(async () => (await rowN.locator('.title').textContent()) === 'Page Retitled Itself'), 'item3: clearing the field returns to the page title', await tab(N));
  // context menu Rename Tab… on the pinned tab (menu item clicked from the template; native menus can't be driven headless)
  await main((w, id) => w.tabMenuTemplate(id).find((x) => x.label === 'Rename Tab…').click(), P);
  const fieldP = ui.locator(`#pinned .row[data-id="${P}"] input.tab-rename`);
  check(await poll(() => fieldP.count()) === 1, 'item3: Rename Tab… opens the field on a pinned row');
  await fieldP.fill('Pinned Mail');
  await fieldP.press('Enter');
  await poll(async () => (await tab(P)).customTitle === 'Pinned Mail');
  check(await poll(async () => (await ui.locator(`#pinned .row[data-id="${P}"] .title`).textContent()) === 'Pinned Mail'), 'item3: pinned tab renamed', await tab(P));
  // Reset Tab Name
  await main((w, id) => w.renameTab(id, 'Temp name'), N);
  await main((w, id) => w.tabMenuTemplate(id).find((x) => x.label === 'Reset Tab Name').click(), N);
  check((await tab(N)).title === 'Page Retitled Itself', 'item3: Reset Tab Name returns to the page title', await tab(N));
  await main((w, id) => w.renameTab(id, 'Reading list'), N);

  // ---------- item 4: pinned tabs never split ----------
  const pinnedSplitFree = () => main((w) => {
    const bad = [];
    for (const sp of w.splits.values()) for (const id of sp.ids) if (w.tabs.get(id)?.pinned) bad.push(id);
    for (const id of w.pinned) if (w.tabs.get(id).splitId) bad.push(id);
    return bad;
  });
  const splitOf = (id) => main((w, id) => { const t = w.tabs.get(id); const sp = t?.splitId ? w.splits.get(t.splitId) : null; return sp ? sp.ids.map((x) => ({ id: x, url: w.tabs.get(x).url, pinned: w.tabs.get(x).pinned })) : null; }, id);
  const pUrl = (await tab(P)).url;
  const isCopy = (m) => m && !m.pinned && m.id !== P && m.url === pUrl;
  // a) tab menu: Open in Split View with Current Tab, while the pinned tab is current
  const S1 = await main((w, a) => w.createTab({ url: a.A + '/split-one', activate: false, focusPage: false }).id, { A });
  await loaded(S1, /split-one/);
  await main((w, id) => w.activate(id, { focusPage: false }), P);
  await main((w, id) => w.tabMenuTemplate(id).find((x) => x.label === 'Open in Split View with Current Tab').click(), S1);
  let sp = await splitOf(S1);
  check(sp && sp.length === 2 && isCopy(sp[0]) && (await tab(P)).splitId == null, 'item4: split with current tab (pinned current) splits a normal copy', sp);
  // b) palette ⇧⏎ while the pinned tab is active
  await main((w, id) => { w.activate(id, { focusPage: false }); w.openPalette('new'); }, P);
  await ui.locator('#palette-input').fill(`${A}/split-palette`);
  await pause(200);
  await ui.locator('#palette-input').press('Shift+Enter');
  const SP = await poll(async () => (await tabs()).find((x) => x.url.includes('/split-palette')));
  sp = SP && await poll(() => splitOf(SP.id));
  check(sp && sp.length === 2 && isCopy(sp[0]) && sp[1].id === SP.id && (await tab(P)).splitId == null, 'item4: palette shift+enter from a pinned tab splits a normal copy', sp);
  // c) drag a pinned row onto the page: the ui sends split {a: active, b: dragged}
  const S3 = await main((w, a) => w.createTab({ url: a.A + '/split-drag', activate: true, focusPage: false }).id, { A });
  await loaded(S3, /split-drag/);
  await ui.evaluate(({ a, b }) => window.olive.cmd('split', { a, b }), { a: S3, b: P });
  sp = await poll(() => splitOf(S3));
  check(sp && sp.length === 2 && sp[0].id === S3 && isCopy(sp[1]) && (await tab(P)).splitId == null, 'item4: drag pinned tab to split (ui split cmd) splits a normal copy', sp);
  // d) agent api POST /tabs/:id/split {with}
  const S4 = await main((w, a) => w.createTab({ url: a.A + '/split-api', activate: false, focusPage: false }).id, { A });
  await loaded(S4, /split-api/);
  const api = await main((w) => ({ port: w.mgr.apiPort }));
  const token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${api.port}/tabs/${P}/split`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ with: S4 }) });
  const body = await r.json();
  sp = await splitOf(S4);
  check(r.status === 200 && body.id !== P && !body.pinned && body.splitId && sp?.length === 2 && isCopy(sp[1]) && (await tab(P)).splitId == null, 'item4: agent api POST /tabs/:id/split on a pinned tab splits a normal copy', { status: r.status, body: { id: body.id, pinned: body.pinned, splitId: body.splitId }, sp });
  // e) splitNew (⌃⇧=, Split View with New Tab) while the pinned tab is active
  await main((w, id) => { w.activate(id, { focusPage: false }); w.cmd('splitNew'); }, P);
  await ui.locator('#palette-input').fill(`${A}/split-new`);
  await pause(200);
  await ui.locator('#palette-input').press('Enter');
  const SN = await poll(async () => (await tabs()).find((x) => x.url.includes('/split-new')));
  sp = SN && await poll(() => splitOf(SN.id));
  check(sp && sp.length === 2 && isCopy(sp[0]) && (await tab(P)).splitId == null, 'item4: splitNew from a pinned tab splits a normal copy', sp);
  // f) pinning a split member takes it out of the split
  await main((w, id) => w.setPinned(id, true), S1);
  check((await tab(S1)).pinned && (await tab(S1)).splitId == null, 'item4: pinning a split tab takes it out of its split', await tab(S1));
  await main((w, id) => w.setPinned(id, false), S1);
  const bad = await pinnedSplitFree();
  check(bad.length === 0 && (await tab(P)).pinned, 'item4: no pinned tab is in any split; the pinned tab is still pinned', bad);
  await main((w, id) => w.activate(id, { focusPage: false }), N);

  // ---------- restart: persisted state ----------
  await main((w, a) => { w.mgr.saveNow(); }, null);
  await app.close();
  app = null;
  await launch();
  const after = await poll(async () => { const l = await tabs(); return l.length ? l : null; });
  const P2 = after.find((x) => x.pinned);
  check(P2 && P2.pinnedUrl === `${A}/home` && P2.url === `${A}/page2`, 'item2: pinned url persists across restart', after);
  const N2 = after.find((x) => x.url.includes('/title?t='));
  check(P2?.customTitle === 'Pinned Mail' && N2?.customTitle === 'Reading list' && N2?.title === 'Reading list', 'item3: custom titles persist across restart', after);
  await poll(() => ui.locator(`#pinned .row[data-id="${P2?.id}"] .title`).count());
  check(await poll(async () => (await ui.locator(`#pinned .row[data-id="${P2?.id}"] .title`).textContent()) === 'Pinned Mail'), 'item3: sidebar shows the custom title after restart');
} catch (error) {
  results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) });
  console.error(error);
} finally {
  fs.writeFileSync(path.join(shots, 'pinned-tabs-native-test.json'), JSON.stringify(results, null, 2));
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('screenshots:\n' + shotsTaken.map((f) => '  ' + f).join('\n'));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
