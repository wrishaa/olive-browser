// Extensions settings page + hidden uBO sidebar button, against the real app main
// in a disposable profile. Never attaches to installed Olive; local network only.
// Windows are shown inactive and never focused (fixture patches show/focus).
// Run: node scripts/extension-settings-native-test.mjs [--shots]
//   --shots also writes 1440-wide light/dark composites to notes/test-shots/
//   (and a "before" toolbar shot from git a6919f1, the pre-change tree).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(repo, 'notes/test-shots');
const wantShots = process.argv.includes('--shots');
const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-ext-settings-'));
const results = [];
const check = (ok, label, detail) => { results.push({ ok: !!ok, label, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' ' + JSON.stringify(detail))); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, label, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout: ' + label); };

let adRequests = 0;
const server = http.createServer((req, res) => {
  if ((req.headers.host || '').startsWith('doubleclick.net:')) adRequests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Local blocker fixture</title><body style="font:15px -apple-system;padding:40px">local blocker fixture page</body>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageURL = `http://127.0.0.1:${port}/`;
const adURL = `http://doubleclick.net:${port}/pagead/ads?fixture=1`;

function fixtureFor(root) {
  const file = path.join(tmp, `fixture-${path.basename(root)}.cjs`);
  fs.writeFileSync(file, `
const { app, BaseWindow, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP doubleclick.net 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
// No focus grabs from this fixture: windows appear inactive and never take focus.
for (const C of [BaseWindow, BrowserWindow]) { C.prototype.show = function () { this.showInactive(); }; C.prototype.focus = function () {}; }
app.focus = () => {};
require(${JSON.stringify(path.join(root, 'src/main/main.js'))});
`);
  return file;
}
async function launch(root, userData) {
  const app = await _electron.launch({
    executablePath: electronBin, args: [fixtureFor(root)], cwd: root, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: userData, OLIVE_PROFILE: 'ext-settings-test', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' },
  });
  await app.evaluate(async () => {
    while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
    global.olive.onboarding?.close();
    const x = global.olive.extensions;
    for (let i = 0; i < 200 && !(x.status.installed && x.status.rulesets); i++) await new Promise(r => setTimeout(r, 50));
    // uBOL's worker restarts once ~200ms after load; let that happen, then wait
    // until the saved state is re-applied.
    await new Promise(r => setTimeout(r, 800));
    for (let i = 0; i < 200; i++) {
      await x.operation?.catch(() => {});
      if (x.status.enabled === (x.desiredEnabled !== false) && x.status.rulesets.length === (x.status.enabled ? 6 : 0)) break;
      await new Promise(r => setTimeout(r, 50));
    }
  });
  const ui = await poll(async () => (await app.windows()).find(p => p.url().includes('/ui/index.html')), 'ui');
  await ui.locator('#pinned, #unpinned').first().waitFor({ state: 'attached' });
  return { app, ui };
}
const mainState = app => app.evaluate(() => {
  const w = global.olive.focusedWindow(), x = global.olive.extensions;
  return { installed: x.status.installed, enabled: x.status.enabled, rulesets: (x.status.rulesets || []).length, showInToolbar: x.status.showInToolbar, activeUrl: w.tabs.get(w.activeId)?.url || null, activeTitle: w.tabs.get(w.activeId)?.title || null, pageURL: w.tabs.get(w.activeId)?.wc?.getURL() || null, panel: !!w.appPanel || !!w.inlinePage };
});
const uboButton = ui => ui.evaluate(() => { const e = document.querySelector('#btn-ublock'), r = e.getBoundingClientRect(); return { hidden: e.hidden, display: getComputedStyle(e).display, width: r.width, height: r.height, text: e.textContent }; });
async function openFixtureTab(app) {
  await app.evaluate(async (_, url) => {
    const w = global.olive.focusedWindow();
    w.win.setContentSize(1440, 900);
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    w.createTab({ url, activate: true, pinned: false });
    w.setOverlay(null);
    const tab = w.tabs.get(w.activeId);
    if (tab.wc.isLoading() || tab.wc.getURL() !== url) await new Promise(r => tab.wc.once('did-finish-load', r));
  }, pageURL);
}
const fetchAd = app => app.evaluate(async (_, url) => {
  // from the fixture web tab (Settings is its own tab now, often the active one)
  const w = global.olive.focusedWindow(), wc = [...w.tabs.values()].find(t => /^http/.test(t.url) && t.wc)?.wc || w.tabs.get(w.activeId).wc;
  return wc.executeJavaScript(`fetch(${JSON.stringify(url)}, {cache:'no-store'}).then(r=>r.ok&&r.url===${JSON.stringify(url)},()=>false)`);
}, adURL);
// Settings > Extensions is a tab at olive://settings/extensions
const settingsPage = app => poll(async () => (await app.windows()).filter(p => !p.isClosed() && p.url() === 'olive://settings/extensions').pop(), 'extensions page');

// Full-window composite of the native views (ui chrome + page/panel), in-process:
// capturePage per WebContentsView, drawn at its bounds in a hidden canvas window.
async function composite(app, file, theme) {
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
        // stand-in for the macOS window vibrancy behind the translucent sidebar
        const grad = g.createLinearGradient(0, 0, W, H);
        ${JSON.stringify(theme)} === 'dark' ? (grad.addColorStop(0, '#2b352b'), grad.addColorStop(1, '#232b2e')) : (grad.addColorStop(0, '#cfdcbf'), grad.addColorStop(1, '#a9c6bf'));
        g.fillStyle = grad; g.fillRect(0, 0, W, H);
        for (const l of layers) {
          const im = new Image(); im.src = l.src; await im.decode();
          g.save(); const r = 10; g.beginPath(); g.roundRect ? g.roundRect(l.b.x, l.b.y, l.b.width, l.b.height, l.b.x || l.b.y ? r : 0) : g.rect(l.b.x, l.b.y, l.b.width, l.b.height); g.clip();
          g.drawImage(im, l.b.x, l.b.y, l.b.width, l.b.height); g.restore();
        }
        return cv.toDataURL('image/png');
      })()`);
    } finally { c.destroy(); }
  }, theme);
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
  const w = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', file]).toString().match(/pixelWidth: (\d+)/)[1];
  console.log('shot', path.relative(repo, file), `${w}px (2x of 1440pt)`);
  return file;
}
async function setTheme(app, ui, theme) {
  await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
  await ui.emulateMedia({ colorScheme: theme });
  await pause(250);
}

const written = [];
let app, ui;
try {
  // ---------- before: the pre-change tree (git a6919f1) shows the uBO pill ----------
  if (wantShots) {
    const before = path.join(tmp, 'before-src');
    fs.mkdirSync(before);
    execFileSync('/bin/sh', ['-c', `git -C ${JSON.stringify(repo)} archive a6919f1 src vendor package.json | tar -x -C ${JSON.stringify(before)}`]);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(before, 'node_modules'));
    const data = path.join(tmp, 'profile-before'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
    ({ app, ui } = await launch(before, data));
    await openFixtureTab(app);
    const b = await uboButton(ui);
    check(!b.hidden && b.height > 0, 'before (a6919f1): uBO Lite pill is visible in the sidebar by default', b);
    for (const theme of ['light', 'dark']) { await setTheme(app, ui, theme); written.push(await composite(app, path.join(shots, `extensions-toolbar-before-${theme}.png`), theme)); }
    await app.close(); app = null;
  }

  // ---------- after: fresh profile ----------
  const data = path.join(tmp, 'profile'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
  ({ app, ui } = await launch(repo, data));
  await openFixtureTab(app);
  let s = await mainState(app);
  check(s.installed && s.enabled && s.rulesets === 6 && s.showInToolbar === false, 'fresh profile: uBO installed, blocking on (6 rulesets), showInToolbar false', s);
  let b = await uboButton(ui);
  check(b.hidden && b.display === 'none' && b.width === 0, 'no uBO button in the sidebar by default', b);
  check(!(await ui.evaluate(() => [...document.querySelectorAll('#sidebar *')].some(e => e.offsetParent && /uBO|uBlock/i.test(e.textContent) && !e.children.length))), 'no visible uBO/uBlock text anywhere in the sidebar');
  const before = adRequests;
  check(!(await fetchAd(app)) && adRequests === before, 'blocking still works with the button hidden: ad URL blocked before reaching the local server', { adRequests });
  if (wantShots) for (const theme of ['light', 'dark']) { await setTheme(app, ui, theme); written.push(await composite(app, path.join(shots, `extensions-toolbar-after-${theme}.png`), theme)); }

  // menu + palette
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'Olive').submenu.items.map(i => i.label));
  check(menu.includes('Extensions…'), 'Olive menu has Extensions…', menu);
  const sugg = await app.evaluate(async () => { const out = await global.olive.focusedWindow().suggest('extensions'); return (Array.isArray(out) ? out : out?.items || []).slice(0, 2); });
  check(sugg[0]?.commandId === 'extensions', 'cmd+l palette suggests Extensions for "extensions"', sugg);
  // open via the palette's own path: submitting the command item
  await app.evaluate((_, item) => { global.olive.focusedWindow().submit({ mode: 'edit', input: 'extensions', item }); }, sugg[0]);
  let page = await settingsPage(app);
  await page.locator('.ext').first().waitFor();
  s = await mainState(app);
  check(s.activeUrl === 'olive://settings/extensions' && !s.panel, 'cmd "extensions" opens Settings > Extensions as a tab (olive://settings/extensions, no overlay)', s);
  const sw = await page.evaluate(() => [...document.querySelectorAll('input.switch')].map(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), bg: c.backgroundColor }; }));
  check(sw.length === 2 && sw.every(x => x.w === 32 && x.h === 19 && x.bg !== 'rgba(0, 0, 0, 0)'), 'switches render as 32x19 tracks with a visible background', sw);
  const row = () => page.evaluate(() => { const r = document.querySelector('.ext'), img = r.querySelector('img.icon'); return { count: document.querySelectorAll('.ext').length, name: r.querySelector('.name').textContent, version: r.querySelector('.version').textContent, icon: img.complete && img.naturalWidth > 0, enabled: r.querySelector('[data-key=enabled]').checked, toolbar: r.querySelector('[data-key=showInToolbar]').checked, options: !r.querySelector('button.options').disabled }; });
  let r = await row();
  check(r.count === 1 && r.name === 'uBO Lite' && /^Version \d{4}\.\d+\.\d+$/.test(r.version) && r.icon, 'page lists uBO Lite with version and icon', r);
  check(r.enabled && !r.toolbar && r.options, 'enabled on, show-in-toolbar off, options button available', r);
  const sideRow = await ui.evaluate(() => document.querySelector('#settings-row').hidden);
  check(sideRow && /Extensions/.test(s.activeTitle || ''), 'sidebar shows it as a normal tab row (no app-page row)', { sideRow, title: s.activeTitle });
  if (wantShots) for (const theme of ['light', 'dark']) { await setTheme(app, ui, theme); await page.emulateMedia({ colorScheme: theme }); await pause(150); written.push(await composite(app, path.join(shots, `extensions-settings-${theme}.png`), theme)); }

  // IPC guard: the web tab cannot call the page's channel (no preload there) and
  // an untrusted sender gets null from the handler.
  const guard = await app.evaluate(async () => {
    const es = global.olive.extensionSettings;
    return es.trusted({ sender: { id: -1 }, senderFrame: null });
  });
  check(!guard, 'extensions IPC rejects senders other than a Settings > Extensions tab');

  // options: uBOL's dashboard used to stay blank (body.loading) because its worker
  // died on chrome.permissions; with Olive's worker shim it now renders inline.
  await page.locator('button.options').click();
  await poll(async () => (await mainState(app)).activeUrl === 'olive://extensions/ublock/options', 'options tab', 300);
  const dash = await app.evaluate(async () => {
    const w = global.olive.focusedWindow(), v = { webContents: w.tabs.get(w.activeId).wc };
    if (v.webContents.isLoading()) await new Promise(r => v.webContents.once('did-stop-loading', r));
    for (let i = 0; i < 100; i++) {
      const ok = await v.webContents.executeJavaScript(`!document.body.classList.contains('loading')`);
      if (ok) break;
      await new Promise(r => setTimeout(r, 50));
    }
    return { url: v.webContents.getURL(), dump: await v.webContents.executeJavaScript(`JSON.stringify({loading:document.body.classList.contains('loading'),tabs:[...document.querySelectorAll('.tabButton')].map(e=>e.textContent.trim()),mode:document.querySelector('.filteringModeCard input[type=radio]:checked')?.value||null,lists:(self.cachedRulesetData?.enabledRulesets||[]).length,text:document.body.innerText.slice(0,600)})`) };
  });
  const d = JSON.parse(dash.dump);
  console.log('DASH', JSON.stringify(d).slice(0, 900));
  check(/^chrome-extension:\/\/[a-p]{32}\/dashboard\.html$/.test(dash.url), 'Options… opens uBO Lite dashboard.html in a tab (address olive://extensions/ublock/options)', dash.url);
  check(!d.loading && d.text.trim().length > 40 && d.tabs.includes('Filter lists'), 'uBO Lite options page renders (no blank body.loading page)', d);
  // The filtering mode and enabled lists come from the worker's reply, so they prove it ran.
  check(['1', '2', '3'].includes(d.mode) && d.lists === 6, 'dashboard shows worker data: default filtering mode selected, the 6 enabled filter lists match Olive', { mode: d.mode, lists: d.lists });
  // uBOL picks light/dark once at page load (theme.js), so reload after switching.
  // (playwright pins prefers-color-scheme per attached page; set it like the other shots.)
  const dashPage = await poll(async () => (await app.windows()).find(p => p.url().endsWith('/dashboard.html')), 'dashboard page');
  const dashTheme = async theme => {
    await dashPage.emulateMedia({ colorScheme: theme });
    await dashPage.reload();
    await dashPage.waitForFunction(() => !document.body.classList.contains('loading'));
    return dashPage.evaluate(t => document.documentElement.classList.contains(t), theme);
  };
  await setTheme(app, ui, 'dark');
  check(await dashTheme('dark'), 'dashboard picks the dark theme when the system is dark (html.dark)');
  if (wantShots) for (const theme of ['light', 'dark']) { await setTheme(app, ui, theme); await dashTheme(theme); await pause(300); written.push(await composite(app, path.join(shots, `extensions-options-dashboard-${theme}.png`), theme)); }
  await setTheme(app, ui, 'light');
  await app.evaluate(() => global.olive.focusedWindow().cmd('extensions'));
  page = await settingsPage(app); await page.locator('.ext').first().waitFor();

  // toggles: show in toolbar → sidebar button appears; enabled off → blocking stops
  await page.locator('[data-key=showInToolbar]').click();
  await poll(async () => !(await uboButton(ui)).hidden, 'button shown');
  b = await uboButton(ui);
  check(!b.hidden && b.height > 0 && /uBO Lite/.test(b.text), 'toggling "Show in sidebar toolbar" shows the uBO button live', b);
  await page.locator('[data-key=enabled]').click();
  await poll(async () => (await mainState(app)).enabled === false, 'disabled');
  r = await row();
  check(!r.enabled && r.toolbar, 'page reflects enabled off + toolbar on', r);
  const n = adRequests;
  check(await fetchAd(app) && adRequests === n + 1, 'enabled off really disables blocking', { adRequests });
  const prefs = JSON.parse(fs.readFileSync(path.join(data, 'ublock-settings.json'), 'utf8'));
  check(prefs.enabled === false && prefs.showInToolbar === true, 'prefs saved to ublock-settings.json', prefs);

  // ---------- relaunch: toggles persist ----------
  await app.close(); app = null;
  ({ app, ui } = await launch(repo, data));
  s = await mainState(app);
  b = await uboButton(ui);
  check(s.installed && !s.enabled && s.rulesets === 0 && s.showInToolbar === true && !b.hidden, 'after relaunch: blocking stays off and the button stays shown', { s, b });
  // uBOL's worker re-applies its own ruleset list at session start; Olive's off must win.
  await openFixtureTab(app); await pause(1500);
  const real = await app.evaluate(() => global.olive.extensions.helper.webContents.executeJavaScript('chrome.declarativeNetRequest.getEnabledRulesets()'));
  const n0 = adRequests;
  check(real.length === 0 && (await fetchAd(app)) && adRequests === n0 + 1, 'after relaunch with blocking off, the running uBOL worker does not turn rulesets back on', { real, adRequests });
  await app.evaluate(() => global.olive.focusedWindow().cmd('extensions'));
  page = await settingsPage(app); await page.locator('.ext').first().waitFor();
  r = await row();
  check(!r.enabled && r.toolbar, 'after relaunch: page shows persisted toggles', r);
  await page.locator('[data-key=showInToolbar]').click();
  await page.locator('[data-key=enabled]').click();
  await poll(async () => { const v = await mainState(app); return v.enabled && v.showInToolbar === false; }, 'restored');
  await app.close(); app = null;
  ({ app, ui } = await launch(repo, data));
  await openFixtureTab(app);
  s = await poll(async () => { const v = await mainState(app); return v.enabled && v.rulesets === 6 && v; }, 'blocking re-applied after relaunch', 200).catch(() => mainState(app));
  b = await uboButton(ui);
  const m = adRequests;
  check(s.enabled && s.rulesets === 6 && s.showInToolbar === false && b.hidden && !(await fetchAd(app)) && adRequests === m, 'second relaunch: hidden + blocking again, both persisted', { s, b });
} catch (error) {
  results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) });
  console.error(error);
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise(r => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (written.length) console.log('screenshots:\n' + written.map(f => '  ' + path.relative(repo, f)).join('\n'));
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
if (results.some(r => !r.ok)) process.exitCode = 1;
