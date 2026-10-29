// Native: setup survives the macOS Screen Recording "Quit & Reopen".
// Temp copy of Electron (own bundle id), own temp userData/profile, no CDP/API port.
// macOS stubs: screen status comes from a fixture file; System Settings, capture,
// media prompts and Keychain/import are trapped. Never touches an installed Olive.
// Run: node scripts/onboarding-resume-native-test.mjs
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-onboarding-resume-'));
const root = path.join(tmp, 'userData'); fs.mkdirSync(root);
const output = path.join(project, 'notes/test-shots/onboarding-resume');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cdp: false, agentApi: false }));
const screenFile = path.join(tmp, 'screen-status');
fs.writeFileSync(screenFile, 'denied');
const wrapper = path.join(tmp, 'fixture.cjs');
fs.writeFileSync(wrapper, `
const fs = require('fs');
const { app, systemPreferences, desktopCapturer, shell, dialog } = require('electron');
app.setPath('userData', ${JSON.stringify(root)});
global.fixtureCalls = [];
const media = { microphone:'granted', camera:'granted' };
systemPreferences.getMediaAccessStatus = kind => kind === 'screen' ? fs.readFileSync(${JSON.stringify(screenFile)}, 'utf8').trim() : media[kind] || 'not-determined';
systemPreferences.askForMediaAccess = async kind => { global.fixtureCalls.push('ask:' + kind); return false; };
desktopCapturer.getSources = async () => { global.fixtureCalls.push('getSources'); return []; };
shell.openExternal = async url => { global.fixtureCalls.push('open:' + url); };
app.relaunch = () => { throw new Error('fixture: relaunch is driven by the test'); };
dialog.showMessageBox = async () => { throw new Error('fixture: no dialogs'); };
app.on('before-quit', () => { try { fs.writeFileSync(${JSON.stringify(path.join(tmp, 'before-quit'))}, String(process.pid)); } catch {} });
const importerPath = require.resolve(${JSON.stringify(path.join(project, 'src/main/browser-import.js'))});
require.cache[importerPath] = { id:importerPath, filename:importerPath, loaded:true, exports:{
  discoverBrowsers: async () => [
    { id:'chrome', name:'Google Chrome', supported:true, profiles:[{ id:'chrome:Default', name:'Personal', supported:true }, { id:'chrome:Profile 1', name:'Work', supported:true }] },
    { id:'arc', name:'Arc', supported:true, profiles:[{ id:'arc:Default', name:'Personal', supported:true }] },
  ],
  importSelected: async () => { throw new Error('fixture: no real import'); },
} };
require(${JSON.stringify(path.join(project, 'src/main/main.js'))});
`);

const failures = []; let checks = 0, app;
const check = (ok, message, details) => { checks++; if (!ok) failures.push({ message, details }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && details !== undefined ? ': ' + JSON.stringify(details) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, tries = 200) { for (let n = 0; n < tries; n++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('Timed out: ' + label); }
const clone = path.join(tmp, 'Olive Resume Test.app');
execFileSync('/bin/cp', ['-cR', path.join(project, 'node_modules/electron/dist/Electron.app'), clone]);
for (const cmd of ['Set :CFBundleIdentifier com.reframe.olive.onboarding-resume-test', 'Set :CFBundleName Olive Resume Test']) execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, path.join(clone, 'Contents/Info.plist')]);
const executablePath = path.join(clone, 'Contents/MacOS/Electron');
async function launch() {
  const a = await _electron.launch({ executablePath, args: [wrapper], cwd: project, timeout: 30000,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'onboarding-resume', OLIVE_CDP: '0', OLIVE_API_PORT: '0' } });
  a.process().stderr.on('data', d => { const s = String(d); if (!/DevTools|Playwright/.test(s)) process.stderr.write('[fixture] ' + s); });
  await a.evaluate(async () => { while (!global.olive?.ready) await new Promise(r => setTimeout(r, 25)); });
  return a;
}
async function renderer(a, name) {
  return poll(async () => (await a.windows()).find(p => { try { return new URL(p.url()).pathname.endsWith(`/ui/${name}.html`); } catch { return false; } }), name);
}
async function shoot(page, chrome, label, appearance) {
  await app.evaluate(({ nativeTheme }, a) => { nativeTheme.themeSource = a; const w = global.olive.focusedWindow(); w.win.setSize(1280, 800); w.setSidebarWidth(252); w.layout(); }, appearance);
  await page.emulateMedia({ colorScheme: appearance }); await chrome.emulateMedia({ colorScheme: appearance });
  await sleep(300);
  check(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches) === (appearance === 'dark'), `${label}: appearance active`);
  await page.screenshot({ path: path.join(output, `${label}-page.png`) });
  await chrome.screenshot({ path: path.join(output, `${label}-chrome.png`) });
}
async function clickMenu(label) {
  return app.evaluate(({ Menu }, label) => {
    const items = Menu.getApplicationMenu().items[0].submenu.items;
    items.find(i => i.label === label).click(); return items.map(i => i.label);
  }, label);
}
const savedFile = async a => path.join(await a.evaluate(() => global.olive.dataPath), 'onboarding.json');
const readSaved = file => JSON.parse(fs.readFileSync(file, 'utf8'));
let file;
try {
  // 1. First launch: fresh profile, setup opens at welcome.
  app = await launch();
  let page = await renderer(app, 'onboarding');
  await page.locator('#welcome-title').waitFor();
  file = await savedFile(app);
  check(file.startsWith(tmp), 'profile data lives in the temp userData', file);
  // Real renderer clicks: welcome → (calls already granted, skipped) → import.
  await page.locator('#next').click();
  await page.locator('#import-title').waitFor({ state: 'visible' });
  check(readSaved(file).step === 'import', 'import step persisted on change (import now comes before screen)', readSaved(file));
  check(fs.existsSync(path.join(root, 'profiles.json')), 'profile registry persisted on first launch');
  // 2. Plain quit (Cmd-Q path: app.quit) mid-flow, then reopen: same step.
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await new Promise(r => app.process().once('exit', r));
  check(readSaved(file).paused !== true && readSaved(file).step === 'import', 'plain quit did not pause setup', readSaved(file));
  app = await launch();
  check(await app.evaluate(() => global.olive.profileInfo.isLegacy) === false, 'relaunched default profile is not mistaken for legacy data');
  page = await renderer(app, 'onboarding');
  await page.locator('#import-title').waitFor({ state: 'visible' });
  check(true, 'after a plain quit setup reappears at import');
  await page.locator('#sources input').first().waitFor();
  check(await page.locator('#steps').getAttribute('aria-label') === 'Step 3 of 5', 'import dots read Step 3 of 5');
  const chrome1 = await renderer(app, 'index');
  for (const appearance of ['light', 'dark']) await shoot(page, chrome1, `resumed-import-${appearance}`, appearance);
  await page.locator('#later').click(); // Skip import
  await page.locator('#screen-title').waitFor({ state: 'visible' });
  check(readSaved(file).step === 'screen', 'screen step persisted on change', readSaved(file));
  await page.locator('#next').click(); // "Continue": registers with macOS and opens System Settings
  await poll(async () => (await page.locator('#next').textContent()).includes('Quit and Reopen'), 'screen requested');
  const calls = await app.evaluate(() => global.fixtureCalls);
  check(calls.includes('getSources') && calls.some(c => /Privacy_ScreenCapture/.test(c)), 'screen step asked macOS and opened System Settings (stubbed)', calls);
  check(readSaved(file).screenRequested === true, 'screenRequested persisted');
  // 3. User turns Olive on in System Settings; macOS terminates the app (SIGTERM, like tcc's Quit & Reopen).
  fs.writeFileSync(screenFile, 'granted'); fs.rmSync(path.join(tmp, 'before-quit'), { force: true });
  const proc = app.process();
  const exited = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));
  process.kill(proc.pid, 'SIGTERM');
  const exit = await Promise.race([exited, sleep(15000).then(() => null)]);
  check(!!exit, 'app exited after SIGTERM', exit);
  check(fs.existsSync(path.join(tmp, 'before-quit')), 'SIGTERM went through before-quit (graceful quit path)');
  const afterKill = readSaved(file);
  check(afterKill.paused !== true && afterKill.completed === false && afterKill.step === 'screen', 'quit by macOS did not pause or complete setup', afterKill);
  app = null;
  // 4. macOS reopens Olive: setup reappears at the next step (done).
  app = await launch();
  page = await renderer(app, 'onboarding');
  await page.locator('#done-title').waitFor({ state: 'visible' });
  const resumed = await app.evaluate(() => ({ step: global.olive.onboarding.state().step, view: !!global.olive.onboarding.view, embedded: global.olive.onboarding.view === global.olive.focusedWindow()?.inlinePage }));
  check(resumed.step === 'done' && resumed.view && resumed.embedded, 'after the tcc relaunch setup reappears inline at the step after screen (done)', resumed);
  check(readSaved(file).step === 'done' && readSaved(file).paused !== true && readSaved(file).completed === false, 'resumed step persisted, not yet completed', readSaved(file));
  check(await page.locator('#steps').getAttribute('aria-label') === 'Step 5 of 5', 'done dots read Step 5 of 5');
  check((await page.locator('#summary-screen').textContent()) === 'Allowed', 'done summary shows screen sharing allowed');
  const chrome = await renderer(app, 'index');
  for (const appearance of ['light', 'dark']) await shoot(page, chrome, `resumed-done-${appearance}`, appearance);
  // 5. Mid-flow: close setup by hand (sidebar ×) → Set Up Olive… reopens it at the same step.
  await chrome.locator('#setup-row').hover(); await chrome.locator('#setup-close').click();
  await poll(async () => await app.evaluate(() => !global.olive.onboarding.view), 'sidebar close');
  check(readSaved(file).paused === true, 'closing setup by hand pauses it');
  await clickMenu('Set Up Olive…');
  page = await renderer(app, 'onboarding');
  await page.locator('#done-title').waitFor({ state: 'visible' });
  check(true, 'Set Up Olive… reopens paused setup mid-flow at its saved step');
  // 6. Finish setup; Set Up Olive… still opens it; Import from Browser… opens the import step directly.
  await page.locator('#done-title').waitFor({ state: 'visible' });
  await page.locator('#next').click(); // Start Browsing
  await poll(async () => await app.evaluate(() => !global.olive.onboarding.view), 'setup closed');
  check(readSaved(file).completed === true, 'finish marks completed');
  await clickMenu('Set Up Olive…');
  page = await renderer(app, 'onboarding');
  await page.locator('#welcome-title').waitFor({ state: 'visible' });
  check(readSaved(file).completed === true, 'Set Up Olive… opens setup after done without resetting completed', readSaved(file));
  await page.locator('#later').click(); // Set Up Later
  await poll(async () => await app.evaluate(() => !global.olive.onboarding.view), 'set up later');
  check(readSaved(file).completed === true && readSaved(file).paused !== true, 'closing a reopened finished setup keeps it done', readSaved(file));
  { const chrome = await renderer(app, 'index'); await new Promise(r => setTimeout(r, 300));
    check(await chrome.evaluate(() => { const r = document.querySelector('.setup-row, #setup-row'); return !r || r.hidden || getComputedStyle(r).display === 'none'; }), 'no setup sidebar row after done'); }
  const menu = await clickMenu('Import from Browser…');
  check(menu.indexOf('Import from Browser…') >= 0 && menu.indexOf('Import from Browser…') + 1 === menu.indexOf('Import from Arc…'), 'Olive menu has Import from Browser… next to Import from Arc…', menu);
  page = await renderer(app, 'onboarding');
  await page.locator('#import-title').waitFor({ state: 'visible' });
  await page.locator('#sources input').first().waitFor();
  check(readSaved(file).step === 'welcome', 'import panel does not move setup progress', readSaved(file));
  check(await page.locator('#steps').isHidden() && await page.locator('#back').isHidden() && (await page.locator('#later').textContent()) === 'Cancel', 'menu import is a standalone import panel (no dots/back, Cancel)');
  const chrome2 = await renderer(app, 'index');
  for (const appearance of ['light', 'dark']) await shoot(page, chrome2, `menu-import-${appearance}`, appearance);
  await page.locator('#later').click();
  await poll(async () => await app.evaluate(() => !global.olive.onboarding.view), 'import panel closed');
  check(readSaved(file).step === 'welcome' && readSaved(file).completed === true && readSaved(file).paused !== true, 'closing the import panel leaves setup state as it was', readSaved(file));
  check(!(await app.evaluate(() => global.fixtureCalls)).some(c => /^ask:/.test(c)), 'no macOS media prompt was requested');
} catch (error) { failures.push({ message: error.message, stack: error.stack }); console.error(error); }
finally {
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, failures, note: 'Own temp Electron copy (com.reframe.olive.onboarding-resume-test), temp userData, no CDP/API port. Kill = SIGTERM to the app pid, then a fresh launch on the same profile. Shots are WebContents captures (setup page + chrome).' }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`onboarding resume native: ${checks} checks, ${failures.length} failures; shots ${path.relative(project, output)}`);
if (failures.length) process.exitCode = 1;
