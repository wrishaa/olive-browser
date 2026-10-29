// Native: site permissions on a webrtc page (the google meet flow, on a local fixture).
// Temp copy of Electron (own bundle id), own temp userData/profile, cdp + api off, local
// http://localhost fixture. macOS stubs: systemPreferences says granted (or denied when the
// test says so), askForMediaAccess / System Settings are trapped, chromium uses fake devices
// (--use-fake-device-for-media-stream) so no real camera / mic / TCC prompt. never the
// installed app, never a real site.
// Run: node scripts/media-perms-native-test.mjs
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-media-perms-'));
const root = path.join(tmp, 'userData'); fs.mkdirSync(root);
const output = path.join(project, 'notes/test-shots/media-perms');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cdp: false, agentApi: false }));
const wrapper = path.join(tmp, 'fixture.cjs');
fs.writeFileSync(wrapper, `
const { app, systemPreferences, shell, dialog } = require('electron');
app.setPath('userData', ${JSON.stringify(root)});
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
global.fixtureCalls = [];
global.fixtureMedia = { microphone:'granted', camera:'granted', screen:'denied' };
systemPreferences.getMediaAccessStatus = kind => global.fixtureMedia[kind] || 'not-determined';
systemPreferences.askForMediaAccess = async kind => { global.fixtureCalls.push('ask:' + kind); global.fixtureMedia[kind] = 'denied'; return false; };
shell.openExternal = async url => { global.fixtureCalls.push('open:' + url); };
dialog.showMessageBox = async () => { throw new Error('fixture: no dialogs'); };
require(${JSON.stringify(path.join(project, 'src/main/main.js'))});
`);

// the webrtc fixture: what meet does before its "allow microphone and camera" button
const fixture = `<!doctype html><title>Call fixture</title><body style="margin:0;font:15px -apple-system;background:#fff">
<div style="padding:28px"><h2 style="margin:0 0 8px">Team standup</h2><p style="color:#555">Ready to join?</p><button id="join">Allow microphone and camera</button><pre id="out"></pre></div>
<script>
window.states = async () => { const o = {}; for (const n of ['camera','microphone','notifications','geolocation']) o[n] = (await navigator.permissions.query({ name: n })).state; o.notification = Notification.permission; return o; };
window.devices = async () => (await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: !!d.label, id: !!d.deviceId }));
window.changes = [];
navigator.permissions.query({ name: 'camera' }).then(s => { window.camStatus = s; s.onchange = () => window.changes.push(s.state); });
window.join = () => { window.gum = 'pending'; navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(s => { window.gum = 'ok:' + s.getTracks().map(t => t.kind).sort().join('+'); s.getTracks().forEach(t => t.stop()); }, e => { window.gum = e.name; }); };
document.querySelector('#join').onclick = () => window.join();
</script>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fixture); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

const failures = []; let checks = 0, app;
const check = (ok, message, details) => { checks++; if (!ok) failures.push({ message, details }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && details !== undefined ? ': ' + JSON.stringify(details) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, tries = 200) { for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('Timed out: ' + label); }
const clone = path.join(tmp, 'Olive Media Perms Test.app');
execFileSync('/bin/cp', ['-cR', path.join(project, 'node_modules/electron/dist/Electron.app'), clone]);
for (const cmd of ['Set :CFBundleIdentifier com.reframe.olive.media-perms-test', 'Set :CFBundleName Olive Media Perms Test']) execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, path.join(clone, 'Contents/Info.plist')]);
const W = (fn, arg) => app.evaluate(({ nativeTheme }, { src, arg }) => { const w = global.olive.focusedWindow() || global.olive.windows[0]; return (new Function('w', 'arg', 'nativeTheme', `return (${src})(w, arg, nativeTheme)`))(w, arg, nativeTheme); }, { src: fn.toString(), arg });
const tabEval = (id, expr) => W((w, { id, expr }) => w.tabs.get(id).wc.executeJavaScript(expr, true), { id, expr });
const open = u => W(async (w, u) => { const t = w.createTab({ url: u, index: 1e9, activate: true }); await new Promise(r => { const wc = t.wc; if (!wc.isLoading()) return setTimeout(r, 50); wc.once('did-finish-load', () => setTimeout(r, 50)); }); return t.id; }, u);
const reload = id => W((w, id) => new Promise(r => { const wc = w.tabs.get(id).wc; wc.once('did-finish-load', () => setTimeout(r, 50)); wc.reload(); }), id);
const view = name => poll(async () => (await app.windows()).find(p => { try { return new URL(p.url()).pathname.endsWith(`/ui/${name}.html`); } catch { return false; } }), name);
const cards = async () => (await view('permissions')).evaluate(() => [...document.querySelectorAll('.card:not(.leaving)')].map(c => ({ origin: c.querySelector('.origin').textContent, text: c.querySelector('p').textContent })));
const pendingCount = () => app.evaluate(() => global.olive.permissions.pending.size);
const stored = () => app.evaluate(() => ({ ...global.olive.perms.data }));
async function shoot(page, label, appearance, omitBackground = false) {
  await app.evaluate(({ nativeTheme }, a) => { nativeTheme.themeSource = a; }, appearance);
  await page.emulateMedia({ colorScheme: appearance }); await sleep(350);
  check(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches) === (appearance === 'dark'), `${label} ${appearance}: appearance active`);
  const file = path.join(output, `${label}-${appearance}.png`); await page.screenshot({ path: file, omitBackground }); return file;
}

try {
  app = await _electron.launch({ executablePath: path.join(clone, 'Contents/MacOS/Electron'), args: [wrapper], cwd: project, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'media-perms-test', OLIVE_CDP: '0', OLIVE_API_PORT: '0' } });
  app.process().stderr.on('data', d => { const s = String(d); if (!/DevTools|Playwright|Fontations|fake/i.test(s)) process.stderr.write('[fixture] ' + s); });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise(r => setTimeout(r, 25)); global.olive.onboarding?.close(); const w = global.olive.focusedWindow() || global.olive.windows[0]; w.win.setSize(1280, 800); });

  // ---------- before deciding: prompt, nothing leaks ----------
  const tab = await open(`${base}/call`);
  let s = await tabEval(tab, 'states()');
  check(s.camera === 'prompt' && s.microphone === 'prompt' && s.notifications === 'prompt' && s.geolocation === 'prompt', 'before deciding, permissions.query says prompt (not denied)', s);
  check(s.notification === 'default', 'Notification.permission is default, not denied', s);
  let d = await tabEval(tab, 'devices()');
  check(d.length > 0 && d.every(x => !x.label && !x.id), 'enumerateDevices before allowing: no labels, no device ids', d);
  check((await tabEval(tab, `String(Object.getOwnPropertyDescriptor(PermissionStatus.prototype,'state').get.name)`)) === 'get state', 'shim getter looks native-ish (name "get state")');

  // ---------- meet's button -> olive prompt -> block ----------
  await tabEval(tab, 'join(), 1');
  let c = await poll(async () => { const x = await cards(); return x.length === 1 && x; }, 'prompt card');
  check(c[0].origin === base && /microphone and camera/.test(c[0].text), 'the "allow microphone and camera" button opens olive\'s prompt for this origin', c);
  const prompt = await view('permissions');
  const promptShots = [await shoot(prompt, 'prompt', 'light', true), await shoot(prompt, 'prompt', 'dark', true)];
  await prompt.locator('.card:not(.leaving)').getByRole('button', { name: 'Block', exact: true }).click();
  check(await poll(async () => (await tabEval(tab, 'window.gum')) !== 'pending' && true, 'gum settles') && (await tabEval(tab, 'window.gum')) === 'NotAllowedError', 'block: getUserMedia rejects NotAllowedError');
  let st = await stored();
  check(st[`${base}|media:audio`] === false && st[`${base}|media:video`] === false, 'block is stored per origin', st);
  s = await tabEval(tab, 'states()');
  check(s.camera === 'denied' && s.microphone === 'denied' && s.notifications === 'prompt', 'after block, query says denied (others still prompt)', s);
  check((await tabEval(tab, 'window.changes')).includes('denied'), 'PermissionStatus change event fired on block', await tabEval(tab, 'window.changes'));

  // ---------- block survives reload, no prompt ----------
  await reload(tab);
  s = await tabEval(tab, 'states()');
  check(s.camera === 'denied' && s.microphone === 'denied', 'block remembered across reload', s);
  await tabEval(tab, 'join(), 1'); await poll(async () => (await tabEval(tab, 'window.gum')) !== 'pending', 'gum after reload');
  check((await tabEval(tab, 'window.gum')) === 'NotAllowedError' && (await pendingCount()) === 0, 'blocked: no prompt again, getUserMedia rejects');
  const permsFile = await app.evaluate(({}) => { global.olive.perms.flush(); return require('path').join(global.olive.dataPath, 'permissions.json'); }).catch(() => null)
    || await app.evaluate(() => { global.olive.perms.flush(); return global.olive.dataPath + '/permissions.json'; });
  const persisted = JSON.parse(fs.readFileSync(permsFile, 'utf8'));
  check(persisted[`${base}|media:video`] === false, 'block written to permissions.json', persisted);

  // ---------- site settings: block -> ask -> prompt -> allow ----------
  await W(w => w.mgr.permissions.showSettings(w));
  const settings = await view('site-settings');
  await poll(async () => (await settings.evaluate(() => document.querySelector('#origin')?.textContent)) === base, 'settings origin');
  const value = label => settings.evaluate(l => { const row = [...document.querySelectorAll('#permissions .row')].find(r => r.querySelector('label').textContent === l); return row?.querySelector('select').value; }, label);
  check((await value('Camera')) === 'block' && (await value('Microphone')) === 'block', 'site settings shows camera + mic as Block');
  const settingsShots = [await shoot(settings, 'site-settings', 'light'), await shoot(settings, 'site-settings', 'dark')];
  const choose = (label, v) => settings.evaluate(({ l, v }) => { const row = [...document.querySelectorAll('#permissions .row')].find(r => r.querySelector('label').textContent === l); const sel = row.querySelector('select'); sel.value = v; sel.dispatchEvent(new Event('change')); }, { l: label, v });
  await choose('Camera', 'ask'); await poll(async () => (await stored())[`${base}|media:video`] === undefined, 'camera ask');
  await choose('Microphone', 'ask'); await poll(async () => (await stored())[`${base}|media:audio`] === undefined, 'mic ask');
  s = await poll(async () => { const x = await tabEval(tab, 'states()'); return x.camera === 'prompt' && x.microphone === 'prompt' && x; }, 'live prompt').catch(() => null);
  check(!!s, 'editing to Ask in site settings: page sees prompt live, without reload', s);
  await W(w => w.appPanel?.close());

  await tabEval(tab, 'join(), 1');
  c = await poll(async () => { const x = await cards(); return x.length === 1 && x; }, 'prompt again');
  check(c.length === 1, 'after Ask, the button prompts again');
  await (await view('permissions')).locator('.card:not(.leaving)').getByRole('button', { name: 'Allow', exact: true }).click();
  const gum = await poll(async () => { const v = await tabEval(tab, 'window.gum'); return v !== 'pending' && v; }, 'gum allow');
  check(gum === 'ok:audio+video', 'allow: getUserMedia gets audio + video', gum);
  s = await tabEval(tab, 'states()');
  check(s.camera === 'granted' && s.microphone === 'granted', 'after allow, query says granted', s);
  d = await tabEval(tab, 'devices()');
  check(d.some(x => x.kind === 'audioinput' && x.label && x.id) && d.some(x => x.kind === 'videoinput' && x.label && x.id), 'after allow, enumerateDevices lists (fake) devices with labels', d);
  check((await app.evaluate(() => global.fixtureCalls)).length === 0, 'macOS granted: no askForMediaAccess call');
  await reload(tab);
  s = await tabEval(tab, 'states()');
  check(s.camera === 'granted' && s.microphone === 'granted', 'allow remembered across reload', s);
  await tabEval(tab, 'join(), 1');
  check((await poll(async () => { const v = await tabEval(tab, 'window.gum'); return v !== 'pending' && v; }, 'gum remembered')) === 'ok:audio+video' && (await pendingCount()) === 0, 'remembered allow: no prompt, getUserMedia works');

  // ---------- macOS not determined then denied: allow -> ask OS -> toast + site settings ----------
  await app.evaluate(() => { global.fixtureMedia.microphone = 'not-determined'; global.fixtureMedia.camera = 'not-determined'; });
  await W(w => w.mgr.permissions.reset(w));
  await reload(tab);
  await tabEval(tab, 'join(), 1');
  await poll(async () => (await cards()).length === 1, 'prompt (os)');
  await (await view('permissions')).locator('.card:not(.leaving)').getByRole('button', { name: 'Allow', exact: true }).click();
  const gum2 = await poll(async () => { const v = await tabEval(tab, 'window.gum'); return v !== 'pending' && v; }, 'gum os denied');
  check(gum2 === 'NotAllowedError', 'macOS denies: the page call fails', gum2);
  check((await app.evaluate(() => global.fixtureCalls)).includes('ask:microphone'), 'allow triggered askForMediaAccess', await app.evaluate(() => global.fixtureCalls));
  const ui = await view('index');
  const toast = await poll(async () => { const t = await ui.evaluate(() => { const el = document.querySelector('#toast'); return el && getComputedStyle(el).display !== 'none' && el.textContent; }); return t && /macOS blocked/.test(t) && t; }, 'toast').catch(() => null);
  check(!!toast, 'toast says macOS blocked microphone/camera', toast);
  const settings2 = await poll(async () => (await app.windows()).find(p => p.url().endsWith('/ui/site-settings.html') && p !== settings), 'settings 2').catch(() => null)
    || await view('site-settings');
  check(!!(await W(w => !!w.appPanel)), 'site settings opened after the macOS denial');
  const sys = await settings2.evaluate(() => document.querySelector('#system')?.textContent || '');
  check(/Microphone\s*Blocked/.test(sys), 'site settings shows macOS microphone as Blocked', sys);
  await shoot(settings2, 'site-settings-macos-denied', 'light');
  await W(w => w.appPanel?.close());

  console.log('\nshots:'); for (const f of [...promptShots, ...settingsShots]) console.log('  ' + f);
} catch (e) {
  failures.push({ message: 'exception', details: String(e.stack || e) }); console.error(e);
} finally {
  try { await app?.close(); } catch {}
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
