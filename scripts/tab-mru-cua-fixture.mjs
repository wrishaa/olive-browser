import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
// Disposable Olive fixture for real-key ctrl+tab checks driven from outside (Computer
// Use / cua pressKey into this Electron.app): 4 coloured tabs in a 1440-wide window,
// temp profile, ports 0. It never touches the installed app or a real profile.
// Commands are lines appended to <dir>/cmd: snap | arm | trace | ctrlup | label <text> | quit;
// each answer is one JSON line appended to <dir>/out.
// Run: node scripts/tab-mru-cua-fixture.mjs <dir>
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'olive-mru-cua-')));
fs.mkdirSync(dir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-mru-cua-profile-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const cmdFile = path.join(dir, 'cmd'), outFile = path.join(dir, 'out');
fs.writeFileSync(cmdFile, ''); fs.writeFileSync(outFile, '');
const out = o => fs.appendFileSync(outFile, JSON.stringify(o) + '\n');
const app = await _electron.launch({
  executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(repo, 'src/main/main.js')], cwd: repo,
  env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'mru-cua', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' },
  timeout: 30000,
});
const ev = (fn, arg) => app.evaluate(fn, arg);
const snap = () => ev(async () => {
  const w = global.olive.focusedWindow();
  const esc = {};
  for (const t of w.tabs.values()) esc[t.title] = await t.wc?.executeJavaScript('window.__esc ?? null').catch(() => null);
  const title = id => w.tabs.get(id)?.title;
  return { active: title(w.activeId), order: w.tabMRU.order.map(title), walk: w.tabMRU.walk && w.tabMRU.walk.map(title), escSeenByPages: esc, focused: w.win.isFocused() };
});
await ev(async () => {
  while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
  global.olive.onboarding?.close?.();
  const w = global.olive.focusedWindow();
  w.win.setBounds({ x: 0, y: 30, width: 1440, height: 900 });
  for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
  const colors = ['#2d6a4f', '#1d3557', '#9d0208', '#7b2cbf'];
  for (let i = 0; i < 4; i++) {
    const html = `<title>tab ${i + 1}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${colors[i]};color:white;font:600 64px -apple-system;text-align:center"><div>tab ${i + 1}<div id=s style="font-size:22px;opacity:.9;margin-top:16px"></div></div></body>`;
    w.createTab({ url: 'data:text/html,' + encodeURIComponent(html), activate: true });
  }
  await new Promise(r => setTimeout(r, 600));
});
out({ ready: true, pid: app.process().pid, exe: path.join(repo, 'node_modules/electron/dist/Electron.app'), state: await snap() });
let seen = 0, done = false;
while (!done) {
  await new Promise(r => setTimeout(r, 150));
  const lines = fs.readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(seen)) {
    seen++;
    const [c, ...rest] = line.split(' '); const arg = rest.join(' ');
    try {
      if (c === 'snap') out({ c, state: await snap() });
      else if (c === 'arm') { await ev(async () => { for (const t of global.olive.focusedWindow().tabs.values()) { if (!t.wc) global.olive.focusedWindow().ensureView(t); } await new Promise(r => setTimeout(r, 300)); for (const t of global.olive.focusedWindow().tabs.values()) await t.wc?.executeJavaScript("if(window.__esc==null){window.__esc=0;addEventListener('keydown',e=>{if(e.key==='Escape')window.__esc++},true)}0").catch(() => {}); }); out({ c, state: await snap() }); }
      else if (c === 'label') { await ev((_, t) => { const w = global.olive.focusedWindow(); return w.tabs.get(w.activeId).wc.executeJavaScript(`document.getElementById('s').textContent=${JSON.stringify(t)};0`); }, arg); out({ c }); }
      else if (c === 'trace') { out({ c, trace: await ev(() => { const w = global.olive.focusedWindow(); const t = global.__mruTrace || []; global.__mruTrace = []; if (!global.__mruTraced) { global.__mruTraced = true; for (const wc of [w.ui.webContents, ...[...w.tabs.values()].map(t => t.wc).filter(Boolean)]) wc.on('before-input-event', (_e, i) => (global.__mruTrace ||= []).push(`${wc === w.ui.webContents ? 'ui' : w.tabs.get([...w.tabs.keys()].find(k => w.tabs.get(k).wc === wc))?.title} ${i.type} ${i.key} ctrl=${i.control}`)); } return t; }) }); }
      // cua can't post a bare modifier release (no flagsChanged): the release that
      // commits a walk is a Control keyUp into the keyboard owner (the active page)
      else if (c === 'ctrlup') { await ev(() => { const w = global.olive.focusedWindow(); const wc = w.overlay === 'palette' ? w.ui.webContents : w.tabs.get(w.activeId).wc; wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control', modifiers: [] }); }); await new Promise(r => setTimeout(r, 200)); out({ c, state: await snap() }); }
      else if (c === 'quit') done = true;
    } catch (e) { out({ c, error: String(e) }); }
  }
}
await app.close().catch(() => {});
fs.rmSync(root, { recursive: true, force: true });
