// tab rename triggers, native: double-click a tab title, enter on the selected row, and the
// enter clashes (page textarea, cmd+l palette, find bar, sidebar not focused).
// real-ish input: webContents.sendInputEvent (mouse + keys), not dispatched DOM events.
// Disposable Electron fixture only (temp OLIVE_USER_DATA_DIR, random cdp/api ports); never
// attaches to the installed Olive or its profile. spec: notes/tab-rename-spec.md
// Run: node scripts/tab-rename-native-test.mjs [--shots]   (--shots: 1440 frames into
// notes/test-shots/olive-tab-scenarios/fixed/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv.includes('--shots');
const shotDir = path.join(repo, 'notes/test-shots/olive-tab-scenarios/fixed');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-rename-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, tries = 60) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await pause(50); } return v; };

const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:15px -apple-system;padding:24px">${body}</body>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (u.pathname === '/textarea') return res.end(page('Notes Page', '<textarea id=ta autofocus rows=6 cols=40></textarea>'));
  res.end(page(u.searchParams.get('t') || u.pathname.slice(1), `<h1>${u.pathname}</h1><p>find me here</p>`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const A = `http://127.0.0.1:${server.address().port}`;

let app, ui;
try {
  app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'rename-fixture', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' },
  });
  await app.evaluate(async ({ nativeTheme }) => {
    while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50));
    global.olive.onboarding.close();
    nativeTheme.themeSource = 'light';
    const w = global.olive.windows[0];
    w.win.setTitle('Olive tab rename synthetic fixture');
    w.win.setSize(1440, 900);
    w.setSidebarWidth(252);
    w.setOverlay(null);
  });
  ui = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/index.html')));
  await ui.emulateMedia({ colorScheme: 'light' });

  const main = (fn, arg) => app.evaluate(`(${fn.toString()})(global.olive.windows[0], ${JSON.stringify(arg ?? null)})`);
  const tab = (id) => main((w, id) => { const t = w.tabs.get(id); return t && { id, url: t.url, title: t.snapshot().title, customTitle: t.customTitle, loading: t.loading }; }, id);
  const loaded = (id) => poll(async () => { const t = await tab(id); return t && !t.loading && t.url !== 'about:blank' && t; });
  // input into a webcontents: 'ui' or a tab id
  const wcOf = `(w, a) => (a.to === 'ui' ? w.ui.webContents : w.tabs.get(a.to).wc)`;
  const send = (to, events) => app.evaluate(`((w, a) => { const wc = (${wcOf})(w, a); for (const e of a.events) wc.sendInputEvent(e); })(global.olive.windows[0], ${JSON.stringify({ to, events })})`);
  const key = (to, keyCode, modifiers = []) => send(to, [
    { type: 'keyDown', keyCode, modifiers },
    ...(keyCode === 'Return' ? [{ type: 'char', keyCode: '\r', modifiers }] : []),
    { type: 'keyUp', keyCode, modifiers },
  ]).then(() => pause(150));
  const typeText = (to, text) => send(to, [...text].map((c) => ({ type: 'char', keyCode: c }))).then(() => pause(100));
  const center = async (selector) => {
    const r = await ui.locator(selector).first().evaluate((el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x + Math.min(b.width / 2, 30)), y: Math.round(b.y + b.height / 2), w: b.width, h: b.height }; });
    return r;
  };
  const mouse = async (selector, { count = 1, modifiers = [] } = {}) => {
    const { x, y } = await center(selector);
    const ev = [{ type: 'mouseMove', x, y }];
    for (let i = 1; i <= count; i++) ev.push({ type: 'mouseDown', x, y, button: 'left', clickCount: i, modifiers }, { type: 'mouseUp', x, y, button: 'left', clickCount: i, modifiers });
    await send('ui', ev);
    await pause(250);
  };
  const field = () => ui.locator('.row .tab-rename');
  const fieldOpen = async () => (await field().count()) === 1;
  const groupField = () => ui.locator('.group-head .rename');
  const closeField = async () => { if (await fieldOpen()) await key('ui', 'Escape'); await poll(async () => !(await fieldOpen())); };
  const uiFocused = () => main((w) => w.ui.webContents.isFocused());
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(shotDir, { recursive: true });
    const file = path.join(shotDir, name);
    // the real window (sidebar + page card) via screencapture -l; else the ui view alone
    const wid = await main((w) => w.win.getMediaSourceId().split(':')[1]);
    try { execFileSync('screencapture', ['-x', '-o', '-l', wid, file]); } catch { await ui.screenshot({ path: file }); }
    console.log('shot ' + path.join(shotDir, name));
  };

  // ---------- fixture: pinned + unpinned + a split + a group ----------
  const ids = await main((w, A) => {
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    w.setOverlay(null);
    const mk = (u, o = {}) => w.createTab({ url: A + u, activate: false, focusPage: false, ...o }).id;
    const P = mk('/mail?t=Pinned%20Mail', { pinned: true });
    const N = mk('/doc?t=Plain%20Doc');
    const S1 = mk('/left?t=Split%20Left');
    const S2 = mk('/right?t=Split%20Right');
    const G = mk('/grouped?t=Grouped%20Doc');
    const T = mk('/textarea');
    w.split(S1, S2);
    const g = w.newGroup([G]);
    w.activate(N, { focusPage: false });
    return { P, N, S1, S2, G, T, group: [...w.groups.keys()][0] };
  }, A);
  for (const id of [ids.P, ids.N, ids.S1, ids.S2, ids.G, ids.T]) await loaded(id);
  await poll(async () => (await ui.locator(`.row[data-id="${ids.N}"] .title`).textContent().catch(() => '')) === 'Plain Doc');
  const row = (id) => `.row[data-id="${id}"]`;
  // newGroup opens the group's rename field (⌃⌘N): name it there
  await poll(async () => (await groupField().count()) === 1);
  await groupField().fill('Research');
  await key('ui', 'Return');
  check((await main((w, g) => w.groups.get(g)?.name, ids.group)) === 'Research', 'fixture: group named Research', await main((w) => [...w.groups.values()].map((g) => g.name)));
  // keyboard focus model: a background fixture window is not key, so electron's
  // webContents.isFocused() would follow the os, not olive. track the webcontents olive
  // last focused instead (activate -> page, focusUi / palette / find -> ui). real native
  // focus was checked with real input in the cua run (RESULTS.md item 3).
  await main((w) => {
    global.__kbd = null;
    const hook = (wc) => { const f = wc.focus; wc.focus = function () { global.__kbd = this.id; return f.call(this); }; wc.isFocused = function () { return global.__kbd === this.id; }; };
    hook(w.ui.webContents);
    for (const t of w.tabs.values()) if (t.wc) hook(t.wc);
    global.__kbd = w.tabs.get(w.activeId)?.wc?.id ?? null;
  });

  // ---------- trigger 1: double-click ----------
  await mouse(`${row(ids.N)} .title`, { count: 2 });
  check(await poll(fieldOpen) && (await field().evaluate((el) => el.closest('.row').dataset.id)) === String(ids.N), 'dblclick: unpinned title opens the field');
  check(await uiFocused(), 'dblclick: opening the field routes the keyboard to the ui (focusUi)');
  await shot('rename-dblclick-1440.png');
  await typeText('ui', 'Doc Renamed');
  await key('ui', 'Return');
  check(await poll(async () => (await tab(ids.N)).customTitle === 'Doc Renamed' && !(await fieldOpen())), 'field: enter commits', await tab(ids.N));

  await mouse(`${row(ids.N)} .title`, { count: 2 });
  await poll(fieldOpen);
  await typeText('ui', 'Throwaway');
  await key('ui', 'Escape');
  check(await poll(async () => !(await fieldOpen())) && (await tab(ids.N)).customTitle === 'Doc Renamed', 'field: esc cancels', await tab(ids.N));

  await mouse(`#pinned ${row(ids.P)} .title`, { count: 2 });
  check(await poll(fieldOpen) && (await field().evaluate((el) => el.closest('.row').dataset.id)) === String(ids.P), 'dblclick: pinned title opens the field');
  await closeField();

  await mouse(`${row(ids.S2)} .title`, { count: 2 });
  check(await poll(fieldOpen) && (await field().evaluate((el) => el.closest('.row').dataset.id)) === String(ids.S2), 'dblclick: title of a row inside a split opens the field');
  await closeField();

  await mouse(`${row(ids.N)} .fav`, { count: 2 });
  await pause(200);
  check(!(await fieldOpen()), 'dblclick: favicon does not rename');

  // close x: double-clicking it closes on the first click; use a throwaway tab and make sure
  // no field opens on whatever row slides under the pointer
  const X = await main((w, A) => { const t = w.createTab({ url: A + '/closeme?t=Close%20Me', activate: false, focusPage: false }); return t.id; }, A);
  await loaded(X);
  await poll(() => ui.locator(row(X)).count());
  await ui.locator(row(X)).hover();
  await mouse(`${row(X)} .close`, { count: 2 });
  await pause(200);
  check(!(await fieldOpen()), 'dblclick: close x does not rename', { closed: !(await tab(X)) });
  await closeField();

  await mouse(`.group-head[data-group="${ids.group}"] .title, .group[data-group="${ids.group}"] .group-head .title`, { count: 2 });
  check(await poll(async () => (await groupField().count()) === 1) && !(await fieldOpen()), 'dblclick: group head renames the group, not a tab');
  if (await groupField().count()) await key('ui', 'Escape');
  await poll(async () => (await groupField().count()) === 0);
  check((await main((w, g) => w.groups.get(g)?.name, ids.group)) === 'Research', 'dblclick: esc in the group field keeps the group name', await main((w, g) => w.groups.get(g), ids.group));

  // ---------- trigger 2: enter on the selected row ----------
  // ⌘-click selects without activating; that click leaves the keyboard in the sidebar
  await mouse(`${row(ids.N)} .title`, { modifiers: ['meta'] });
  await main((w) => w.ui.webContents.focus()); // what a real click on the ui view does natively
  check(JSON.stringify(await main((w) => w.selection)) === JSON.stringify([ids.N]), 'enter: one tab selected', await main((w) => w.selection));
  await key('ui', 'Return');
  check(await poll(fieldOpen) && (await field().evaluate((el) => el.closest('.row').dataset.id)) === String(ids.N), 'enter: selected row opens the field');
  await shot('rename-enter-1440.png');
  await typeText('ui', 'Via Enter');
  await key('ui', 'Return');
  check(await poll(async () => (await tab(ids.N)).customTitle === 'Via Enter' && !(await fieldOpen())), 'enter: second enter commits (does not reopen)', await tab(ids.N));
  await pause(200);
  check(!(await fieldOpen()), 'enter: field stays closed after commit');

  await key('ui', 'Return');
  await poll(fieldOpen);
  await key('ui', 'Escape');
  check(await poll(async () => !(await fieldOpen())) && (await tab(ids.N)).customTitle === 'Via Enter', 'enter: esc in the field cancels');

  for (const mod of ['shift', 'meta']) {
    await key('ui', 'Return', [mod]);
    check(!(await fieldOpen()), `enter: ${mod}+enter on the selected row does not rename`);
  }

  // two selected: no rename
  await mouse(`${row(ids.G)} .title`, { modifiers: ['meta'] });
  await main((w) => w.ui.webContents.focus());
  await key('ui', 'Return');
  check(!(await fieldOpen()), 'enter: two selected tabs, no rename', await main((w) => w.selection));
  await key('ui', 'Escape'); // drops the selection

  // ---------- clashes ----------
  // sidebar not focused: one tab selected, keyboard in the page
  await mouse(`${row(ids.N)} .title`, { modifiers: ['meta'] });
  await main((w, id) => w.tabs.get(id).wc.focus(), ids.N);
  check(!(await uiFocused()), 'clash: ui not focused (page has the keyboard)');
  await key(ids.N, 'Return');
  check(!(await fieldOpen()), 'clash: enter while the sidebar is not focused does not rename');
  await key('ui', 'Return'); // even a stray enter delivered to the unfocused ui
  check(!(await fieldOpen()), 'clash: enter delivered to an unfocused ui does not rename');

  // page textarea: newline, no rename (selection still [N])
  await main((w, id) => { w.activate(id); }, ids.T);
  await main((w, id) => w.tabs.get(id).wc.executeJavaScript('document.getElementById("ta").focus()'), ids.T);
  await typeText(ids.T, 'line1');
  await key(ids.T, 'Return');
  await typeText(ids.T, 'line2');
  const ta = await main((w, id) => w.tabs.get(id).wc.executeJavaScript('document.getElementById("ta").value'), ids.T);
  check(ta === 'line1\nline2' && !(await fieldOpen()), 'clash: enter in a page textarea types a newline, no rename', { ta });
  await key('ui', 'Escape');
  await main((w) => w.setSelection([]));
  await ui.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

  // cmd+l palette: enter navigates the current tab
  await main((w, id) => w.activate(id, { focusPage: false }), ids.N);
  const palGo = async (pathName, mods) => {
    await main((w) => w.cmd('openLocation', {}));
    await poll(() => ui.locator('#palette-input').isVisible());
    await ui.locator('#palette-input').fill(A + pathName);
    await pause(150);
    await key('ui', 'Return', mods);
    await pause(300);
  };
  const before = await main((w) => ({ n: w.tabs.size, split: [...w.tabs.values()].filter((t) => t.splitId).length }));
  await palGo('/navved?t=Navved', []);
  check(await poll(async () => /\/navved/.test((await tab(ids.N)).url)) && !(await fieldOpen()), 'clash: cmd+l enter navigates the current tab, no rename', await tab(ids.N));
  await palGo('/shifted?t=Shifted', ['shift']);
  const afterShift = await main((w) => ({ n: w.tabs.size, split: [...w.tabs.values()].filter((t) => t.splitId).map((t) => t.url) }));
  check(afterShift.n === before.n + 1 && afterShift.split.some((u) => /\/shifted/.test(u)) && !(await fieldOpen()), 'clash: cmd+l shift+enter opens a split, no rename', afterShift);
  await palGo('/metaed?t=Metaed', ['meta']);
  const afterMeta = await main((w) => ({ n: w.tabs.size, active: w.tabs.get(w.activeId)?.url }));
  check(afterMeta.n === afterShift.n + 1 && /\/metaed/.test(afterMeta.active) && !(await fieldOpen()), 'clash: cmd+l cmd+enter opens a new foreground tab, no rename', afterMeta);

  // find bar: enter searches, no rename
  await mouse(`${row(ids.N)} .title`, { modifiers: ['meta'] });
  await main((w) => w.cmd('find', {}));
  await poll(() => ui.evaluate(() => document.activeElement?.id === 'find-input' || document.activeElement?.closest?.('#find') != null));
  await typeText('ui', 'find');
  await key('ui', 'Return');
  check(!(await fieldOpen()), 'clash: enter in the find bar does not rename', await ui.evaluate(() => document.activeElement?.id));
  await key('ui', 'Escape');
} catch (error) {
  check(false, 'run without exceptions', String(error?.stack || error));
} finally {
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
