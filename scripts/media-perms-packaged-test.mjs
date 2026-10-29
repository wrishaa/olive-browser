// Packaged-build check of site permissions (the meet flow) on the real signed Olive.app
// from dist/: temp userData + profile, its own CDP and agent API ports (never 9333/9222),
// chromium fake devices, local http://localhost webrtc page. Driven only through that
// build's own CDP + agent API. Never the installed app. If macOS has not already granted
// this app id mic/camera, the Allow step is skipped (it would raise a real TCC prompt).
// Run: node scripts/media-perms-packaged-test.mjs [path/to/Olive.app]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = process.argv[2] || path.join(project, 'dist/Olive-darwin-arm64/Olive.app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-pkg-perms-'));
const output = path.join(project, 'notes/test-shots/media-perms-packaged');
fs.mkdirSync(output, { recursive: true });
const cdpPort = 9461, apiPort = 9462;
const fixture = `<!doctype html><title>Call fixture</title><body style="margin:0;font:15px -apple-system;background:#fff">
<div style="padding:28px"><h2 style="margin:0 0 8px">Team standup</h2><p style="color:#555">Ready to join?</p><button id="join">Allow microphone and camera</button><pre id="out"></pre></div>
<script>
window.states = async () => { const o = {}; for (const n of ['camera','microphone']) o[n] = (await navigator.permissions.query({ name: n })).state; return o; };
window.devices = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind !== 'audiooutput').map(d => ({ kind: d.kind, label: d.label }));
window.join = () => { window.gum = 'pending'; navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(s => { window.gum = 'ok:' + s.getTracks().map(t => t.kind).sort().join('+'); s.getTracks().forEach(t => t.stop()); }, e => { window.gum = e.name; }); };
document.querySelector('#join').onclick = () => window.join();
</script>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fixture); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/call`;
const failures = []; let checks = 0, proc, browser;
const check = (ok, message, details) => { checks++; if (!ok) failures.push({ message, details }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${details !== undefined ? ': ' + JSON.stringify(details) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, tries = 300) { for (let n = 0; n < tries; n++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } throw new Error('Timed out: ' + label); }
const pages = () => browser.contexts().flatMap(c => c.pages());
const findPage = (re) => poll(async () => pages().find(p => re.test(p.url().split(/[?#]/)[0])), String(re));
let token;
const api = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${apiPort}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
let summary = {};
try {
  const userData = path.join(tmp, 'userData'); fs.mkdirSync(userData);
  // Setup is not under test here.
  fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
  proc = spawn(path.join(appPath, 'Contents/MacOS/Olive'), ['--use-fake-device-for-media-stream'], {
    env: { ...process.env, OLIVE_USER_DATA_DIR: userData, OLIVE_PROFILE: 'pkg-perms-test', OLIVE_CDP: '1', OLIVE_CDP_PORT: String(cdpPort), OLIVE_API_PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {}); proc.stdout.on('data', () => {});
  await poll(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok, 'cdp up');
  token = await poll(() => fs.existsSync(path.join(userData, 'agent-token')) && fs.readFileSync(path.join(userData, 'agent-token'), 'utf8').trim(), 'agent token');
  await poll(async () => (await api('GET', '/tabs')).status === 200, 'agent api up');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const opened = await api('POST', '/tabs', { url, activate: true });
  check(opened.status === 200, 'agent api opened the call page in the packaged build', opened.status);
  const tab = await findPage(/\/call$/);
  await tab.waitForLoadState('load');
  await api('POST', `/tabs/${opened.body.id}/activate`);
  if (process.env.DEBUG_PKG) console.log(JSON.stringify((await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).map(t => [t.type, t.url.slice(-60)])), pages().map(p => p.url().slice(-60)));
  const chrome = await findPage(/\/ui\/index\.html$/);
  // System status as Olive sees it (read-only; no TCC prompt).
  await chrome.evaluate(() => window.olive.cmd('sitePermissions'));
  let settings = await findPage(/\/ui\/site-settings\.html$/);
  const st0 = await poll(() => settings.evaluate(() => window.siteSettings.get()), 'site settings state');
  summary.system = st0.system;
  check(st0.permissions.find(p => p.key === 'media:audio').value === 'ask' && st0.permissions.find(p => p.key === 'media:video').value === 'ask', 'fresh origin: microphone and camera are Ask in site settings', st0.permissions.slice(0, 2));
  await settings.evaluate(() => { setTimeout(() => window.siteSettings.close(), 0); }).catch(() => {}); await sleep(300);
  if (process.env.DEBUG_PKG) { await sleep(500); console.log('after close', tab.isClosed(), pages().map(p => p.url().slice(-40)), JSON.stringify((await api('GET', '/tabs')).body).slice(0, 400)); }
  const before = await tab.evaluate(() => window.states());
  check(before.camera === 'prompt' && before.microphone === 'prompt', 'page sees prompt (not denied) before deciding', before);
  const leak = await tab.evaluate(() => window.devices());
  check(leak.every(d => !d.label), 'no device labels before the user decides', leak);
  // Block.
  await tab.click('#join');
  let prompt = await findPage(/\/ui\/permissions\.html$/);
  await prompt.locator('button').first().waitFor();
  const buttons = await prompt.locator('button').allTextContents();
  check(buttons.some(b => /Block/.test(b)) && buttons.some(b => /^Allow$/.test(b.trim())), 'olive prompt shows for the page (Block / Allow once / Allow)', buttons);
  for (const scheme of ['light', 'dark']) { await prompt.emulateMedia({ colorScheme: scheme }); await sleep(200); await prompt.screenshot({ path: path.join(output, `prompt-${scheme}.png`) }); }
  await prompt.emulateMedia({ colorScheme: null });
  await prompt.locator('button', { hasText: 'Block' }).click();
  await poll(() => tab.evaluate(() => window.gum !== 'pending' && window.gum), 'gum blocked');
  check(await tab.evaluate(() => window.gum) === 'NotAllowedError', 'Block rejects getUserMedia', await tab.evaluate(() => window.gum));
  await tab.reload(); await tab.waitForLoadState('load');
  check((await tab.evaluate(() => window.states())).camera === 'denied', 'block remembered across reload (page sees denied)');
  const perms = await poll(() => { const f = path.join(userData, 'permissions.json'); const d = fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')); return d && Object.keys(d).some(k => k.includes('media:video')) && d; }, 'permissions.json written', 100).catch(() => ({ missing: fs.readdirSync(userData) }));
  check(Object.entries(perms).some(([k, v]) => k.includes('media:video') && v === false), 'block stored in the temp profile permissions.json', perms);
  // Edit in site settings: back to Ask, live.
  await chrome.evaluate(() => window.olive.cmd('sitePermissions'));
  settings = await findPage(/\/ui\/site-settings\.html$/);
  await poll(() => settings.evaluate(() => window.siteSettings.get()), 'settings again');
  await sleep(300);
  for (const scheme of ['light', 'dark']) { await settings.emulateMedia({ colorScheme: scheme }); await sleep(200); await settings.screenshot({ path: path.join(output, `site-settings-blocked-${scheme}.png`) }); }
  const edited = await settings.evaluate(async () => { await window.siteSettings.set('media:audio', 'ask'); return window.siteSettings.set('media:video', 'ask'); });
  check(edited.permissions.slice(0, 2).every(p => p.value === 'ask'), 'site settings edits the choice', edited.permissions.slice(0, 2));
  await settings.evaluate(() => { setTimeout(() => window.siteSettings.close(), 0); }).catch(() => {}); await sleep(300);
  await poll(async () => (await tab.evaluate(() => window.states())).camera === 'prompt', 'live prompt state');
  check(true, 'after the edit the page sees prompt again without a reload');
  // Allow, only if macOS already allows this app id (no real TCC prompt from a test).
  if (st0.system.microphone === 'granted' && st0.system.camera === 'granted') {
    await tab.click('#join');
    prompt = await findPage(/\/ui\/permissions\.html$/);
    await poll(async () => (await prompt.locator('button', { hasText: /^Allow$/ }).count()) > 0, 'allow button');
    await prompt.locator('button', { hasText: /^Allow$/ }).click();
    const gum = await poll(() => tab.evaluate(() => window.gum !== 'pending' && window.gum), 'gum allowed');
    check(gum === 'ok:audio+video', 'Allow: getUserMedia gets audio + video', gum);
    const devs = await tab.evaluate(() => window.devices());
    check(devs.length >= 2 && devs.every(d => d.label), 'Allow: enumerateDevices lists labelled devices', devs);
    summary.devices = devs;
    await tab.reload(); await tab.waitForLoadState('load');
    check((await tab.evaluate(() => window.states())).camera === 'granted', 'allow remembered across reload');
  } else {
    summary.allowSkipped = `macOS status for com.reframe.olive: ${JSON.stringify(st0.system)}; Allow would raise a real TCC prompt, skipped`;
    console.log('skip ', summary.allowSkipped);
  }
} catch (error) { failures.push({ message: error.message }); console.error(error); }
finally {
  try { await browser?.close(); } catch {}
  if (proc && proc.exitCode === null) { proc.kill('SIGTERM'); await Promise.race([new Promise(r => proc.once('exit', r)), sleep(8000)]); if (proc.exitCode === null) proc.kill('SIGKILL'); }
  server.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ app: appPath, checks, failures, summary }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`media perms packaged: ${checks} checks, ${failures.length} failures`, JSON.stringify(summary));
if (failures.length) process.exitCode = 1;
