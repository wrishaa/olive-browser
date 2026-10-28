// design mockups for toast-style page dialogs (notes/dialog-toasts-design.md). not a test:
// a disposable electron fixture (temp userData, cdp off, api port 0, local http server) renders a
// real olive window + a real permission card, then static html mockup cards are layered over the
// ui view and screenshotted, light + dark, into notes/test-shots/dialog-toasts/.
// run: node scripts/dialog-toasts-mockup.mjs [only-shot-name]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'notes/test-shots/dialog-toasts');
const only = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-dialog-toasts-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, n = 100) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout'); };

const pages = {
  agents: ['Gateway · Agents', `<h2 style="margin:0 0 6px">Agents</h2><p style="color:#666;margin:0 0 18px">Agents that can act on this workspace.</p>
    <table style="border-collapse:collapse;width:640px;font-size:14px">${['deploy-bot|deploy, read logs|2 days ago', 'triage-agent|issues, comments|5 hours ago', 'ops-agent|read only|just now'].map((r) => `<tr style="border-top:1px solid #eee">${r.split('|').map((c) => `<td style="padding:10px 8px">${c}</td>`).join('')}<td style="padding:10px 8px;color:#2a6"><u>Edit</u></td></tr>`).join('')}</table>
    <p style="margin-top:18px"><button style="font:inherit;padding:6px 12px">Grant access…</button></p>`],
  billing: ['Billing · Usage', '<h2>Usage</h2><p style="color:#666">This month: 1,284 runs.</p>'],
  docs: ['Docs · Grants API', '<h2>Grants API</h2><p style="color:#666">POST /v1/grants</p>'],
  status: ['Status', '<h2>All systems normal</h2>'],
};
const server = http.createServer((req, res) => {
  const [title, body] = pages[new URL(req.url, 'http://x').pathname.slice(1)] || ['Fixture', ''];
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${title}</title><body style="margin:0;background:#fff;color:#1f2321;font:15px -apple-system"><div style="padding:28px 32px">${body}</div>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// gateway.acme.io resolves to the fixture server, so url bar and card agree (no port shown)
const port = server.address().port;
const base = 'http://gateway.acme.io';

let app, ui;
const W = (fn, arg) => app.evaluate((_, { src, arg }) => { const w = global.olive.focusedWindow() || global.olive.windows[0]; return (new Function('w', 'arg', `return (${src})(w, arg)`))(w, arg); }, { src: fn.toString(), arg });
const open = (u, opts = {}) => W(async (w, { u, opts }) => { const t = w.createTab({ url: u, index: 1e9, ...opts }); await new Promise((r) => { const wc = t.wc; if (!wc || !wc.isLoading()) return setTimeout(r, 80); wc.once('did-finish-load', () => setTimeout(r, 80)); }); return t.id; }, { u, opts });

// the mockup layer: one shadow root over the whole ui view, so ui.css never leaks in
const CSS = fs.readFileSync(path.join(repo, 'notes/dialog-toasts-mockup.css'), 'utf8');

try {
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'dialog-toasts-fixture', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding?.close(); const w = global.olive.focusedWindow() || global.olive.windows[0]; for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true }); w.setOverlay(null); w.win.setSize(1280, 800); });
  // http://gateway.acme.io/* (not .dev: that tld is hsts-preloaded, so http never reaches the proxy) goes to the fixture server via a proxy on olive's session (url bar keeps gateway.acme.io)
  await app.evaluate(async (_, port) => { await global.olive.session.setProxy({ proxyRules: `http=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' }); }, port);
  ui = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/index.html')));
  const ids = {};
  for (const k of ['docs', 'billing', 'status']) ids[k] = await open(`${base}/${k}`);
  ids.agents = await open(`${base}/agents`, { activate: true });
  await W((w, id) => { w.activate(id); w.setOverlay(null); }, ids.agents);
  await pause(500);
  const titles = await W((w) => [...w.tabs.values()].map((t) => t.wc?.getTitle()));
  if (!titles.includes('Billing · Usage')) throw new Error('fixture pages did not load: ' + titles.join(', '));

  const realPermission = async (on) => {
    if (on) {
      await W((w, id) => w.tabs.get(id).wc.executeJavaScript('Notification.requestPermission(); 1', true), ids.agents);
      await poll(() => W((w) => !!w.mgr.permissions.views.get(w)?.ready && w.mgr.permissions.views.get(w).items.length));
      await pause(500);
      const p = await poll(async () => (await app.windows()).find((x) => x.url().includes('/ui/permissions.html')));
      return p;
    }
    await W((w) => { for (const p of [...w.mgr.permissions.pending.values()]) w.mgr.permissions.finish(p, false, false); });
    await pause(400);
  };

  const shot = async (name, theme, { html = '', badge = null, perm = null, veil = false }) => {
    const rect = await W((w, id) => w.panes.find((p) => p.id === id).page, ids.agents);
    const winB = await W((w) => w.win.getContentBounds());
    const tabPng = await W(async (w, id) => (await w.tabs.get(id).wc.capturePage()).toPNG().toString('base64'), ids.agents);
    let permPng = null, permB = null;
    if (perm) { permB = await W((w) => w.mgr.permissions.views.get(w).view.getBounds()); permPng = (await perm.screenshot({ omitBackground: true })).toString('base64'); }
    await ui.evaluate(({ rect, winB, tabPng, permPng, permB, html, CSS, badge, veil, theme }) => {
      const host = document.createElement('div'); host.id = '__shot';
      host.style.cssText = `position:fixed;inset:0;z-index:99999;pointer-events:none`;
      const sh = host.attachShadow({ mode: 'open' });
      const vars = `--px:${rect.x}px;--py:${rect.y}px;--pw:${rect.width}px;--ph:${rect.height}px;--ww:${winB.width}px;--wh:${winB.height}px`;
      sh.innerHTML = `<style>${CSS}</style><div class="root ${theme}" style="${vars}">
        <div class="pane"><img src="data:image/png;base64,${tabPng}">${veil ? '<div class="veil"></div>' : ''}</div>
        ${permPng && !html.includes('slot-perm') ? `<img class="perm" src="data:image/png;base64,${permPng}" style="left:${permB.x}px;top:${permB.y}px;width:${permB.width}px;height:${permB.height}px">` : ''}
        ${html.replace('<i class="slot-perm"></i>', permPng ? `<img class="perm-in" src="data:image/png;base64,${permPng}" style="width:${permB.width}px;height:${permB.height}px">` : '')}</div>`;
      document.body.append(host);
      document.querySelectorAll('.__badge').forEach((b) => b.remove());
      if (badge) for (const [title, text] of badge) {
        const row = [...document.querySelectorAll('.row[data-id]')].find((r) => r.querySelector('.title')?.textContent.trim() === title);
        if (!row) continue;
        const b = document.createElement('span'); b.className = '__badge'; b.textContent = text;
        const dark = theme === 'dark';
        b.style.cssText = text ? `flex:none;margin-left:6px;height:18px;min-width:18px;padding:0 6px;border-radius:9px;display:inline-grid;place-items:center;font:600 10.5px -apple-system;background:${dark ? '#a4d6b6' : '#245e40'};color:${dark ? '#14231a' : '#fff'}` : `flex:none;margin:0 4px 0 6px;width:8px;height:8px;border-radius:4px;background:${dark ? '#a4d6b6' : '#245e40'}`;
        row.querySelector('.title').after(b);
      }
    }, { rect, winB, tabPng, permPng, permB, html, CSS, badge, veil, theme });
    if (process.env.GEOM) console.log(JSON.stringify({ name, rect, winB, permB }));
    await pause(250);
    await ui.screenshot({ path: path.join(outDir, `${name}-${theme}.png`) });
    await ui.evaluate(() => { document.getElementById('__shot')?.remove(); document.querySelectorAll('.__badge').forEach((b) => b.remove()); });
  };

  const scenes = (await import(path.join(repo, 'notes/dialog-toasts-scenes.mjs') + '?' + Date.now())).default;
  fs.mkdirSync(outDir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
    await ui.emulateMedia({ colorScheme: theme });
    await pause(400);
    for (const [name, scene] of Object.entries(scenes)) {
      if (only && only !== name) continue;
      let perm = null;
      if (scene.perm) { perm = await realPermission(true); await perm.emulateMedia({ colorScheme: theme }); await pause(300); }
      await shot(name, theme, { ...scene, perm });
      if (scene.perm) await realPermission(false);
    }
  }
  console.log('shots in ' + path.relative(repo, outDir) + ': ' + fs.readdirSync(outDir).join(' '));
} finally {
  try { await app?.close(); } catch {}
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
