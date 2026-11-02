// olive:// pages as normal tabs (settings, ledger, profiles, extensions/uBO, onboarding),
// against the real app main in a disposable profile.
// Never attaches to installed Olive; temp OLIVE_USER_DATA_DIR, own OLIVE_PROFILE, ports 0,
// local fixture server only. Windows are shown inactive and never focused.
// Run: node scripts/internal-tabs-native-test.mjs [--shots]
//   --shots writes 1440-wide light/dark composites to notes/test-shots/olive-tab-scenarios/fixed/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(repo, 'notes/test-shots/olive-tab-scenarios/fixed');
const wantShots = process.argv.includes('--shots');
const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-internal-'));
const results = [];
const check = (ok, label, detail) => { results.push({ ok: !!ok, label, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' ' + JSON.stringify(detail))); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, label, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout: ' + label); };

// ---------- fixture server ----------
const held = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/redir') { res.writeHead(302, { Location: 'olive://settings' }); return res.end(); }
  res.setHeader('Content-Type', 'text/html');
  const page = (title, body = '') => res.end(`<title>${title}</title><body style="font:15px -apple-system;padding:40px"><h1>${title}</h1>${body}</body>`);
  if (u.pathname === '/attack') return page('attack fixture', `<a id=l href="olive://settings">settings</a> <a id=x href="olive://extensions/ublock/options">ubo</a> <a id=r href="/redir">redir</a><iframe id=f src="olive://settings/general" width=300 height=80></iframe><script>window.probe=()=>({bridge:typeof window.oliveSettings, setup:typeof window.oliveSetup, ledger:typeof window.ledger})</script>`);
  return page(u.searchParams.get('t') || 'page');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const fixture = path.join(tmp, 'fixture.cjs');
fs.writeFileSync(fixture, `
const { app, BaseWindow, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // audible fixture without a click
// No focus grabs from this fixture: windows appear inactive and never take focus.
for (const C of [BaseWindow, BrowserWindow]) { C.prototype.show = function () { this.showInactive(); }; C.prototype.focus = function () {}; }
app.focus = () => {};
require(${JSON.stringify(path.join(repo, 'src/main/main.js'))});
`);

async function launch(userData) {
  const app = await _electron.launch({
    executablePath: electronBin, args: [fixture], cwd: repo, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: userData, OLIVE_PROFILE: 'internal-tabs-test', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0', OLIVE_UNLOAD_TICK_MS: '3600000' },
  });
  await app.evaluate(async () => {
    while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
    global.olive.onboarding?.close();
    clearInterval(global.olive.discardTimer); // the test drives unloading with a fake clock
  });
  const ui = await poll(async () => (await app.windows()).find(p => p.url().includes('/ui/index.html')), 'ui');
  await ui.locator('#pinned, #unpinned').first().waitFor({ state: 'attached' });
  await app.evaluate(() => { const w = global.olive.focusedWindow(); w.win.setContentSize(1440, 900); w.setOverlay(null); });
  return { app, ui };
}
async function composite(app, file, theme, crop = null) {
  const png = await app.evaluate(async ({ BrowserWindow }, theme) => {
    const w = global.olive.focusedWindow();
    const { width, height } = w.win.getContentBounds();
    const layers = [];
    for (const v of w.win.contentView.children) {
      if (!v.webContents || !v.getVisible?.()) continue;
      const b = v.getBounds(); if (b.width <= 0 || b.height <= 0) continue;
      const img = await v.webContents.capturePage();
      layers.push({ b, src: img.toDataURL() });
    }
    const c = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await c.loadURL('data:text/html,<body></body>');
      return await c.webContents.executeJavaScript(`(async () => {
        const layers = ${JSON.stringify(layers)}, W = ${width}, H = ${height}, s = 2;
        const cv = document.createElement('canvas'); cv.width = W * s; cv.height = H * s;
        const g = cv.getContext('2d'); g.scale(s, s);
        const grad = g.createLinearGradient(0, 0, W, H);
        ${JSON.stringify(theme)} === 'dark' ? (grad.addColorStop(0, '#2b352b'), grad.addColorStop(1, '#232b2e')) : (grad.addColorStop(0, '#cfdcbf'), grad.addColorStop(1, '#a9c6bf'));
        g.fillStyle = grad; g.fillRect(0, 0, W, H);
        for (const l of layers) {
          const im = new Image(); im.src = l.src; await im.decode();
          g.save(); const r = 10; g.beginPath(); g.roundRect(l.b.x, l.b.y, l.b.width, l.b.height, l.b.x || l.b.y ? r : 0); g.clip();
          g.drawImage(im, l.b.x, l.b.y, l.b.width, l.b.height); g.restore();
        }
        return cv.toDataURL('image/png');
      })()`);
    } finally { c.destroy(); }
  }, theme);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
  if (crop) execFileSync('/usr/bin/sips', ['-c', String(crop.h * 2), String(crop.w * 2), '--cropOffset', String(crop.y * 2), String(crop.x * 2), file], { stdio: 'pipe' });
  const wpx = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', file]).toString().match(/pixelWidth: (\d+)/)[1];
  console.log('shot', path.relative(repo, file), `${wpx}px`);
  written.push(file);
  return file;
}
async function setTheme(app, ui, pg, theme) {
  await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
  await ui.emulateMedia({ colorScheme: theme });
  if (pg) await pg.emulateMedia({ colorScheme: theme });
  await pause(300);
}


const written = [];
const S = app => app.evaluate(() => {
  const w = global.olive.focusedWindow();
  const snap = w.snapshot();
  return { activeId: w.activeId, url: snap.active?.url || null, count: w.tabs.size, appPanel: !!w.appPanel, inline: !!w.inlinePage,
    tabs: [...w.tabs.values()].map(t => ({ id: t.id, url: t.url, wcUrl: t.wc?.getURL() || null, pinned: t.pinned, title: t.customTitle || t.title, loaded: !!t.wc })),
    onboardingRow: snap.onboarding };
});
const activeTab = async app => { const s = await S(app); return s.tabs.find(t => t.id === s.activeId); };
// the playwright page for a tab (by its webContents url)
const pageFor = (app, pred) => poll(async () => (await app.windows()).filter(p => !p.isClosed() && pred(p.url())).pop(), 'page');
const loaded = (app, id) => app.evaluate(async (_, id) => {
  const f = global.olive.findTab(id); const wc = f?.tab.wc; if (!wc) return false;
  if (wc.isLoading()) await new Promise(r => { wc.once('did-stop-loading', r); setTimeout(r, 8000); });
  return true;
}, id);
const cmd = (app, type, a) => app.evaluate((_, [type, a]) => global.olive.focusedWindow().cmd(type, a || {}), [type, a]);
const submit = (app, input, mode = 'edit') => app.evaluate((_, [input, mode]) => global.olive.focusedWindow().submit({ mode, input }), [input, mode]);
const settled = async app => { await pause(150); const s = await S(app); for (const t of s.tabs) if (t.loaded) await loaded(app, t.id); await pause(150); return S(app); };

let app, ui;
try {
  const userData = path.join(tmp, 'p1'); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
  ({ app, ui } = await launch(userData));
  await app.evaluate(async (_, url) => { const w = global.olive.focusedWindow(); const t = w.createTab({ url, activate: true }); await new Promise(r => { t.wc.once('did-stop-loading', r); setTimeout(r, 8000); }); w.setOverlay(null); }, base + '/?t=web');

  // ---- cmd+, opens a Settings tab ----
  const menu = await app.evaluate(({ Menu }) => { const items = []; const walk = m => m.items.forEach(i => { items.push({ label: i.label, acc: i.accelerator || null }); if (i.submenu) walk(i.submenu); }); walk(Menu.getApplicationMenu()); return items.filter(i => /Settings|Keyboard Shortcuts|Extensions|Activities|Activity Event Log|Profiles|Set Up/.test(i.label)); });
  check(menu.find(i => i.label === 'Settings…')?.acc === 'Cmd+,', 'Cmd+, is Settings…', menu);
  await cmd(app, 'settings');
  let s = await settled(app);
  check(s.url === 'olive://settings' && s.count === 2 && !s.appPanel && !s.inline, 'cmd+, with no Settings tab: new foreground tab at olive://settings, no overlay', s);
  let gen = await pageFor(app, u => u === 'olive://settings/');
  await gen.locator('#unloadAfterMinutes').waitFor();
  check(await gen.inputValue('#unloadAfterMinutes') === '120', 'General renders its state through the bridge (unload 120)');
  const settingsId = s.activeId;
  // the sidebar row and address bar show the olive:// url
  await pause(300);
  const bar = await ui.evaluate(() => ({ host: document.querySelector('#urlbar .host')?.textContent, insecure: document.querySelector('#urlbar .lock')?.classList.contains('insecure') }));
  check(s.tabs.find(t => t.id === settingsId)?.url === 'olive://settings' && bar.host === 'olive://settings' && !bar.insecure, 'address bar shows olive://settings (not "not secure")', bar);

  // ---- section links, back/forward, reload ----
  await gen.click('#settings-tabs a[data-tab=shortcuts]');
  await poll(async () => (await activeTab(app))?.url === 'olive://settings/shortcuts', 'nav shortcuts');
  let sc = await pageFor(app, u => u === 'olive://settings/shortcuts');
  await sc.locator('#commands .row').first().waitFor();
  check(true, 'section link: olive://settings/shortcuts in the same tab, shortcuts render');
  await cmd(app, 'back'); await poll(async () => (await activeTab(app))?.url === 'olive://settings', 'back');
  check(true, 'back returns to olive://settings');
  await cmd(app, 'forward'); await poll(async () => (await activeTab(app))?.url === 'olive://settings/shortcuts', 'forward');
  check(true, 'forward returns to olive://settings/shortcuts');
  await cmd(app, 'reload'); await settled(app);
  sc = await pageFor(app, u => u === 'olive://settings/shortcuts');
  await sc.locator('#commands .row').first().waitFor();
  check((await activeTab(app)).url === 'olive://settings/shortcuts', 'reload keeps the section and works');

  // ---- shortcut recording takes every key, then gives them back ----
  await sc.locator('#commands input').first().focus();
  const rec1 = await poll(() => app.evaluate((_, id) => !!global.olive.findTab(id).tab.wc.__oliveRecordingKeys, settingsId), 'recording on');
  await sc.evaluate(() => document.activeElement.blur());
  await pause(200);
  const rec2 = await app.evaluate((_, id) => !!global.olive.findTab(id).tab.wc.__oliveRecordingKeys, settingsId);
  check(rec1 && !rec2, 'a focused shortcut field pauses menu/tab keys; blur resumes them');

  // ---- Esc doesn't close the tab ----
  await sc.keyboard.press('Escape'); await sc.keyboard.press('Escape'); await pause(300);
  check((await S(app)).tabs.some(t => t.id === settingsId), 'Esc does not close the Settings tab');

  // ---- cmd+, again focuses the existing tab (any section, as it is) ----
  const webId = (await S(app)).tabs.find(t => t.url.startsWith(base)).id;
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), webId);
  await cmd(app, 'settings');
  s = await settled(app);
  check(s.activeId === settingsId && s.count === 2 && s.url === 'olive://settings/shortcuts', 'cmd+, focuses the open Settings tab as it is (no second tab)', s);
  // a named entry point shows its section in that tab
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), webId);
  await cmd(app, 'extensions'); s = await settled(app);
  check(s.activeId === settingsId && s.count === 2 && s.url === 'olive://settings/extensions', 'Extensions… shows Settings > Extensions in the same tab', s);
  await cmd(app, 'sitePermissions'); s = await settled(app);
  check(s.activeId === settingsId && /^olive:\/\/settings\/general\?section=permissions/.test(s.url), 'site permissions entry: olive://settings/general?section=permissions', s.url);
  // cmd+, from another window focuses that tab too (prefers the current window first)
  const w2 = await app.evaluate(async (_, url) => { const w = global.olive.newWindow({}); w.createTab({ url, activate: true }); global.olive.focused = w; return w.id; }, base + '/?t=w2');
  await pause(500);
  await app.evaluate(() => global.olive.focusedWindow().cmd('settings', {}));
  await pause(300);
  const where = await app.evaluate((_, id) => { const f = global.olive.findTab(id); return { win: f.win.id, active: f.win.activeId === id, focused: global.olive.focused?.id, total: global.olive.windows.reduce((n, w) => n + [...w.tabs.values()].filter(t => /^olive:\/\/settings/.test(t.url)).length, 0) }; }, settingsId);
  check(where.active && where.total === 1, 'cmd+, from another window focuses the existing Settings tab (any window)', where);
  await app.evaluate((_, id) => { const w = global.olive.windows.find(x => x.id === id); w.win.close(); }, w2);
  await pause(400);
  await app.evaluate(() => { global.olive.focused = global.olive.windows[0]; });

  // ---- typed olive:// urls ----
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), webId);
  await submit(app, 'olive://ledger'); s = await settled(app);
  check((await activeTab(app)).id === webId && (await activeTab(app)).url === 'olive://ledger', 'typed olive://ledger loads in the current tab', await activeTab(app));
  const led = await pageFor(app, u => u === 'olive://ledger/');
  const ledgerState = await poll(() => led.evaluate(() => window.ledger?.call('get').then(r => r && Array.isArray(r.events)).catch(() => false)), 'ledger ipc');
  check(ledgerState, 'olive://ledger answers its ipc');
  await submit(app, 'olive://extensions'); s = await settled(app);
  check((await activeTab(app)).url === 'olive://settings/extensions', 'olive://extensions -> olive://settings/extensions', (await activeTab(app)).url);
  await submit(app, 'olive:profiles'); s = await settled(app);
  check((await activeTab(app)).url === 'olive://profiles', 'olive:profiles (no slashes) -> olive://profiles', (await activeTab(app)).url);
  const prof = await pageFor(app, u => u === 'olive://profiles/');
  check(await poll(() => prof.evaluate(() => window.oliveProfiles?.get().then(r => r.profiles.length > 0).catch(() => false)), 'profiles ipc'), 'olive://profiles answers its ipc');
  const wrong = await prof.evaluate(() => [typeof window.shortcuts, typeof window.oliveSettings, typeof window.ledger, typeof window.oliveSetup]);
  check(wrong.every(t => t === 'undefined'), 'a page only gets its own bridges (profiles: no settings/ledger/setup)', wrong);
  await submit(app, 'olive://shortcuts'); s = await settled(app);
  check((await activeTab(app)).url === 'olive://settings/shortcuts', 'old name olive://shortcuts -> olive://settings/shortcuts');

  // ---- web pages can't reach olive:// ----
  await submit(app, base + '/attack'); s = await settled(app);
  const atk = await pageFor(app, u => u.endsWith('/attack'));
  check(JSON.stringify(await atk.evaluate(() => window.probe())) === JSON.stringify({ bridge: 'undefined', setup: 'undefined', ledger: 'undefined' }), 'web pages get no olive bridges');
  const frame = await atk.evaluate(() => { try { return document.getElementById('f').contentWindow.location.href; } catch { return 'cross-origin'; } });
  const frames = await app.evaluate((_, id) => global.olive.findTab(id).tab.wc.mainFrame.framesInSubtree.map(f => f.url), webId);
  check(!frames.some(u => /^olive:/.test(u)), 'an iframe of olive://settings never loads', { frame, frames });
  await atk.evaluate(() => document.getElementById('l').click()); await pause(600);
  check((await activeTab(app)).url === base + '/attack', 'a link to olive://settings from a web page is blocked', (await activeTab(app)).url);
  await atk.evaluate(() => document.getElementById('x').click()); await pause(600);
  check((await activeTab(app)).url === base + '/attack', 'a link to olive://extensions/ublock/options is blocked');
  await atk.evaluate(() => { location.href = 'olive://ledger'; }).catch(() => {}); await pause(600);
  check((await activeTab(app)).url === base + '/attack', 'location = olive://ledger is blocked');
  const before = (await S(app)).count;
  await atk.evaluate(() => window.open('olive://settings')); await pause(600);
  check((await S(app)).count === before, 'window.open(olive://settings) is denied');
  await atk.evaluate(() => document.getElementById('r').click()); await pause(800);
  check(!/^olive:/.test((await activeTab(app)).url), 'a server redirect into olive:// is blocked', (await activeTab(app)).url);

  // ---- agent api: no olive:// ----
  const api = await app.evaluate(() => ({ api: global.olive.agentInfo().api, tokenFile: global.olive.agentInfo().tokenFile }));
  if (api.api && api.tokenFile) {
    const token = fs.readFileSync(api.tokenFile, 'utf8').trim();
    const call = (m, p, b) => fetch(api.api + p, { method: m, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.status);
    check(await call('POST', '/tabs', { url: 'olive://settings' }) === 403, 'agent api: POST /tabs olive://settings is 403');
    check(await call('POST', `/tabs/${settingsId}/eval`, { expression: '1' }) === 403, 'agent api: eval in a Settings tab is 403');
    check(await call('POST', `/tabs/${webId}/navigate`, { url: 'olive://ledger' }) === 403, 'agent api: navigate to olive://ledger is 403');
  } else check(false, 'agent api reachable', api);

  // ---- tab behaviors: split, pin, rename, mru, reopen, drag, unload ----
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), settingsId);
  await cmd(app, 'settings', { tab: 'general' }); await settled(app);
  await app.evaluate((_, [a, b]) => global.olive.focusedWindow().split(a, b), [settingsId, webId]);
  await pause(400);
  const vis = await app.evaluate(() => global.olive.focusedWindow().visibleIds());
  check(vis.includes(settingsId) && vis.includes(webId), 'split: Settings next to a web page', vis);
  if (wantShots) for (const theme of ['light', 'dark']) { const p = await pageFor(app, u => u.startsWith('olive://settings')); await setTheme(app, ui, p, theme); await composite(app, path.join(shots, `internal-settings-split-${theme}-1440.png`), theme); }
  await app.evaluate(() => { const w = global.olive.focusedWindow(); w.unsplit(w.activeId); });
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), settingsId);
  // shift+enter in the palette: olive:// opens in split too
  await app.evaluate(() => global.olive.focusedWindow().submit({ mode: 'split', input: 'olive://ledger' }));
  s = await settled(app);
  const vis2 = await app.evaluate(() => global.olive.focusedWindow().visibleIds().map(id => global.olive.findTab(id).tab.url));
  check(vis2.includes('olive://ledger'), 'shift+enter olive://ledger opens it in split', vis2);
  await app.evaluate(() => { const w = global.olive.focusedWindow(); w.unsplit(w.activeId); });
  // pin + split clone
  await app.evaluate((_, id) => global.olive.focusedWindow().setPinned(id, true), settingsId);
  s = await S(app);
  check(s.tabs.find(t => t.id === settingsId)?.pinned, 'pin a Settings tab');
  if (wantShots) for (const theme of ['light', 'dark']) { await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), settingsId); const p = await pageFor(app, u => u.startsWith('olive://settings')); await setTheme(app, ui, p, theme); await composite(app, path.join(shots, `internal-settings-pinned-${theme}-1440.png`), theme); }
  const clone = await app.evaluate((_, [a, b]) => { const w = global.olive.focusedWindow(); const r = w.split(a, b); return r ? { a: r.a?.id ?? r.a, url: w.tabs.get(r.a?.id ?? r.a)?.url } : null; }, [settingsId, webId]);
  await settled(app);
  check(clone && /^olive:\/\/settings/.test(clone.url) && clone.a !== settingsId, 'split of a pinned Settings tab clones it into a normal tab', clone);
  await app.evaluate(() => { const w = global.olive.focusedWindow(); w.unsplit(w.activeId); });
  if (clone?.a) await app.evaluate((_, id) => global.olive.focusedWindow().closeTab(id, { force: true }), clone.a);
  await app.evaluate((_, id) => global.olive.focusedWindow().setPinned(id, false), settingsId);
  // rename
  await app.evaluate((_, id) => global.olive.focusedWindow().renameTab(id, 'My Settings'), settingsId);
  check((await S(app)).tabs.find(t => t.id === settingsId).title === 'My Settings', 'rename a Settings tab');
  await app.evaluate((_, id) => global.olive.focusedWindow().resetTabName(id), settingsId);
  // mru: ctrl+tab walks between a web tab and Settings
  await app.evaluate((_, [a, b]) => { const w = global.olive.focusedWindow(); w.activate(a); w.activate(b); }, [settingsId, webId]);
  await app.evaluate(() => { const w = global.olive.focusedWindow(); w.walkTabs(1); w.finishTabWalk(); });
  check((await S(app)).activeId === settingsId, 'mru walk (ctrl+tab) lands on the Settings tab');
  // drag (move) in the sidebar
  const order1 = await app.evaluate((_, id) => { const w = global.olive.focusedWindow(); w.moveTabs([id], 'unpinned', w.unpinned.length, null); return w.unpinned.indexOf(id) === w.unpinned.length - 1; }, settingsId);
  check(order1, 'drag a Settings tab to the end of the list');
  // unload is safe: the page comes back with its state on activate
  await app.evaluate((_, [a, b]) => { const w = global.olive.focusedWindow(); w.activate(b); w.unload(w.tabs.get(a)); w.changed(); }, [settingsId, webId]);
  check(!(await S(app)).tabs.find(t => t.id === settingsId).loaded, 'Settings tab unloads like any background tab');
  await app.evaluate((_, id) => global.olive.focusedWindow().activate(id), settingsId);
  await settled(app);
  gen = await pageFor(app, u => /^olive:\/\/settings\/(general)?(\?|$)/.test(u));
  await gen.locator('#unloadAfterMinutes').waitFor();
  check(await gen.inputValue('#unloadAfterMinutes') === '120', 'an unloaded Settings tab reloads and works');
  // close + reopen closed
  await app.evaluate((_, id) => global.olive.focusedWindow().closeTab(id), settingsId);
  check(!(await S(app)).tabs.some(t => /^olive:\/\/settings/.test(t.url)), 'close a Settings tab (cmd+w)');
  await cmd(app, 'reopenClosed'); s = await settled(app);
  const reopened = s.tabs.find(t => /^olive:\/\/settings/.test(t.url));
  check(reopened && reopened.id === s.activeId, 'reopen closed (shift+cmd+t) brings Settings back', reopened);
  gen = await pageFor(app, u => /^olive:\/\/settings\/(general)?(\?|$)/.test(u));
  await gen.locator('#unloadAfterMinutes').waitFor();
  check(true, 'the reopened Settings tab works');
  if (wantShots) for (const theme of ['light', 'dark']) { await setTheme(app, ui, gen, theme); await composite(app, path.join(shots, `internal-settings-tab-${theme}-1440.png`), theme); }

  // ---- private windows open olive:// in a normal window ----
  const priv = await app.evaluate(async () => { const w = global.olive.newWindow({ private: true }); global.olive.focused = w; await new Promise(r => setTimeout(r, 400)); w.submit({ mode: 'new', input: 'olive://ledger' }); await new Promise(r => setTimeout(r, 600)); const inPriv = [...w.tabs.values()].some(t => /^olive:/.test(t.url)); const id = w.id; w.win.close(); return { inPriv, normal: global.olive.windows.some(x => !x.isPrivate && [...x.tabs.values()].some(t => t.url === 'olive://ledger')) }; });
  await pause(400);
  await app.evaluate(() => { global.olive.focused = global.olive.windows.find(w => !w.isPrivate); });
  check(!priv.inPriv && priv.normal, 'olive:// typed in a private window opens in a normal window', priv);

  // ---- uBO: olive://extensions/ublock and its own pages ----
  await poll(() => app.evaluate(() => !!global.olive.extensions?.ext), 'ublock loaded', 300).catch(() => null);
  await cmd(app, 'ublock'); s = await settled(app);
  check((await activeTab(app)).url === 'olive://extensions/ublock', 'shield opens olive://extensions/ublock as a tab', (await activeTab(app)).url);
  const ubo = await pageFor(app, u => u === 'olive://extensions/ublock');
  await poll(() => ubo.evaluate(() => /Blocking|Not installed/.test(document.querySelector('#status').textContent)), 'ubo state');
  check(true, 'uBO page renders its state through the bridge');
  await ubo.click('#options'); s = await settled(app); await pause(500);
  const opt = await activeTab(app);
  check(opt.url === 'olive://extensions/ublock/options' && /^chrome-extension:\/\/[a-p]{32}\/dashboard\.html/.test(opt.wcUrl || ''), 'uBO options: address olive://extensions/ublock/options, page is the extension dashboard', opt);
  const snapUrl = (await S(app)).url;
  check(!/chrome-extension/.test(snapUrl || ''), 'the address bar never shows chrome-extension://', snapUrl);
  if (wantShots) for (const theme of ['light', 'dark']) { const p = await pageFor(app, u => u.includes('dashboard.html')); await setTheme(app, ui, p, theme); await composite(app, path.join(shots, `internal-ublock-options-${theme}-1440.png`), theme); }
  await submit(app, 'olive://extensions/ublock/dashboard'); s = await settled(app); await pause(300);
  check(/dashboard\.html/.test((await activeTab(app)).wcUrl || ''), 'typed olive://extensions/ublock/dashboard loads the dashboard');
  await cmd(app, 'reload'); await settled(app);
  check((await activeTab(app)).url === 'olive://extensions/ublock/options', 'reload keeps the olive:// address', (await activeTab(app)).url);

  // ---- onboarding as a tab ----
  await app.evaluate(() => { const o = global.olive.onboarding; o.saved = { version: 1, step: 'welcome', completed: false }; o.save(); });
  await cmd(app, 'onboarding'); s = await settled(app);
  check((await activeTab(app)).url === 'olive://onboarding/welcome' && !s.inline, 'Set Up Olive opens olive://onboarding/welcome as a tab (no overlay)', (await activeTab(app)).url);
  const ob = await pageFor(app, u => u.startsWith('olive://onboarding'));
  await ob.locator('#welcome:not([hidden])').waitFor();
  await ob.click('#next');
  await poll(async () => (await activeTab(app)).url !== 'olive://onboarding/welcome', 'onboarding next');
  const step = await app.evaluate(() => global.olive.onboarding.saved.step);
  check((await activeTab(app)).url === `olive://onboarding/${step}`, 'the address follows the saved step', { url: (await activeTab(app)).url, step });
  await ob.keyboard.press('Escape'); await pause(300);
  check((await S(app)).tabs.some(t => /^olive:\/\/onboarding/.test(t.url)), 'Esc does not close the setup tab');
  if (wantShots) for (const theme of ['light', 'dark']) { await setTheme(app, ui, ob, theme); await composite(app, path.join(shots, `internal-onboarding-tab-${theme}-1440.png`), theme); }
  await cmd(app, 'onboarding'); s = await S(app);
  check(s.tabs.filter(t => /^olive:\/\/onboarding/.test(t.url)).length === 1, 'Set Up Olive again focuses the same tab');
  const obId = s.activeId;
  await app.evaluate((_, id) => global.olive.focusedWindow().closeTab(id), obId);
  await pause(200);
  const paused = await app.evaluate(() => ({ ...global.olive.onboarding.saved, view: !!global.olive.onboarding.view }));
  check(paused.paused && paused.pausedBy === 'user' && !paused.view, 'closing the setup tab pauses setup (like closing the panel did)', paused);
  await cmd(app, 'onboarding'); s = await settled(app);
  check((await activeTab(app)).url === `olive://onboarding/${step}`, 'reopening setup resumes at the saved step', (await activeTab(app)).url);
  await app.evaluate(() => global.olive.onboarding.command('finish'));
  await pause(300);
  check(!(await S(app)).tabs.some(t => /^olive:\/\/onboarding/.test(t.url)), 'Start Browsing closes the setup tab');

  // ---- no overlays left for these pages ----
  const overlays = await app.evaluate(() => global.olive.windows.map(w => ({ inline: w.inlinePage?.kind || null, panel: !!w.appPanel })));
  check(overlays.every(o => !o.inline && !o.panel), 'no inline page / app panel was used', overlays);
} catch (error) {
  check(false, 'test run', String(error?.stack || error));
} finally {
  try { await app?.close(); } catch {}
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok);
console.log(`internal tabs native: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
