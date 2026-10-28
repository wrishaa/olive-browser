// agent api background work, natively: real electron, disposable profile, local
// fixture page, the fixture's own agent api on a random port. checks that agent
// calls never bring olive forward or change the selected tab, that hidden tabs
// can be screenshotted without waking, and that a step's full-speed rendering
// stops again afterwards. no real profile, installed app or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-agent-bg-native-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const check = (v, label, extra) => { assert.ok(v, label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); checks++; console.log('ok:', label, extra !== undefined ? JSON.stringify(extra) : ''); };
const frontApp = () => { try { return execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]).toString().split('=').pop().trim().replace(/"/g, ''); } catch { return '?'; } };

const PAGE = `<!doctype html><title>agent bg fixture</title><style>body{margin:0;font:40px system-ui}#c{display:block}</style>
<h1 id=h>agent background fixture</h1><canvas id=c width=600 height=300></canvas><script>
window.__c={raf:0,ticks:0,rl:[],tl:[]};const x=c.getContext('2d');const keep=(a)=>{a.push(Date.now());if(a.length>4000)a.splice(0,2000)};
(function f(t){__c.raf++;keep(__c.rl);x.fillStyle='hsl('+(t/10%360)+',70%,50%)';x.fillRect(0,0,600,300);x.fillStyle='#fff';x.fillText(String(__c.raf),20,150);requestAnimationFrame(f)})(0);
setInterval(()=>{__c.ticks++;keep(__c.tl)},10);
</script>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/page') ? PAGE : '<!doctype html><title>user tab</title><p>user tab</p>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, completed: true, step: 'done' }));

let app, front0;
const call = async (method, p, body, raw) => {
  const r = await fetch(info.api + p, { method, headers: { authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) };
};
let info, token;
try {
  // plain spawn, not playwright's electron launcher: playwright turns on focus
  // emulation for every page, which hides exactly the throttling we test.
  const frontBundle = execFileSync('lsappinfo', ['info', '-only', 'bundleid', execFileSync('lsappinfo', ['front']).toString().trim()]).toString().split('=').pop().trim().replace(/"/g, '');
  front0 = frontApp();
  app = spawn(path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), ['.', base + '/user'], { env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'agent-bg-fixture', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 300 && !fs.existsSync(path.join(root, 'agent.json')); i++) await wait(50);
  info = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
  token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();
  await wait(1500);
  // launching put the fixture in front: hand the foreground back to the user's app
  if (frontBundle && !/electron/i.test(frontBundle)) execFileSync('open', ['-b', frontBundle]);
  await wait(800);
  const winState = async () => { const w = (await call('GET', '/windows')).body[0]; return { activeId: w.activeTabId, front: frontApp() }; };
  // rates over the last `ms` before the read, after any previous step's linger
  // ran out. the read itself is an eval step, but only events before it count.
  const rates = async (id, ms = 2000) => {
    await wait(1700 + ms);
    const tc = Date.now();
    const r = (await call('POST', `/tabs/${id}/eval`, { expression: `(()=>{const n=(a)=>a.filter(t=>t>${tc - ms}&&t<=${tc}).length;return {raf:n(__c.rl),ticks:n(__c.tl),w:innerWidth}})()` })).body.result;
    return { raf: +(r.raf * 1000 / ms).toFixed(1), ticks: +(r.ticks * 1000 / ms).toFixed(1), w: r.w };
  };
  const tabsNow = (await call('GET', '/tabs')).body;
  const userTab = tabsNow.find((t) => t.url.endsWith('/user'))?.id;
  const s0 = await winState();
  console.log('start:', front0, s0);
  check(s0.front === front0 && !/electron|olive/i.test(s0.front) && s0.activeId === userTab, 'fixture running behind the user app, user tab selected', s0);

  // 1. open in the background
  const opened = await call('POST', '/tabs', { url: base + '/page' });
  const id = opened.body.id;
  let s = await winState();
  check(opened.status === 200 && opened.body.active === false && opened.body.visible === false, 'POST /tabs opens unselected', opened.body);
  check(s.activeId === userTab, 'active tab unchanged after open', s);
  check(frontApp() === front0, 'frontmost app unchanged after open', frontApp());

  // 2. idle hidden tab is throttled and sized
  const idle = await rates(id);
  check(idle.raf === 0 && idle.ticks <= 3, 'idle hidden tab throttled', idle);
  check(idle.w > 100, 'hidden agent tab has a real width', idle.w);

  // 3. an agent step runs at full speed
  const step = await call('POST', `/tabs/${id}/eval`, { expression: `new Promise(r=>{const a={...__c};setTimeout(()=>r({raf:__c.raf-a.raf,ticks:__c.ticks-a.ticks,vis:document.visibilityState,focus:document.hasFocus()}),1000)})` });
  // timers run at full speed. rAF needs begin-frames, which macOS stops while the
  // whole window is occluded (here: behind the user's app), selected tab or not.
  check(step.body.result.ticks >= 40 && step.body.result.vis === 'visible' && step.body.result.focus, 'eval step runs unthrottled (timers, visible, focused)', step.body.result);

  // 4. and re-throttles after the linger
  const after = await rates(id);
  check(after.raf === 0 && after.ticks <= 3, 'back to background throttling after the step', after);

  // 5. screenshot a hidden tab without waking it
  const shot = await call('GET', `/tabs/${id}/screenshot`, null, true);
  const png = shot.body;
  const w = png.length > 24 ? png.readUInt32BE(16) : 0, h = png.length > 24 ? png.readUInt32BE(20) : 0;
  check(shot.status === 200 && png.slice(1, 4).toString() === 'PNG' && w > 100 && h > 100, 'screenshot of hidden tab works', { status: shot.status, w, h, bytes: png.length });
  fs.writeFileSync('/tmp/olive-agent-bg-shot.png', png);
  const afterShot = await rates(id);
  check(afterShot.raf === 0 && afterShot.ticks <= 3, 'screenshot leaves the tab throttled', afterShot);

  // 6. raw cdp can't hang forever
  const t0 = Date.now();
  const cap = await call('POST', `/tabs/${id}/cdp`, { method: 'Page.captureScreenshot', params: { format: 'png' }, timeout: 4000 });
  const dt = Date.now() - t0;
  check((cap.status === 200 && cap.body.result?.data?.length > 100) || cap.status === 504, 'cdp captureScreenshot returns or times out', { status: cap.status, ms: dt, err: cap.body?.error });
  check(dt < 6000, '/cdp bounded by its timeout', dt);
  const afterCdp = await rates(id);
  check(afterCdp.raf === 0 && afterCdp.ticks <= 3, 'cdp step re-throttles too (session stays attached)', afterCdp);

  // 7. full frame rate is opt-in: frames:true for one step, or a /frames window
  const inStep = (frames) => call('POST', `/tabs/${id}/eval`, { frames, expression: `new Promise(r=>{const a={...__c};setTimeout(()=>r({raf:__c.raf-a.raf,ticks:__c.ticks-a.ticks}),1000)})` }).then((r) => r.body.result);
  const plainStep = await inStep(undefined);
  check(plainStep.raf <= 3 && plainStep.ticks >= 40, 'default step: timers full speed, rAF stays throttled (frames off)', plainStep);
  const framesStep = await inStep(true);
  check(framesStep.raf >= 40, 'frames:true step draws at full frame rate', framesStep);
  const afterFrames = await rates(id);
  check(afterFrames.raf === 0 && afterFrames.ticks <= 3, 'frames end with the step: back to background throttling', afterFrames);
  const win0 = await call('POST', `/tabs/${id}/frames`, { ms: 6000 });
  check(win0.status === 200 && win0.body.frames === true && !!win0.body.framesUntil, 'POST /frames opens a full-rate window', win0.body);
  const inWin = await rates(id);
  check(inWin.raf >= 40 && inWin.ticks >= 40, 'inside the frames window: full rate between steps', inWin);
  check((await call('GET', `/tabs/${id}`)).body.frames === true, 'GET /tabs shows frames on');
  await wait(2600);
  const afterWin = await rates(id);
  check(afterWin.raf === 0 && afterWin.ticks <= 3 && (await call('GET', `/tabs/${id}`)).body.frames === false, 'frames window ends by itself, throttled again', afterWin);
  check(frontApp() === front0, 'frontmost app unchanged after frames', frontApp());

  // 8. static page + the agent's own viewport (the hive screenshot scripts):
  //    cdp captureScreenshot must not hang, the override survives between steps
  const st = (await call('POST', '/tabs', { url: base + '/user?static' })).body.id;
  await call('POST', `/tabs/${st}/cdp`, { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1440, height: 810, deviceScaleFactor: 2, mobile: false } });
  await wait(2500); // past the linger
  const t1 = Date.now();
  const cap2 = await call('POST', `/tabs/${st}/cdp`, { method: 'Page.captureScreenshot', params: { format: 'png' }, timeout: 8000 });
  const png2 = cap2.body?.result?.data ? Buffer.from(cap2.body.result.data, 'base64') : Buffer.alloc(0);
  check(cap2.status === 200 && png2.length > 24 && png2.readUInt32BE(16) === 2880, 'static hidden page: cdp capture at the agent viewport returns', { status: cap2.status, ms: Date.now() - t1, w: png2.length > 24 ? png2.readUInt32BE(16) : 0 });
  await wait(2500);
  const vw = (await call('POST', `/tabs/${st}/eval`, { expression: 'innerWidth' })).body.result;
  check(vw === 1440, "agent's viewport kept between steps", vw);
  await call('POST', `/tabs/${st}/close`);

  // 9. activate selects inside the window only
  const act = await call('POST', `/tabs/${id}/activate`);
  s = await winState();
  check(act.status === 200 && s.activeId === id, 'activate selects the tab', s);
  check(s.front === front0, 'activate does not bring olive forward', s);
  const fg = await rates(id);
  console.log('foreground (selected, window visible) rates:', fg);
  await call('POST', `/tabs/${userTab}/activate`);
  s = await winState();
  check(s.activeId === userTab && s.front === front0, 'selected the user tab back, still behind', s);

  // 10. close own tab
  const closed = await call('POST', `/tabs/${id}/close`);
  check(closed.body?.ok === true, 'closed own tab');
  check(frontApp() === front0, 'frontmost app unchanged at the end', frontApp());
  console.log(`agent background native test: ${checks} checks passed`);
} finally {
  if (app && app.exitCode === null) {
    const exited = new Promise((r) => app.once('exit', r));
    try { app.kill('SIGTERM'); } catch {}
    await Promise.race([exited, wait(5000)]);
  }
  // helpers (gpu, network) can outlive a terminated main process: reap ours
  try { execFileSync('pkill', ['-9', '-f', root]); } catch {}
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
