import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
// Disposable Electron fixture only (temp OLIVE_USER_DATA_DIR, ports 0, local page server);
// never attaches to installed Olive.
// Run: node scripts/popup-zoom-native-test.mjs [--shot]
// popup windows (window.open with features): double-clicking the thin border fills the
// workArea, double-clicking it again restores the exact saved frame. single clicks, drags and
// double-clicks inside the page stay the page's; nothing is added to the window.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = path.join(repo, 'notes/test-shots/olive-tab-scenarios/fixed');
const wantShot = process.argv.includes('--shot');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-popup-zoom-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const POP = `<!doctype html><title>popup zoom fixture</title><style>html,body{margin:0;height:100%;background:#f4c6d4;font:16px system-ui}main{padding:40px}</style>
<body><main><h1>synthetic popup</h1><p>a google-doc-like popup window for the border double-click test.</p></main>
<script>window.log=[];for(const t of ['mousedown','mouseup','click','dblclick'])addEventListener(t,e=>log.push(t+':'+e.clientX+','+e.clientY+':'+e.detail),true);</script></body>`;
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url.startsWith('/popup') ? POP : '<title>opener</title><p>opener</p>'); });
let app;
const same = (a, b) => ['x', 'y', 'width', 'height'].every((k) => a[k] === b[k]);
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'popup-zoom-regression', OLIVE_CDP: '1', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  await app.evaluate(async ({ BrowserWindow }, base) => {
    while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50));
    global.olive.onboarding.close();
    const w = global.olive.focusedWindow();
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    const t = w.createTab({ url: base + '/opener', activate: true });
    await new Promise((r) => t.view.webContents.once('did-finish-load', r));
    global.__opener = t.view.webContents;
    await t.view.webContents.executeJavaScript(`window.__pop=window.open('${base}/popup','zoomfixture','popup,width=520,height=420,left=240,top=220');1`, true);
    for (let i = 0; i < 100 && !global.__pop; i++) {
      global.__pop = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().startsWith(base + '/popup'));
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => (global.__pop.webContents.isLoading() ? global.__pop.webContents.once('did-finish-load', r) : r()));
    global.__pop.setTitle('popup zoom fixture');
  }, base);
  const popup = await (async () => { for (let i = 0; i < 100; i++) { const p = (await app.windows()).find((x) => x.url().startsWith(base + '/popup')); if (p) return p; await pause(50); } throw new Error('popup page not found'); })();
  const st = () => app.evaluate(async ({ screen }) => {
    const p = global.__pop;
    return { bounds: p.getBounds(), content: p.getContentSize(), work: screen.getDisplayMatching(p.getBounds()).workArea, log: await p.webContents.executeJavaScript('log.splice(0)'), children: p.contentView.children.length, resizable: p.isResizable(), movable: p.isMovable() };
  });
  const settle = async () => { let last; for (let i = 0; i < 40; i++) { const b = await app.evaluate(() => global.__pop.getBounds()); if (last && same(last, b)) return; last = b; await pause(60); } };
  const dbl = async (x, y) => { await popup.mouse.move(x, y); await popup.mouse.dblclick(x, y); await pause(150); await settle(); return st(); };
  let s = await st();
  const start = s.bounds;
  check(s.children === 0 && s.resizable && s.movable, 'popup keeps its plain frame (no extra views, resizable, movable)', s);
  const [cw, ch] = s.content;
  const edges = { top: [Math.round(cw / 2), 1], bottom: [Math.round(cw / 2), ch - 2], left: [1, Math.round(ch / 2)], right: [cw - 2, Math.round(ch / 2)] };

  // 1. top border: zoom to workArea, then back to the exact saved frame
  s = await dbl(...edges.top);
  check(same(s.bounds, s.work), 'dblclick top border fills the workArea', { bounds: s.bounds, work: s.work });
  check(!s.log.some((l) => l.startsWith('dblclick')), 'border dblclick does not reach the page as a dblclick', s.log);
  if (wantShot) {
    fs.mkdirSync(shotDir, { recursive: true });
    const img = await app.evaluate(async () => (await global.__pop.webContents.capturePage()).resize({ width: 1440 }).toPNG().toString('base64'));
    const file = path.join(shotDir, 'popup-dblclick-zoom-1440.png');
    fs.writeFileSync(file, Buffer.from(img, 'base64'));
    console.log('shot ' + file + ' ' + execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', file]).toString().split('\n')[1].trim());
  }
  const [zw, zh] = s.content;
  s = await dbl(Math.round(zw / 2), 1);
  check(same(s.bounds, start), 'second dblclick on the top border restores the exact saved frame', { bounds: s.bounds, start });

  // 2. every other edge toggles the same way
  for (const edge of ['bottom', 'left', 'right']) {
    s = await dbl(...edges[edge]);
    const zoomed = same(s.bounds, s.work);
    const [w2, h2] = s.content;
    const back = { top: [Math.round(w2 / 2), 1], bottom: [Math.round(w2 / 2), h2 - 2], left: [1, Math.round(h2 / 2)], right: [w2 - 2, Math.round(h2 / 2)] }[edge];
    s = await dbl(...back);
    check(zoomed && same(s.bounds, start), `dblclick ${edge} border zooms and restores`, { zoomed, bounds: s.bounds, start });
  }

  // 3. a dblclick inside the page is the page's
  s = await dbl(Math.round(cw / 2), Math.round(ch / 2));
  check(same(s.bounds, start) && s.log.some((l) => l.startsWith('dblclick:')), 'dblclick inside page content is ignored (page gets its dblclick)', s);
  s = await dbl(10, 10);
  check(same(s.bounds, start) && s.log.some((l) => l.startsWith('dblclick:')), 'dblclick just inside the border band is the page\'s', s);

  // 4. single click and click-drag at the border stay the page's, no zoom
  await popup.mouse.click(...edges.top); await pause(150); s = await st();
  check(same(s.bounds, start) && s.log.some((l) => l.startsWith('mousedown:')) && s.log.some((l) => l.startsWith('click:')), 'single click on the border reaches the page, no zoom', s);
  await popup.mouse.move(...edges.left); await popup.mouse.down(); await popup.mouse.move(80, 120, { steps: 6 }); await popup.mouse.up(); await pause(150); s = await st();
  check(same(s.bounds, start) && s.log.filter((l) => /^mouse(down|up)/.test(l)).length === 2, 'click-drag from the border is unchanged (page gets down/up, no zoom)', s);

  // 5. window move / resize between: the next dblclick zooms from the new frame and restores it
  const moved = { x: start.x + 37, y: start.y + 23, width: start.width - 40, height: start.height + 30 };
  await app.evaluate((_, b) => global.__pop.setBounds(b), moved); await settle();
  s = await st(); const movedReal = s.bounds; const [mw] = s.content;
  s = await dbl(Math.round(mw / 2), 1);
  const z = same(s.bounds, s.work);
  await app.evaluate(() => global.__pop.setBounds({ ...global.__pop.getBounds(), width: global.__pop.getBounds().width - 300 })); await settle();
  s = await st(); const userResized = s.bounds;
  s = await dbl(Math.round(s.content[0] / 2), 1);
  check(z && same(s.bounds, s.work), 'resized while zoomed: dblclick zooms again instead of jumping back', { z, bounds: s.bounds, userResized });
  s = await dbl(Math.round(s.content[0] / 2), 1);
  check(same(s.bounds, userResized), 'and restores the frame the user left it at', { bounds: s.bounds, userResized, movedReal });

  // 6. the olive window itself is not affected (it has its own chrome)
  const main = await app.evaluate(() => { const w = global.olive.focusedWindow() || global.olive.windows[0]; return { isBrowserWindow: w.win.constructor.name, bounds: w.win.getBounds() }; });
  check(main.isBrowserWindow !== 'BrowserWindow', 'olive windows are BaseWindows, not wired', main);
} catch (error) { results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) }); console.error(error); }
finally {
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
