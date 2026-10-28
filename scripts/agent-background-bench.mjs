// before/after cpu bench on a disposable olive fixture (spawned electron, temp profile).
// usage: DUR=30 node scripts/agent-background-bench.mjs <repoDir> <label> fg,hidden,loop,after,oldrecipe,oldafter
// (repoDir can be a worktree of another commit for a before/after comparison)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const [repo, label, modesArg] = process.argv.slice(2);
const DUR = Number(process.env.DUR || 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `<!doctype html><title>bench</title><canvas id=c width=600 height=300></canvas><script>
window.__c={rl:[],tl:[]};const x=c.getContext('2d');const keep=(a)=>{a.push(Date.now());if(a.length>20000)a.splice(0,10000)};
(function f(t){keep(__c.rl);x.fillStyle='hsl('+(t/10%360)+',70%,50%)';x.fillRect(0,0,600,300);requestAnimationFrame(f)})(0);
setInterval(()=>keep(__c.tl),16);</script>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/page') ? PAGE : '<p>user tab</p>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-agent-bg-bench-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, completed: true, step: 'done' }));
const front = () => execFileSync('lsappinfo', ['info', '-only', 'bundleid', execFileSync('lsappinfo', ['front']).toString().trim()]).toString().split('=').pop().trim().replace(/"/g, '');
const fb = front();
const renderers = () => execFileSync('ps', ['-axo', 'pid,args']).toString().split('\n').filter((l) => l.includes(root) && l.includes('--type=renderer')).map((l) => Number(l.trim().split(' ')[0]));
const gpuPid = () => execFileSync('ps', ['-axo', 'pid,args']).toString().split('\n').filter((l) => l.includes(root) && l.includes('--type=gpu-process')).map((l) => Number(l.trim().split(' ')[0]))[0];
const app = spawn(path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), ['.', `http://localhost:${port}/user`], { cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'agent-bg-bench', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, stdio: 'ignore' });
let out = [];
try {
  for (let i = 0; i < 300 && !fs.existsSync(path.join(root, 'agent.json')); i++) await wait(50);
  const info = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
  const token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();
  await wait(1500);
  if (!/electron/i.test(fb)) execFileSync('open', ['-b', fb]);
  const call = async (method, p, body, raw) => { const r = await fetch(info.api + p, { method, headers: { authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined }); return raw ? Buffer.from(await r.arrayBuffer()) : r.json().catch(() => null); };
  const userTab = (await call('GET', '/windows'))[0].activeTabId;
  const before = new Set(renderers());
  const id = (await call('POST', '/tabs', { url: `http://127.0.0.1:${port}/page`, background: true })).id;
  await wait(1000);
  const ren = renderers().filter((p) => !before.has(p)).pop();
  const gpu = gpuPid();
  console.log(label, 'tab', id, 'renderer', ren, 'gpu', gpu, 'front', front());
  const top = (secs) => new Promise((resolve) => {
    const all = renderers();
    const p = spawn('top', ['-l', String(secs + 1), '-s', '1', '-stats', 'pid,cpu', ...all.flatMap((x) => ['-pid', String(x)]), '-pid', String(gpu)]);
    let s = ''; p.stdout.on('data', (d) => (s += d));
    p.on('close', () => {
      const rs = [], gs = []; let block = 0, cur = 0;
      for (const line of s.split('\n')) {
        if (line.startsWith('PID')) { if (block > 1) rs.push(cur); block++; cur = 0; continue; }
        const f = line.trim().split(/\s+/); const pid = Number((f[0] || '').replace('*', ''));
        if (block > 1 && pid === gpu) gs.push(Number(f[1]));
        else if (block > 1 && all.includes(pid)) cur += Number(f[1]);
      }
      if (block > 1) rs.push(cur);
      const avg = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
      resolve({ ren: avg(rs), gpu: avg(gs), nren: all.length });
    });
  });
  const pageRates = async (t0, t1) => { const r = (await call('POST', `/tabs/${id}/eval`, { expression: `(()=>{const n=(a)=>a.filter(t=>t>${t0}&&t<=${t1}).length;return [n(__c.rl),n(__c.tl)]})()` })).result; const s = (t1 - t0) / 1000; return { raf: +(r[0] / s).toFixed(1), timer: +(r[1] / s).toFixed(1) }; };
  let agentLoop = null;
  const startLoop = () => { let on = true; const run = (async () => { while (on) { await call('POST', `/tabs/${id}/eval`, { expression: 'document.title' }); const png = await call('GET', `/tabs/${id}/screenshot`, null, true); agentLoop.shots.push(png.length); for (let i = 0; i < 30 && on; i++) await wait(100); } })(); agentLoop = { shots: [], stop: async () => { on = false; await run; } }; };
  for (const mode of modesArg.split(',')) {
    // modes: fg (tab selected), hidden (plain idle), loop (agent eval+screenshot every 3s), after (idle after a loop),
    // oldrecipe (persistent /cdp size+focus emulation then loop; old workaround), oldafter (idle after it)
    if (mode === 'fg') await call('POST', `/tabs/${id}/activate`);
    if (mode === 'oldrecipe') { await call('POST', `/tabs/${id}/cdp`, { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1100, height: 800, deviceScaleFactor: 0, mobile: false } }); await call('POST', `/tabs/${id}/cdp`, { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }); }
    if (mode === 'loop' || mode === 'oldrecipe') startLoop();
    if (mode === 'after' || mode === 'oldafter' || mode === 'hidden') await wait(2500);
    const t0 = Date.now();
    const cpu = await top(DUR);
    const t1 = Date.now();
    let shots = null;
    if (agentLoop) { await agentLoop.stop(); shots = agentLoop.shots; agentLoop = null; }
    const r = await pageRates(t0, t1);
    if (mode === 'fg') await call('POST', `/tabs/${userTab}/activate`);
    const row = { label, mode, ...cpu, ...r, shots: shots ? `${shots.length} (${shots.filter((b) => b > 1000).length} ok)` : '' };
    console.log(JSON.stringify(row)); out.push(row);
  }
  await call('POST', `/tabs/${id}/close`);
  console.log('front at end', front());
} finally {
  try { app.kill('SIGTERM'); } catch {}
  await wait(2000);
  try { execFileSync('pkill', ['-9', '-f', root]); } catch {}
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
