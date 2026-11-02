// Settings page + tab unloading, against the real app main in a disposable profile.
// Never attaches to installed Olive; temp OLIVE_USER_DATA_DIR, own OLIVE_PROFILE, ports 0,
// local fixture server only. Windows are shown inactive and never focused.
// Run: node scripts/settings-native-test.mjs [--shots]
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-settings-'));
const results = [];
const check = (ok, label, detail) => { results.push({ ok: !!ok, label, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' ' + JSON.stringify(detail))); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, label, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout: ' + label); };

// ---------- fixture server ----------
const held = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'text/html');
  const page = (title, body = '') => res.end(`<title>${title}</title><body style="font:15px -apple-system;padding:40px">${title}${body}</body>`);
  if (u.pathname === '/audio') return page('audio fixture', `<script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.02;o.connect(g).connect(c.destination);o.start();</script>`);
  if (u.pathname === '/form') return page('form fixture', `<p><input id=f autofocus placeholder="type here"><textarea id=t></textarea><input id=cb type=checkbox></p>`);
  if (u.pathname === '/slow') { held.push(res); res.write('<title>slow fixture</title>still loading'); return; } // never ends: tab stays loading
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
    env: { ...process.env, OLIVE_USER_DATA_DIR: userData, OLIVE_PROFILE: 'settings-test', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0', OLIVE_UNLOAD_TICK_MS: '3600000' },
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
const profileDir = name => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true })); return d; };
const panel = app => app.evaluate(({ BaseWindow }) => {
  const w = global.olive.focusedWindow(), p = w.appPanel;
  return { title: p?.options.title || null, url: p?.webContents.getURL() || null, kind: w.inlinePage?.kind || null, same: !!p && p === global.__lastPanel, windows: BaseWindow.getAllWindows().length,
    activeUrl: w.tabs.get(w.activeId)?.url || null, tab: global.olive.settingsPage.tab, ignoreMenus: null };
});
const remember = app => app.evaluate(() => { global.__lastPanel = global.olive.focusedWindow().appPanel; });
// newest match: a just-closed page with the same url can still be listed for a moment
const page = (app, file) => poll(async () => (await app.windows()).filter(p => !p.isClosed() && p.url().includes('/ui/' + file)).pop(), file);
const fileOf = url => (url || '').replace(/[?#].*$/, '').split('/').pop();

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

// open tabs in the focused window; returns their ids. waits for each to finish loading (except /slow)
const openTabs = (app, specs) => app.evaluate(async (_, specs) => {
  const w = global.olive.focusedWindow(), ids = [];
  for (const s of specs) {
    const t = w.createTab({ url: s.url, activate: !!s.activate, pinned: !!s.pinned });
    t.title = s.title || t.title;
    ids.push(t.id);
    if (!s.slow) await new Promise(r => { if (!t.wc.isLoading() && t.wc.getURL()) r(); else t.wc.once('did-stop-loading', r); setTimeout(r, 8000); });
  }
  return ids;
}, specs);
const loadedMap = app => app.evaluate(() => Object.fromEntries([...global.olive.focusedWindow().tabs.values()].map(t => [t.id, !!t.wc])));
const setClock = (app, minutes) => app.evaluate((_, m) => { const off = m * 60000; global.olive.clock = () => Date.now() + off; }, minutes);
const discard = (app, opts) => app.evaluate((_, o) => global.olive.discardIdleTabs(o || {}), opts);
const resetTabs = app => app.evaluate(async (_, url) => {
  const w = global.olive.focusedWindow();
  global.olive.clock = null;
  for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
  const t = w.createTab({ url, activate: true });
  await new Promise(r => { if (!t.wc.isLoading() && t.wc.getURL()) r(); else t.wc.once('did-stop-loading', r); setTimeout(r, 8000); });
  w.setOverlay(null);
  return t.id;
}, `${base}/?t=active`);
const setSettings = (app, values) => app.evaluate((_, v) => { for (const [k, x] of Object.entries(v)) global.olive.setSetting(k, x); return global.olive.unloadState(); }, values);

const written = [];
let app, ui;
try {
  const data = profileDir('profile');
  ({ app, ui } = await launch(data));
  await resetTabs(app);

  // ---------- defaults ----------
  let st = await app.evaluate(() => global.olive.unloadState());
  check(st.unloadAfterMinutes === 120 && st.pinnedUnloadAfterMinutes === 480 && st.maxLoadedTabs === 0, 'fresh profile: unload 120 min, pinned 480 min, cap off (0)', st);

  // ---------- entry points ----------
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'Olive').submenu.items.map(i => ({ label: i.label, acc: i.accelerator || null })));
  const settingsItem = menu.find(i => i.label === 'Settings…');
  check(settingsItem?.acc === 'Cmd+,', 'Olive > Settings… is on Cmd+,', settingsItem);
  check(menu.find(i => i.label === 'Keyboard Shortcuts…')?.acc === null, 'Keyboard Shortcuts… stays, without an accelerator', menu);
  const allAcc = await app.evaluate(({ Menu }) => { const out = []; const walk = items => { for (const i of items) { if (i.accelerator) out.push([i.label, i.accelerator]); if (i.submenu) walk(i.submenu.items); } }; walk(Menu.getApplicationMenu().items); return out; });
  check(allAcc.filter(([, a]) => a === 'Cmd+,').length === 1, 'nothing else in the menus uses Cmd+,', allAcc.filter(([, a]) => a === 'Cmd+,'));
  const sideBefore = await ui.evaluate(() => [...document.querySelectorAll('#sidebar *')].filter(e => e.offsetParent && !e.children.length && /^settings$/i.test(e.textContent.trim())).length);
  check(sideBefore === 0, 'no Settings entry in the sidebar while closed', sideBefore);

  // palette: "settings" -> Settings command
  const sugg = await app.evaluate(() => global.olive.focusedWindow().suggest('settings').slice(0, 3));
  check(sugg[0]?.kind === 'command' && sugg[0].commandId === 'settings' && sugg[0].title === 'Settings', 'cmd+l palette: "settings" suggests Settings first', sugg);
  await app.evaluate((_, item) => global.olive.focusedWindow().submit({ mode: 'edit', input: 'settings', item }), sugg[0]);
  let gen = await page(app, 'settings-general.html');
  await gen.locator('#unloadAfterMinutes').waitFor();
  let p = await panel(app);
  check(p.title === 'Settings' && fileOf(p.url) === 'settings-general.html' && p.kind === 'settings', 'palette opens Settings > General inline', p);
  await remember(app);
  const windowsAtStart = p.windows;
  const tabsUi = await gen.evaluate(() => [...document.querySelectorAll('#settings-tabs [role=tab]')].map(b => [b.textContent, b.getAttribute('aria-selected')]));
  check(JSON.stringify(tabsUi) === JSON.stringify([['General', 'true'], ['Keyboard Shortcuts', 'false'], ['Activities', 'false'], ['Extensions', 'false']]), 'tab bar: General | Keyboard Shortcuts | Activities | Extensions', tabsUi);
  const sideOpen = await ui.evaluate(() => !document.querySelector('#settings-row').hidden && document.querySelector('#settings-row .title').textContent);
  check(sideOpen === 'Settings', 'while open, the app-page row reads Settings (same as other inline pages)', sideOpen);

  // every old entry point lands in the same page, on the right tab
  const routes = [
    ['menu Settings…', "menu:Settings…", 'settings-general.html'],
    ['menu Keyboard Shortcuts…', 'menu:Keyboard Shortcuts…', 'shortcuts.html'],
    ['menu Extensions…', 'menu:Extensions…', 'extensions.html'],
    ['menu Activities — Site Time…', 'menu:Activities — Site Time…', 'site-time.html'],
    ['palette command shortcuts', 'cmd:shortcuts', 'shortcuts.html'],
    ['palette command extensions', 'cmd:extensions', 'extensions.html'],
    ['palette command activities', 'cmd:activities', 'site-time.html'],
    ['palette command Site Permissions', 'cmd:sitePermissions', 'settings-general.html'],
    ['cmd settings (Cmd+, path)', 'cmd:settings', 'settings-general.html'],
    ['olive://settings', 'url:olive://settings', 'settings-general.html'],
    ['olive://settings/general', 'url:olive://settings/general', 'settings-general.html'],
    ['olive://settings/shortcuts', 'url:olive://settings/shortcuts', 'shortcuts.html'],
    ['olive://settings/activities', 'url:olive://settings/activities', 'site-time.html'],
    ['olive://settings/extensions', 'url:olive://settings/extensions', 'extensions.html'],
    ['olive://shortcuts (alias)', 'url:olive://shortcuts', 'shortcuts.html'],
    ['olive://extensions (alias)', 'url:olive://extensions', 'extensions.html'],
    ['olive://activities (alias)', 'url:olive://activities', 'site-time.html'],
    ['olive://settings typed as a new tab (cmd+t)', 'new:olive://settings', 'settings-general.html'],
  ];
  const activeBefore = (await panel(app)).activeUrl;
  for (const [label, how, file] of routes) {
    await app.evaluate(({ Menu }, how) => {
      const w = global.olive.focusedWindow();
      const [kind, arg] = [how.slice(0, how.indexOf(':')), how.slice(how.indexOf(':') + 1)];
      if (kind === 'menu') Menu.getApplicationMenu().items.find(i => i.label === 'Olive').submenu.items.find(i => i.label === arg).click();
      else if (kind === 'cmd') w.cmd(arg);
      else if (kind === 'url') { const item = w.suggest(arg)[0]; w.submit({ mode: 'edit', input: arg, item }); }
      else if (kind === 'new') w.submit({ mode: 'new', input: arg });
    }, how);
    await poll(async () => fileOf((await panel(app)).url) === file, label);
    p = await panel(app);
    check(fileOf(p.url) === file && p.same && p.windows === windowsAtStart && p.activeUrl === activeBefore, `${label} -> ${file} (same page, no new window, tab not navigated)`, p);
  }
  const oliveSugg = await app.evaluate(() => global.olive.focusedWindow().suggest('olive://settings/extensions')[0]);
  check(oliveSugg?.commandId === 'settings' && oliveSugg.title === 'Settings — Extensions', 'palette shows a Settings suggestion for a typed olive:// url', oliveSugg);
  const ledger = await app.evaluate(() => { const w = global.olive.focusedWindow(); w.cmd('activities'); return true; });
  let act = await page(app, 'site-time.html');
  await act.locator('#open-ledger').waitFor();
  await act.click('#open-ledger');
  await poll(async () => fileOf((await panel(app)).url) === 'ledger.html', 'ledger');
  check(ledger && fileOf((await panel(app)).url) === 'ledger.html', 'Activities tab links to the Activity Event Log');

  // each tab renders (clicking the tab bar)
  await app.evaluate(() => global.olive.focusedWindow().cmd('settings'));
  gen = await page(app, 'settings-general.html');
  for (const [tab, file, sel] of [['shortcuts', 'shortcuts.html', '#commands .row'], ['activities', 'site-time.html', '#time-total'], ['extensions', 'extensions.html', '.ext'], ['general', 'settings-general.html', '#sites']]) {
    const cur = (await app.windows()).find(x => !x.isClosed() && /\/ui\/(settings-general|shortcuts|site-time|extensions)\.html/.test(x.url()));
    await cur.click(`#settings-tabs [data-tab=${tab}]`);
    const pg = await page(app, file);
    await pg.locator(sel).first().waitFor();
    const info = await pg.evaluate(s => ({ count: document.querySelectorAll(s).length, sel: document.querySelector('#settings-tabs [aria-selected=true]')?.dataset.tab, url: document.querySelector('.settings-url')?.textContent }), sel);
    check(info.count > 0 && info.sel === tab, `tab ${tab} renders (${sel})`, info);
  }
  const shortcutIgnore = await app.evaluate(async () => { const s = global.olive.settingsPage; s.show(undefined, 'shortcuts'); return s.view.options.captureEscape; });
  check(shortcutIgnore === true, 'shortcuts tab captures Escape for the key recorder');
  const cmdRow = await (await page(app, 'shortcuts.html')).evaluate(() => [...document.querySelectorAll('#commands .row')].find(r => r.querySelector('label').textContent === 'Settings')?.querySelector('input').value);
  check(cmdRow === '⌘,', 'Shortcuts tab lists Settings on ⌘, (remappable)', cmdRow);

  // ---------- General: edit the three unloading values in the page ----------
  await app.evaluate(() => global.olive.focusedWindow().cmd('settings'));
  gen = await page(app, 'settings-general.html');
  await gen.locator('#unloadAfterMinutes').waitFor();
  await poll(() => gen.evaluate(() => document.querySelector('#unloadAfterMinutes').value === '120'), 'values');
  let f = await gen.evaluate(() => ({ u: unloadAfterMinutes.value, p: pinnedUnloadAfterMinutes.value, cap: maxLoadedTabs.value, capDisabled: maxLoadedTabs.disabled, capOn: capOn.checked, exempt: exempt.textContent }));
  check(f.u === '120' && f.p === '480' && f.cap === '' && f.capDisabled && !f.capOn, 'General shows 120 / 480 and an empty, disabled cap field while the cap is off', f);
  check(/on screen.*playing audio.*camera.*agent.*developer tools.*unsaved form input/.test(f.exempt), 'General lists the exemptions', f.exempt);
  if (wantShots) {
    for (const theme of ['light', 'dark']) { await setTheme(app, ui, gen, theme); await composite(app, path.join(shots, `settings-general-${theme}.png`), theme); }
    await setTheme(app, ui, gen, 'light');
    const r = await gen.evaluate(() => { const b = document.querySelector('#unloading').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const pb = await app.evaluate(() => global.olive.focusedWindow().appPanel.content.getBounds());
    await composite(app, path.join(shots, 'settings-unloading-1440.png'), 'light', { x: pb.x + r.x - 24, y: pb.y + r.y - 18, w: r.w + 48, h: r.h + 36 });
  }
  await gen.click('#capOn');
  await poll(async () => (await app.evaluate(() => global.olive.unloadState().maxLoadedTabs)) === 16, 'cap on');
  f = await gen.evaluate(() => ({ cap: maxLoadedTabs.value, capDisabled: maxLoadedTabs.disabled, capOn: capOn.checked, status: document.querySelector('#unload-status').textContent }));
  check(f.cap === '16' && !f.capDisabled && f.capOn, 'turning the cap on prefills 16 and enables the field', f);
  if (wantShots) {
    await gen.evaluate(() => document.activeElement?.blur());
    const r = await gen.evaluate(() => { const b = document.querySelector('#unloading').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const pb = await app.evaluate(() => global.olive.focusedWindow().appPanel.content.getBounds());
    await composite(app, path.join(shots, 'settings-unloading-cap-on-1440.png'), 'light', { x: pb.x + r.x - 24, y: pb.y + r.y - 18, w: r.w + 48, h: r.h + 36 });
  }
  await gen.click('#capOn');
  await poll(async () => (await app.evaluate(() => global.olive.unloadState().maxLoadedTabs)) === 0, 'cap off');
  f = await gen.evaluate(() => ({ cap: maxLoadedTabs.value, capDisabled: maxLoadedTabs.disabled, capOn: capOn.checked }));
  check(f.cap === '' && f.capDisabled && !f.capOn, 'turning the cap off empties and disables the field (0 saved)', f);
  await gen.click('#capOn');
  await poll(async () => (await app.evaluate(() => global.olive.unloadState().maxLoadedTabs)) === 16, 'cap on again');
  await gen.fill('#unloadAfterMinutes', '7'); await gen.press('#unloadAfterMinutes', 'Enter');
  await gen.fill('#pinnedUnloadAfterMinutes', '11'); await gen.press('#pinnedUnloadAfterMinutes', 'Tab');
  await poll(async () => (await app.evaluate(() => global.olive.unloadState().pinnedUnloadAfterMinutes)) === 11, 'pinned saved');
  await gen.fill('#maxLoadedTabs', '5'); await gen.press('#maxLoadedTabs', 'Enter');
  await poll(async () => (await app.evaluate(() => global.olive.unloadState().maxLoadedTabs)) === 5, 'cap 5');
  await gen.fill('#unloadAfterMinutes', '-4'); await gen.press('#unloadAfterMinutes', 'Enter');
  f = await gen.evaluate(() => ({ invalid: unloadAfterMinutes.getAttribute('aria-invalid'), status: document.querySelector('#unload-status').textContent }));
  st = await app.evaluate(() => global.olive.unloadState());
  check(f.invalid === 'true' && /whole number/.test(f.status) && st.unloadAfterMinutes === 7, 'a negative value is refused in the page, setting unchanged', { f, st });
  const file = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  check(file.unloadAfterMinutes === 7 && file.pinnedUnloadAfterMinutes === 11 && file.maxLoadedTabs === 5 && !('discardMinutes' in file), 'settings.json has 7 / 11 / 5', file);
  // the api can't reach the page channel: an untrusted sender gets null
  const guard = await app.evaluate(() => global.olive.settingsPage.trusted({ sender: { id: -1 }, senderFrame: null }));
  check(guard === false, 'settings IPC rejects senders other than the page itself');

  // ---------- site permissions folded into General ----------
  await app.evaluate((_, origin) => { global.olive.perms.data[`${origin}|media:video`] = true; global.olive.perms.data[`${origin}|notifications`] = false; }, 'https://meet.example');
  await app.evaluate(() => { global.olive.settingsPage.close(); global.olive.focusedWindow().cmd('sitePermissions'); });
  await pause(300);
  gen = await page(app, 'settings-general.html');
  await gen.locator('.site').first().waitFor();
  const sites = await gen.evaluate(() => [...document.querySelectorAll('.site')].map(d => ({ origin: d.dataset.origin, open: d.open, badge: d.querySelector('.badge').textContent })));
  check(sites[0]?.origin === base && sites[0].open && /current site/.test(sites[0].badge) && sites.some(s => s.origin === 'https://meet.example' && /2 saved/.test(s.badge)), 'Site permissions: current site first and open, saved sites listed', sites);
  await gen.evaluate(() => { const d = [...document.querySelectorAll('.site')].find(x => x.dataset.origin === 'https://meet.example'); d.open = true; });
  await gen.selectOption('.site[data-origin="https://meet.example"] select[aria-label^="Camera"]', 'block');
  await poll(async () => (await app.evaluate(() => global.olive.perms.data['https://meet.example|media:video'])) === false, 'perm block');
  await gen.click('.site[data-origin="https://meet.example"] .forget');
  await poll(async () => !(await app.evaluate(() => Object.keys(global.olive.perms.data).some(k => k.startsWith('https://meet.example|')))), 'forget');
  check(true, 'Site permissions: change a choice and forget a site from General');
  if (wantShots) {
    await app.evaluate((_, origin) => { const d = global.olive.perms.data; d[`${origin}|media:audio`] = true; d[`${origin}|media:video`] = true; d['https://maps.example|geolocation'] = true; d['https://news.example|notifications'] = false; global.olive.settingsPage.push(); global.olive.settingsPage.show(undefined, 'general'); }, 'https://meet.example');
  }

  // ---------- unloading at the right time: pinned vs not (fake clock) ----------
  await app.evaluate(() => global.olive.settingsPage.close());
  await setSettings(app, { unloadAfterMinutes: 7, pinnedUnloadAfterMinutes: 11, maxLoadedTabs: 0 });
  let active = await resetTabs(app);
  let [nA, pA] = await openTabs(app, [{ url: `${base}/?t=plain` }, { url: `${base}/?t=pinned`, pinned: true }]);
  await setClock(app, 6); await discard(app);
  let L = await loadedMap(app);
  check(L[nA] && L[pA] && L[active], 'at 6 min: nothing unloads (non-pinned threshold 7)', L);
  await setClock(app, 8); await discard(app);
  L = await loadedMap(app);
  check(!L[nA] && L[pA] && L[active], 'at 8 min: the non-pinned tab unloaded, pinned stays (threshold 11), active stays', L);
  await setClock(app, 12); await discard(app);
  L = await loadedMap(app);
  check(!L[pA] && L[active], 'at 12 min: the pinned tab unloaded, the active tab never', L);
  const sidebarRow = await app.evaluate((_, id) => { const t = global.olive.focusedWindow().tabs.get(id); return { kept: !!t, unloaded: t.snapshot().unloaded, url: t.url }; }, pA);
  check(sidebarRow.kept && sidebarRow.unloaded && /pinned/.test(sidebarRow.url), 'an unloaded tab stays in the sidebar with its url', sidebarRow);
  await setSettings(app, { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0 });
  [nA, pA] = await openTabs(app, [{ url: `${base}/?t=plain2` }, { url: `${base}/?t=pinned2`, pinned: true }]);
  await setClock(app, 100000); await discard(app);
  L = await loadedMap(app);
  check(L[nA] && L[pA], '0 = never: nothing unloads after 100000 min', L);
  // agent api POST /discard still works (one threshold, exemptions apply)
  const apiN = await app.evaluate(() => global.olive.discardIdleTabs({ olderThanMinutes: 0 }));
  L = await loadedMap(app);
  check(apiN === 2 && !L[nA] && !L[pA] && L[active], 'agent api discard {olderThanMinutes:0} unloads background tabs, not the active one', { apiN, L });

  // ---------- exemptions ----------
  await setSettings(app, { unloadAfterMinutes: 1, pinnedUnloadAfterMinutes: 1, maxLoadedTabs: 0 });
  active = await resetTabs(app);
  const [audio, agentTab, form, capture, slow, devtools, splitB, control] = await openTabs(app, [
    { url: `${base}/audio` }, { url: `${base}/?t=agent` }, { url: `${base}/form` }, { url: `${base}/?t=call` }, { url: `${base}/slow`, slow: true },
    { url: `${base}/?t=devtools` }, { url: `${base}/?t=split-b` }, { url: `${base}/form?t=control` },
  ]);
  // agent: attach the debugger like the agent api does
  await app.evaluate((_, id) => global.olive.focusedWindow().tabs.get(id).wc.debugger.attach('1.3'), agentTab);
  // dirty: real key events into the focused field of the form tab
  const dirty = await app.evaluate(async (_, id) => {
    const t = global.olive.focusedWindow().tabs.get(id), wc = t.wc;
    await wc.executeJavaScript('document.querySelector("#f").focus()');
    for (const ch of 'hi') { wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); }
    for (let i = 0; i < 40 && !t.dirty; i++) await new Promise(r => setTimeout(r, 50));
    return { dirty: t.dirty, value: await wc.executeJavaScript('document.querySelector("#f").value') };
  }, form);
  check(dirty.dirty, 'typing into a form field marks the tab dirty', dirty);
  // a key on a non-editable element does not
  const notDirty = await app.evaluate(async (_, id) => {
    const t = global.olive.focusedWindow().tabs.get(id), wc = t.wc;
    await wc.executeJavaScript('document.activeElement.blur(); document.querySelector("#cb").focus()');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'x' }); wc.sendInputEvent({ type: 'char', keyCode: 'x' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'x' });
    await new Promise(r => setTimeout(r, 400));
    return t.dirty;
  }, control);
  check(notDirty === false, 'a key on a checkbox (same form page) does not mark a tab dirty', notDirty);
  // capture: what permissions.js does when a camera/mic request is granted (no real device or TCC prompt in the test)
  await app.evaluate((_, id) => { const t = global.olive.focusedWindow().tabs.get(id); global.olive.permissions.markCapturing(t.wc); }, capture);
  await app.evaluate((_, id) => { const w = global.olive.focusedWindow(); w.openDevtools(w.tabs.get(id)); }, devtools);
  // split: active tab + splitB on screen together
  await app.evaluate((_, [a, b]) => { const w = global.olive.focusedWindow(); w.split(a, b); w.activate(a, { focusPage: false }); }, [active, splitB]);
  const audible = await poll(() => app.evaluate((_, id) => global.olive.focusedWindow().tabs.get(id).wc.isCurrentlyAudible(), audio), 'audible', 100).catch(() => false);
  check(audible, 'audio fixture is audible');
  await setClock(app, 600); await discard(app);
  L = await loadedMap(app);
  const why = await app.evaluate(() => global.olive.unloadFacts().filter(f => f.loaded).map(f => ({ id: f.id, title: f.t.title, reason: process.mainModule.require(process.cwd() + '/src/core/tab-unload.js').exemptReason(f) })));
  check(!L[control], 'control tab (no exemption) unloaded', why);
  for (const [label, id] of [['active', active], ['split pane', splitB], ['audible', audio], ['agent (debugger attached)', agentTab], ['dirty form', form], ['capturing', capture], ['still loading', slow], ['devtools open', devtools]])
    check(L[id], `exempt and still loaded: ${label}`, why);
  // the same exemptions hold for the cap
  await setSettings(app, { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 1 });
  await discard(app);
  L = await loadedMap(app);
  check([active, splitB, audio, agentTab, form, capture, slow, devtools].every(id => L[id]), 'max-loaded cap 1 never evicts exempt tabs', L);
  // navigating clears dirty; then it unloads
  await app.evaluate(async (_, [id, url]) => { const t = global.olive.focusedWindow().tabs.get(id); t.wc.loadURL(url); await new Promise(r => t.wc.once('did-stop-loading', r)); }, [form, `${base}/?t=after`]);
  await app.evaluate((_, id) => global.olive.focusedWindow().tabs.get(id).wc.debugger.detach(), agentTab);
  await setSettings(app, { unloadAfterMinutes: 1, maxLoadedTabs: 0 });
  await setClock(app, 1200); await discard(app);
  L = await loadedMap(app);
  check(!L[form] && !L[agentTab], 'after navigating (form) / detaching (agent) those tabs unload again', L);
  for (const r of held.splice(0)) r.destroy();

  // ---------- max-loaded eviction order ----------
  await setSettings(app, { unloadAfterMinutes: 0, pinnedUnloadAfterMinutes: 0, maxLoadedTabs: 0 });
  active = await resetTabs(app);
  const [p1, n1, n2, n3] = await openTabs(app, [{ url: `${base}/?t=p1`, pinned: true, title: 'p1' }, { url: `${base}/?t=n1`, title: 'n1' }, { url: `${base}/?t=n2`, title: 'n2' }, { url: `${base}/?t=n3`, title: 'n3' }]);
  // idle ages: p1 oldest of all, then n1, n2, n3
  await app.evaluate((_, ids) => { const w = global.olive.focusedWindow(), now = Date.now(); ids.forEach((id, i) => { const t = w.tabs.get(id); t.lastActive = t.loadedAt = now - (100 - i * 10) * 60000; t.lastVisible = 0; }); }, [p1, n1, n2, n3]);
  await app.evaluate(() => { const w = global.olive.focusedWindow(); global.__order = []; const u = w.unload.bind(w); w.unload = (t, o) => { if (t.wc) global.__order.push(t.title); return u(t, o); }; });
  await setSettings(app, { maxLoadedTabs: 3 });
  await discard(app);
  let order = await app.evaluate(() => global.__order);
  check(JSON.stringify(order) === JSON.stringify(['n1', 'n2']), 'cap 3 of 5 loaded: oldest-idle non-pinned first (n1, n2); older pinned p1 kept', order);
  await setSettings(app, { maxLoadedTabs: 1 });
  await discard(app);
  order = await app.evaluate(() => global.__order);
  L = await loadedMap(app);
  check(JSON.stringify(order) === JSON.stringify(['n1', 'n2', 'n3', 'p1']) && L[active], 'cap 1: remaining non-pinned (n3), then pinned (p1) only because still over; active kept', { order, L });

  // ---------- shots of the other tabs ----------
  if (wantShots) {
    await app.evaluate(() => { const w = global.olive.focusedWindow(); delete w.unload; });
    await resetTabs(app);
    for (const [tab, file, sel] of [['general', 'settings-general.html', '#sites'], ['shortcuts', 'shortcuts.html', '#commands .row'], ['activities', 'site-time.html', '#time-total'], ['extensions', 'extensions.html', '.ext']]) {
      await app.evaluate((_, tab) => global.olive.settingsPage.show(undefined, tab), tab);
      const pg = await page(app, file);
      await pg.locator(sel).first().waitFor();
      if (tab === 'general') await setSettings(app, { unloadAfterMinutes: 120, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 0 });
      for (const theme of ['light', 'dark']) { await setTheme(app, ui, pg, theme); await composite(app, path.join(shots, `settings-${tab}-${theme}.png`), theme); }
      await setTheme(app, ui, pg, 'light');
    }
  }

  // ---------- persistence across relaunch ----------
  await setSettings(app, { unloadAfterMinutes: 7, pinnedUnloadAfterMinutes: 11, maxLoadedTabs: 5 });
  await app.close(); app = null;
  ({ app, ui } = await launch(data));
  st = await app.evaluate(() => global.olive.unloadState());
  check(st.unloadAfterMinutes === 7 && st.pinnedUnloadAfterMinutes === 11 && st.maxLoadedTabs === 5, 'after relaunch: 7 / 11 / 5 kept', st);
  await app.evaluate(() => global.olive.focusedWindow().cmd('settings'));
  gen = await page(app, 'settings-general.html');
  await poll(() => gen.evaluate(() => document.querySelector('#unloadAfterMinutes').value === '7'), 'relaunch values');
  f = await gen.evaluate(() => ({ u: unloadAfterMinutes.value, p: pinnedUnloadAfterMinutes.value, cap: maxLoadedTabs.value, capOn: capOn.checked }));
  check(f.u === '7' && f.p === '11' && f.cap === '5' && f.capOn, 'after relaunch: General shows 7 / 11 / cap on at 5', f);
  // an explicit 16 chosen after the migration survives a relaunch
  await setSettings(app, { maxLoadedTabs: 16 });
  await app.close(); app = null;
  ({ app, ui } = await launch(data));
  st = await app.evaluate(() => global.olive.unloadState());
  check(st.maxLoadedTabs === 16, 'an explicitly chosen cap of 16 survives a relaunch', st);
  await app.close(); app = null;

  // ---------- legacy settings.json ----------
  for (const [name, legacy, want] of [
    ['old defaults', { cdp: false, agentApi: true, discardMinutes: 30, maxLoadedTabs: 16 }, { unloadAfterMinutes: 120, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 0 }],
    ['user-set', { cdp: false, agentApi: true, discardMinutes: 45, maxLoadedTabs: 8 }, { unloadAfterMinutes: 45, pinnedUnloadAfterMinutes: 480, maxLoadedTabs: 8 }],
  ]) {
    const d = profileDir('legacy-' + name.replace(/\W/g, ''));
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(legacy));
    ({ app, ui } = await launch(d));
    st = await app.evaluate(() => global.olive.unloadState());
    const onDisk = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));
    check(JSON.stringify(st) === JSON.stringify(want) && !('discardMinutes' in onDisk) && onDisk.tabUnloadVersion === 1, `legacy settings.json (${name}) migrates once`, { st, onDisk });
    await app.close(); app = null;
  }
} catch (err) {
  check(false, 'test run', String(err?.stack || err));
} finally {
  for (const r of held) r.destroy();
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok);
console.log(`\nsettings native: ${results.length - failed.length}/${results.length} passed${written.length ? `, ${written.length} shots` : ''}`);
process.exit(failed.length ? 1 : 0);
