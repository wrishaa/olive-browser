// Native: cmd+l palette submit modifiers. ↵ = current tab, ⌘↵ = new foreground tab (the
// current tab untouched), ⇧↵ = split, ⌘↵ on a "switch to tab" result just switches,
// cmd+t palette ↵ still opens a new tab. Isolated temp profile, cdp + api off, local
// http://localhost fixture pages, keys go to the chrome ui page only (no OS input, no focus).
// Run: node scripts/palette-new-tab-native-test.mjs
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { windowShot } from './lib/window-shot.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-palette-new-tab-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cdp: false, agentApi: false }));
const output = path.join(project, 'notes/test-shots/palette-new-tab');
fs.mkdirSync(output, { recursive: true });

const server = http.createServer((req, res) => { const name = req.url.slice(1).split('?')[0] || 'home'; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><title>Page ${name}</title><body style="font:15px -apple-system;padding:28px"><h2>Page ${name}</h2>`); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

const failures = []; let checks = 0, app;
const check = (ok, message, details) => { checks++; if (!ok) failures.push({ message, details }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && details !== undefined ? ': ' + JSON.stringify(details) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, tries = 160) { for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('Timed out: ' + label); }
const W = (fn, arg) => app.evaluate((_, { src, arg }) => { const w = global.olive.windows[0]; return (new Function('w', 'arg', `return (${src})(w, arg)`))(w, arg); }, { src: fn.toString(), arg });
const state = () => W(w => ({ active: w.activeId, size: w.tabs.size, tabs: [...w.tabs.values()].map(t => ({ id: t.id, url: t.wc?.getURL() || t.url, split: t.splitId })), overlay: w.overlay }));
const urlOf = (s, id) => s.tabs.find(t => t.id === id)?.url;
const loaded = (id, u) => poll(() => W((w, { id, u }) => { const t = w.tabs.get(id); return !!t && !t.wc.isLoading() && t.wc.getURL().startsWith(u); }, { id, u }), 'load ' + u);

try {
  app = await _electron.launch({ executablePath: path.join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'], cwd: project, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'palette-new-tab-test', OLIVE_CDP: '0', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' } });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise(r => setTimeout(r, 25)); global.olive.onboarding?.close(); global.olive.windows[0].win.setSize(1440, 900); });
  let ui; for (let i = 0; i < 200 && !ui; i++) { ui = (await app.windows()).find(p => p.url().includes('/ui/index.html')); if (!ui) await sleep(30); }
  await ui.waitForFunction(() => window.olive && document.querySelector('#palette-input'));
  // first tab, on the fixture (the first load right after startup can stall on a fresh profile: retry)
  const a = await W(async (w, u) => { const t = w.createTab({ url: u, focusPage: false });
    for (let i = 0; i < 300 && (t.wc.isLoading() || !t.wc.getURL().startsWith(u)); i++) { if (i % 60 === 59) t.wc.loadURL(u).catch(() => {}); await new Promise(r => setTimeout(r, 50)); }
    return t.id; }, `${base}/a`);
  await loaded(a, `${base}/a`);
  const palette = async (cmd, text) => {
    await W((w, c) => w.cmd(c), cmd);
    await ui.locator('#palette-input').waitFor({ state: 'visible' });
    await ui.locator('#palette-input').fill(text);
    await poll(async () => (await ui.locator('.sug.sel').count()) > 0, 'selected suggestion');
  };

  // ---------- ↵ in cmd+l: current tab ----------
  let s0 = await state();
  await palette('openLocation', `${base}/b`);
  await ui.locator('#palette-input').press('Enter');
  await loaded(a, `${base}/b`);
  let s = await state();
  check(s.size === s0.size && s.active === a && urlOf(s, a).startsWith(`${base}/b`), 'cmd+l ↵: navigates the current tab, no new tab', s);

  // ---------- ⌘↵ in cmd+l: new foreground tab, current untouched ----------
  await palette('openLocation', `${base}/c`);
  const hints = await ui.locator('.palette-hints').innerText();
  check(/new tab/.test(hints), 'palette hints list ⌘↵ new tab', hints);
  await sleep(250); const shot = await windowShot(app, path.join(output, 'palette-cmd-enter-1440.png'));
  await ui.locator('#palette-input').press('Meta+Enter');
  s = await poll(async () => { const x = await state(); return x.size === s0.size + 1 && x.active !== a && x; }, 'new tab');
  const c = s.active;
  await loaded(c, `${base}/c`);
  s = await state();
  check(s.size === s0.size + 1 && s.active === c && urlOf(s, c).startsWith(`${base}/c`), 'cmd+l ⌘↵: opens a new active tab with the url', s);
  check(urlOf(s, a).startsWith(`${base}/b`) && !s.tabs.find(t => t.id === a).split, 'cmd+l ⌘↵: the old tab url is unchanged', s);
  check(s.overlay == null, 'palette closed after ⌘↵', s.overlay);

  // ---------- ⌘↵ on a selected history result: new tab with that result ----------
  await W((w, id) => w.activate(id), a);
  await palette('openLocation', 'Page c');
  const picked = await ui.evaluate(() => { const sugs = [...document.querySelectorAll('.sug')]; return sugs.map(x => x.textContent); });
  // choose the "switch to tab" result for the tab showing /c
  const tabIndex = await ui.evaluate(() => [...document.querySelectorAll('.sug')].findIndex(x => /Switch to Tab/.test(x.textContent)));
  check(tabIndex >= 0, 'typing a tab title offers "Switch to Tab"', picked);
  for (let i = 0; i < tabIndex; i++) await ui.locator('#palette-input').press('ArrowDown');
  s0 = await state();
  await ui.locator('#palette-input').press('Meta+Enter');
  s = await poll(async () => { const x = await state(); return x.active === c && x; }, 'switched');
  check(s.size === s0.size && s.active === c && urlOf(s, a).startsWith(`${base}/b`), 'cmd+l ⌘↵ on "Switch to Tab": just switches (no new tab, old tab unchanged)', s);

  // ---------- ⇧↵ in cmd+l: split ----------
  await W((w, id) => w.activate(id), a);
  s0 = await state();
  await palette('openLocation', `${base}/d`);
  await ui.locator('#palette-input').press('Shift+Enter');
  s = await poll(async () => { const x = await state(); const d = x.tabs.find(t => (t.url || '').startsWith(`${base}/d`)); return d && d.split && x; }, 'split');
  const d = s.tabs.find(t => t.url.startsWith(`${base}/d`));
  check(!!d.split && d.split === s.tabs.find(t => t.id === a).split && urlOf(s, a).startsWith(`${base}/b`), 'cmd+l ⇧↵: opens in split view next to the current tab, current tab url unchanged', s);

  // ---------- cmd+t palette ↵: still a new tab ----------
  s0 = await state();
  await palette('newTab', `${base}/e`);
  await ui.locator('#palette-input').press('Enter');
  s = await poll(async () => { const x = await state(); return x.size === s0.size + 1 && x; }, 'cmd+t new tab');
  check(urlOf(s, s.active).startsWith(`${base}/e`) && urlOf(s, a).startsWith(`${base}/b`), 'cmd+t ↵: new tab as before', s);

  console.log('\nshots:\n  ' + shot);
} catch (e) {
  failures.push({ message: 'exception', details: String(e.stack || e) }); console.error(e);
} finally {
  try { await app?.close(); } catch {}
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
