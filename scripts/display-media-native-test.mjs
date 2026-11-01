// Native: getDisplayMedia (google meet's "present" button) on a local fixture, first call
// vs second call, while the page loads subframes / changes its url like meet does.
// Temp copy of Electron (own bundle id), temp userData/profile, cdp + api off, local
// http://localhost fixture. macOS is stubbed: screen recording reads granted and
// desktopCapturer.getSources returns one fake source (the first call is slow, like the
// real first call while macOS primes capture). This dev binary has no screen recording
// grant, so the capture itself ends in NotReadableError after olive's handler answered
// with a video source; the checks read olive's answer, not pixels. never the installed
// app, never a real site, never a real meeting.
// Run: node scripts/display-media-native-test.mjs
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { windowShot } from './lib/window-shot.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-display-media-'));
const root = path.join(tmp, 'userData'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cdp: false, agentApi: false }));
const output = path.join(project, 'notes/test-shots/meet-share');
fs.mkdirSync(output, { recursive: true });
const wrapper = path.join(tmp, 'fixture.cjs');
fs.writeFileSync(wrapper, `
const { app, systemPreferences, shell, dialog, desktopCapturer, nativeImage } = require('electron');
app.setPath('userData', ${JSON.stringify(root)});
global.fixture = { getSources: 0, firstDelay: 1500, answers: [], opened: [] };
systemPreferences.getMediaAccessStatus = () => 'granted';
systemPreferences.askForMediaAccess = async () => true;
shell.openExternal = async url => { global.fixture.opened.push(url); };
dialog.showMessageBox = async () => { throw new Error('fixture: no dialogs'); };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
desktopCapturer.getSources = async () => {
  const delay = global.fixture.getSources++ === 0 ? global.fixture.firstDelay : 0;
  if (delay) await new Promise(r => setTimeout(r, delay));
  const thumbnail = nativeImage.createFromDataURL('data:image/png;base64,' + png).resize({ width: 240, height: 135 });
  return [{ id: 'screen:1:0', name: 'Fixture display', display_id: '1', thumbnail, appIcon: null }, { id: 'window:2:0', name: 'Fixture window', display_id: '', thumbnail, appIcon: null }];
};
// record every answer olive gives chromium (must be exactly one per request)
app.on('session-created', ses => {
  const set = ses.setDisplayMediaRequestHandler;
  ses.setDisplayMediaRequestHandler = function (handler, opts) {
    return set.call(this, (request, callback) => { const n = global.fixture.answers.length; global.fixture.answers.push([]);
      handler(request, streams => { global.fixture.answers[n].push(streams && streams.video ? 'video:' + streams.video.id : 'none'); return callback(streams); }); }, opts);
  };
});
require(${JSON.stringify(path.join(project, 'src/main/main.js'))});
`);

const page = `<!doctype html><title>Present fixture</title><body style="margin:0;font:15px -apple-system;background:#fff">
<div style="padding:28px"><h2 style="margin:0 0 8px">Team standup</h2><button id="present">Present now</button><pre id="out"></pre><iframe id="side" style="display:block;width:300px;height:60px;border:1px solid #ddd"></iframe></div>
<script>
window.calls = []; let n = 0;
window.present = () => { const i = calls.length; calls.push('pending');
  navigator.mediaDevices.getDisplayMedia({ video: true }).then(s => { calls[i] = 'stream'; s.getTracks().forEach(t => t.stop()); }, e => { calls[i] = e.name; }); };
// what meet does around "present": load a subframe and rewrite its url (same document)
window.busy = () => { document.querySelector('#side').src = '/frame?' + (n++); history.replaceState({}, '', '/call?present=' + n); };
document.querySelector('#present').onclick = () => window.present();
</script>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/frame') ? '<p>side panel</p>' : page); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

const failures = []; let checks = 0, app;
const check = (ok, message, details) => { checks++; if (!ok) failures.push({ message, details }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && details !== undefined ? ': ' + JSON.stringify(details) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, tries = 160) { for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('Timed out: ' + label); }
const clone = path.join(tmp, 'Olive Display Media Test.app');
execFileSync('/bin/cp', ['-cR', path.join(project, 'node_modules/electron/dist/Electron.app'), clone]);
for (const cmd of ['Set :CFBundleIdentifier com.reframe.olive.display-media-test', 'Set :CFBundleName Olive Display Media Test']) execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, path.join(clone, 'Contents/Info.plist')]);
const W = (fn, arg) => app.evaluate((_, { src, arg }) => { const w = global.olive.windows[0]; return (new Function('w', 'arg', `return (${src})(w, arg)`))(w, arg); }, { src: fn.toString(), arg });
const tabEval = (id, expr) => W((w, { id, expr }) => w.tabs.get(id).wc.executeJavaScript(expr, true), { id, expr });
const view = async name => (await app.windows()).find(p => { try { return new URL(p.url()).pathname.endsWith(`/ui/${name}.html`); } catch { return false; } });
const cardCount = async () => { const v = await view('permissions'); return v ? v.locator('.card:not(.leaving)').count() : 0; };
const picker = () => poll(async () => { const v = await view('capture'); return v && (await v.locator('#sources button').count()) && v; }, 'share picker');
const result = (id, i) => poll(async () => { const c = await tabEval(id, 'calls'); return c[i] !== 'pending' && c[i]; }, 'getDisplayMedia result');
const fx = () => app.evaluate(() => JSON.parse(JSON.stringify(global.fixture)));
const settled = r => r === 'stream' || r === 'NotReadableError'; // handler gave video; the os capture may still fail on this dev binary

try {
  app = await _electron.launch({ executablePath: path.join(clone, 'Contents/MacOS/Electron'), args: [wrapper], cwd: project, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'display-media-test', OLIVE_CDP: '0', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' } });
  app.process().stderr.on('data', d => { const s = String(d); if (/Error:|TypeError|ReferenceError/.test(s) && !/Extension|DevTools|ManifestError|RuntimeError/.test(s)) process.stderr.write('[fixture] ' + s); });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise(r => setTimeout(r, 25)); global.olive.onboarding?.close(); global.olive.windows[0].win.setSize(1440, 900); });
  // the very first navigation right after startup sometimes stalls on a fresh profile; retry it
  const tab = await W(async (w, u) => { const t = w.createTab({ url: u, index: 1e9, activate: true, focusPage: false });
    for (let i = 0; i < 300 && (t.wc.isLoading() || !t.wc.getURL().startsWith(u)); i++) { if (i % 60 === 59) t.wc.loadURL(u).catch(() => {}); await new Promise(r => setTimeout(r, 50)); }
    return t.id; }, `${base}/call`);
  check((await tabEval(tab, 'location.pathname')) === '/call', 'fixture page loaded');

  // ---------- first click: prompt, page busy (subframe + url change) while the prompt is up ----------
  await tabEval(tab, 'present(), 1');
  await poll(async () => (await cardCount()) === 1, 'share prompt');
  await sleep(300); const promptShot = await windowShot(app, path.join(output, 'share-prompt-1440.png'));
  await tabEval(tab, 'busy(), 1'); await sleep(400);
  check((await cardCount()) === 1 && (await app.evaluate(() => global.olive.permissions.pending.size)) === 1, 'first click: subframe load + replaceState do not cancel the screen-share prompt');
  await (await view('permissions')).locator('.card:not(.leaving)').getByRole('button', { name: 'Allow once', exact: true }).click();
  // slow first getSources (1.5 s): the page keeps loading frames meanwhile
  await sleep(300); await tabEval(tab, 'busy(), 1'); await sleep(300); await tabEval(tab, 'busy(), 1');
  let pick = await picker();
  check(!!pick, 'first click: share picker opens even though the page navigated subframes / its url during the first (slow) getSources');
  await pick.evaluate(() => document.querySelector('#sources').scrollIntoView());
  await sleep(300); const shots = [await windowShot(app, path.join(output, 'share-picker-1440.png'))];
  await tabEval(tab, 'busy(), 1'); await sleep(300);
  pick = await view('capture');
  check(!!pick && (await pick.locator('#sources button').count()) === 2, 'first click: picker stays open across subframe load + replaceState');
  await pick.locator('#sources button').first().click();
  let r = await result(tab, 0); let f = await fx();
  check(settled(r) && f.answers[0]?.length === 1 && f.answers[0][0] === 'video:screen:1:0', 'first click: olive answers once with the chosen source', { r, answers: f.answers });

  // ---------- second click: no prompt (allow once for this document), picker, same answer ----------
  await tabEval(tab, 'present(), 1');
  pick = await picker(); await pick.locator('#sources button').nth(1).click();
  r = await result(tab, 1); f = await fx();
  check(settled(r) && f.answers[1]?.length === 1 && f.answers[1][0] === 'video:window:2:0', 'second click: same path, answers once', { r, answers: f.answers });
  check((await cardCount()) === 0, 'second click: no prompt (allow once still valid in this document)');

  // ---------- cancel in the picker: one answer, no stream ----------
  await tabEval(tab, 'present(), 1');
  pick = await picker(); await pick.locator('#cancel').click();
  r = await result(tab, 2); f = await fx();
  check(r !== 'stream' && f.answers[2]?.length === 1 && f.answers[2][0] === 'none', 'cancel: getDisplayMedia rejects, olive answers exactly once', { r, answers: f.answers });
  check((await app.evaluate(() => global.olive.permissions.pickers.size)) === 0, 'cancel: picker closed');

  // ---------- leaving the page (reload) still cancels an open picker ----------
  await tabEval(tab, 'present(), 1');
  await picker();
  await W((w, id) => w.tabs.get(id).wc.reload(), tab);
  await poll(async () => (await app.evaluate(() => global.olive.permissions.pickers.size)) === 0, 'picker closed on reload');
  f = await fx();
  check(f.answers[3]?.length === 1 && f.answers[3][0] === 'none', 'reload while the picker is open: picker closes, one "none" answer', f.answers);

  // ---------- after reload: allow once expired, prompt again; a reload cancels the prompt ----------
  await poll(async () => !(await W((w, id) => w.tabs.get(id).wc.isLoading(), tab)), 'reloaded');
  await tabEval(tab, 'present(), 1');
  await poll(async () => (await cardCount()) === 1, 'prompt after reload');
  check(true, 'after reload: allow once expired, screen share prompts again');
  await W((w, id) => w.tabs.get(id).wc.reload(), tab);
  await poll(async () => (await app.evaluate(() => global.olive.permissions.pending.size)) === 0, 'prompt cancelled on reload');
  check(true, 'reload cancels the pending screen-share prompt');
  check((await fx()).getSources === 4, 'getSources called once per picker', (await fx()).getSources);

  console.log('\nshots:'); for (const s of [promptShot, ...shots]) console.log('  ' + s);
} catch (e) {
  failures.push({ message: 'exception', details: String(e.stack || e) }); console.error(e);
} finally {
  try { await app?.close(); } catch {}
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
