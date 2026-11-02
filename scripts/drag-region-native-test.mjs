// stale page drag regions, natively: disposable electron fixtures (temp userData, api port 0,
// cdp off, local fixture servers), never the installed app or a real profile.
//
// electron keeps the last draggable region a page reported and never clears it on navigation;
// a later document without app-region css reports nothing, so the old region keeps turning
// mouse-downs over the new page into window drags (dead clicks, the page drags the window).
// we read electron's own region log (ELECTRON_DEBUG_DRAGGABLE_REGIONS, unpackaged only) and
// check the region each tab is left with after each step. no mouse input is sent.
// each scenario gets its own fixture, quit (and killed) and deleted right after, with one tab\n// each: with ELECTRON_DEBUG_DRAGGABLE_REGIONS set, opening a second tab view in the same\n// fixture spins electron's main thread (the debug overlay, not olive: plain runs are fine).
// run: node scripts/drag-region-native-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, pause(ms).then(() => { throw new Error('timeout: ' + what); })]);

// two servers so the password post can be cross-site (127.0.0.1 vs localhost: new process)
let otherBase = '';
const handler = (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const u = new URL(req.url, 'http://x');
  const form = `<form id="f" method="post" action="${u.searchParams.get('to') || ''}"><input name="pw" value="x"></form>`;
  if (u.pathname === '/drag') return res.end(`<!doctype html><title>splash</title><body style="margin:0"><div style="position:fixed;inset:0;-webkit-app-region:drag;background:#eef">splash: the whole page is a drag region</div>${form}`);
  if (u.pathname === '/titlebar') return res.end(`<!doctype html><title>app shell</title><body style="margin:0"><header style="height:48px;-webkit-app-region:drag;background:#ddd">shell title bar</header><main style="padding:20px">app</main>${form}`);
  if (u.pathname === '/shadow') return res.end(`<!doctype html><title>shadow</title><body style="margin:0"><div id="h"></div><script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML='<div style="position:fixed;inset:0;-webkit-app-region:drag">shadow drag</div>'</script>`);
  if (u.pathname === '/plain') return res.end(`<!doctype html><title>Let's keep your account secure</title><body style="margin:0;padding:40px;font:16px -apple-system"><h2>Let's keep your account secure</h2><button id="next">Next</button>`);
  res.end('ok');
};
const s1 = http.createServer(handler), s2 = http.createServer(handler);
await new Promise((r) => s1.listen(0, '127.0.0.1', r));
await new Promise((r) => s2.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${s1.address().port}`;
otherBase = `http://localhost:${s2.address().port}`;

const live = new Set(); // fixture processes still running, killed on any exit
process.on('exit', () => { for (const p of live) try { p.kill('SIGKILL'); } catch {} });

// one fixture: launch, hand helpers to fn, always quit + kill + delete its profile
async function scenario(name, fn) {
  console.log('# ' + name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-drag-region-fixture-'));
  fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
  const updates = [];
  const grab = (b) => {
    // "[draggable-regions] webContents 3: update #2 ...: renderer sent 1 region(s) (1 drag, 0 no-drag); ... bounds 0,0 1020x784"
    for (const l of String(b).split('\n')) {
      const m = l.match(/\[draggable-regions\] webContents (\d+): update #(\d+).*renderer sent (\d+) region\(s\) \((\d+) drag, (\d+) no-drag\).*bounds (-?\d+),(-?\d+) (\d+)x(\d+)/);
      if (m) updates.push({ wc: +m[1], n: +m[2], drag: +m[4], noDrag: +m[5], w: +m[8], h: +m[9] });
    }
  };
  let app, proc;
  try {
    app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, timeout: 30000, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'drag-region-fixture', OLIVE_CDP: '0', OLIVE_API_PORT: '0', ELECTRON_DEBUG_DRAGGABLE_REGIONS: '1', ELECTRON_ENABLE_LOGGING: '1' } });
    proc = app.process(); live.add(proc);
    proc.stderr.on('data', grab); proc.stdout.on('data', grab);
    const W = (f, arg) => within(app.evaluate((_e, { src, arg }) => { const w = global.olive.focusedWindow() || global.olive.windows[0]; return (new Function('w', 'arg', `return (${src})(w, arg)`))(w, arg); }, { src: f.toString(), arg }), 15000, 'main eval');
    await within(app.evaluate(async () => { while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding?.close(); const w = global.olive.focusedWindow() || global.olive.windows[0]; w.win.setTitle('Olive drag region synthetic fixture'); for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true }); w.setOverlay(null); w.win.setSize(1280, 800); }), 20000, 'ready');
    const open = async (u) => {
      const t = await W((w, u) => { const t = w.createTab({ url: u, activate: true, index: 1e9 }); return { id: t.id, wc: t.wc.id }; }, u);
      for (let i = 0; i < 150; i++) { if (await W((w, id) => { const wc = w.tabs.get(id)?.wc; return !!wc && !wc.isLoading() && wc.getURL() !== ''; }, t.id)) break; await pause(100); }
      await pause(1500);
      return t;
    };
    const post = async (id) => {
      const r = await W(async (w, id) => { const wc = w.tabs.get(id).wc; const pid = wc.getOSProcessId(); const p = new Promise((r) => wc.once('did-finish-load', r)); wc.executeJavaScript('document.getElementById("f").submit(); 0').catch(() => {}); await p; return { url: wc.getURL(), swapped: wc.getOSProcessId() !== pid }; }, id);
      await pause(1500);
      return r;
    };
    const region = (wcId) => { const u = updates.filter((x) => x.wc === wcId).at(-1); return u ? { ...u, empty: u.w === 0 || u.h === 0 } : null; };
    await fn({ open, post, region, W });
  } catch (e) {
    check(false, `${name}: fixture error`, String(e && e.stack || e));
  } finally {
    await Promise.race([app?.close().catch(() => {}), pause(4000)]);
    try { proc?.kill('SIGKILL'); } catch {}
    live.delete(proc);
    await pause(300);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log("cleanup: " + e.message); }
  }
}

await scenario('full-page drag splash, then a cross-site password post', async ({ open, post, region }) => {
  const t = await open(`${base}/drag?to=${encodeURIComponent(otherBase + '/plain')}`);
  check(region(t.wc)?.empty, 'a page\'s own drag region never reaches the window (splash)', region(t.wc));
  const nav = await post(t.id);
  check(nav.url.startsWith(otherBase) && nav.swapped, 'the post went cross-site into a new renderer process', nav);
  check(region(t.wc)?.empty, 'after the cross-site post the tab has no drag region left (clicks reach the page)', region(t.wc));
});

await scenario('title-bar app shell, then a same-origin post', async ({ open, post, region }) => {
  const t = await open(`${base}/titlebar?to=${encodeURIComponent('/plain')}`);
  check(region(t.wc)?.empty, 'an app shell title bar does not drag the olive window', region(t.wc));
  await post(t.id);
  check(region(t.wc)?.empty, 'after a same-origin post the tab has no drag region left', region(t.wc));
});

await scenario('drag region inside a shadow root', async ({ open, region }) => {
  const s = await open(`${base}/shadow`);
  check(region(s.wc)?.empty, 'a drag region inside a shadow root is off too', region(s.wc));
});

await scenario('plain page and the olive sidebar', async ({ open, region, W }) => {
  const t = await open(`${base}/plain`);
  const p = region(t.wc);
  check(p && p.drag === 0 && p.empty, 'a plain page reports an empty region (so it replaces stale ones)', p);
  const u = region(await W((w) => w.ui.webContents.id));
  check(u && u.drag > 0 && !u.empty, 'olive\'s own sidebar drag regions are untouched', u);
});

s1.close(); s2.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
