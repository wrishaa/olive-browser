// page dialogs (alert / confirm / prompt), natively: a disposable electron fixture (temp
// userData, own api port, cdp off, local fixture http servers), never the installed app or a
// real profile. pages call the dialogs from their own scripts; we answer through the popup's
// DOM with the keyboard and the mouse, and read what the page got back.
// with --shots it also writes notes/test-shots/page-dialogs/ (light + dark).
// run: node scripts/page-dialogs-native-test.mjs [--shots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'notes/test-shots/page-dialogs');
const wantShots = process.argv.includes('--shots');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-page-dialogs-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, n = 100) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout'); };

// two servers so an iframe can be cross-origin (127.0.0.1 vs localhost)
const page = (title, body = '') => `<!doctype html><title>${title}</title><body style="margin:0;background:#fff;font:15px -apple-system"><div style="padding:28px"><h2 style="margin:0 0 8px">Gateway · Agents</h2><p style="color:#555">Agents that can act on this workspace.</p><button id="b" style="font:inherit">Grant access…</button></div>${body}`;
const handler = (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/frame')) return res.end('<!doctype html><title>frame</title><body>frame');
  if (req.url.startsWith('/withframe')) return res.end(page('With frame', `<iframe id="f" src="${req.url.split('?f=')[1]}" style="width:300px;height:80px"></iframe>`));
  res.end(page(req.url.slice(1) || 'Fixture'));
};
const s1 = http.createServer(handler), s2 = http.createServer(handler);
await new Promise((r) => s1.listen(0, '127.0.0.1', r));
await new Promise((r) => s2.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${s1.address().port}`;
const other = `http://localhost:${s2.address().port}`;

let app, ui, dlg;
const W = (fn, arg) => app.evaluate(({ nativeTheme }, { src, arg }) => { const w = global.olive.focusedWindow() || global.olive.windows[0]; return (new Function('w', 'arg', 'nativeTheme', `return (${src})(w, arg, nativeTheme)`))(w, arg, nativeTheme); }, { src: fn.toString(), arg });
const list = () => app.evaluate(() => global.olive.pageDialogs.list());
const tabEval = (id, expr) => W((w, { id, expr }) => w.tabs.get(id).wc.executeJavaScript(expr), { id, expr });
// start a dialog from the page's own script (not from executeJavaScript, which would block on it)
const fire = (id, call) => tabEval(id, `window.__r = 'pending'; setTimeout(() => { try { const v = ${call}; window.__r = JSON.stringify(v === undefined ? '<undefined>' : v); } catch (e) { window.__r = 'threw ' + e.message; } }, 30); 1`);
const got = (id) => poll(async () => { const v = await tabEval(id, 'window.__r'); return v !== 'pending' && v; });
const waitShown = async (n = 1) => poll(async () => { const l = await list(); return l.filter((d) => d.shown).length === n && l; });
const dialogPage = async () => dlg || (dlg = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/page-dialog.html'))));
const ddom = async (fn, arg) => (await dialogPage()).evaluate(fn, arg);
const card = () => ddom(() => ({ hidden: document.querySelector('#card').hidden, title: document.querySelector('#title').textContent, message: document.querySelector('#message').textContent, field: document.querySelector('#field').hidden ? null : document.querySelector('#field').value, cancel: !document.querySelector('#cancel').hidden, block: !document.querySelector('#block').hidden, focus: document.activeElement?.id || document.activeElement?.tagName }));
const open = (u, opts = {}) => W(async (w, { u, opts }) => { const t = w.createTab({ url: u, index: 1e9, ...opts }); await new Promise((r) => { const wc = t.wc; if (!wc.isLoading()) return setTimeout(r, 50); wc.once('did-finish-load', () => setTimeout(r, 50)); }); return t.id; }, { u, opts });

try {
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'page-dialogs-fixture', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding?.close(); const w = global.olive.focusedWindow() || global.olive.windows[0]; w.win.setTitle('Olive page dialogs synthetic fixture'); for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true }); w.setOverlay(null); w.win.setSize(1280, 800); });
  ui = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/index.html')));

  const a = await open(`${base}/agents`, { activate: true });
  await W((w) => w.setOverlay(null));
  check((await tabEval(a, `typeof window.prompt === 'function' && window.prompt.name === 'prompt' && !String(window.prompt).includes('not supported')`)) === true, 'window.prompt is olive\'s, not electron\'s "prompt() is not supported." stub');

  // ---------- prompt: default value, typed text, enter ----------
  await fire(a, `prompt('Agent name for the new grant', 'deploy-bot')`);
  let l = await waitShown();
  check(l.length === 1 && l[0].kind === 'prompt' && l[0].tabId === a, 'a prompt from the active tab is shown', l);
  let c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  const host = new URL(base).host;
  check(c.title === `${host} says` && c.message === 'Agent name for the new grant' && c.field === 'deploy-bot' && c.cancel, 'the popup says "<host> says", the message, the default in the field, ok + cancel', c);
  check(c.focus === 'field' && (await ddom(() => document.querySelector('#field').selectionStart === 0 && document.querySelector('#field').selectionEnd === 10)), 'the field has focus with the default selected', c);
  check(await W((w) => w.mgr.pageDialogs.views.get(w.win).view.webContents.isFocused() || !w.win.isFocused()), 'keyboard focus is in the popup (when the window is key)');
  const d = await dialogPage();
  await d.keyboard.type('ops-agent');
  await d.keyboard.press('Enter');
  check((await got(a)) === '"ops-agent"', 'typing replaces the selection, enter = ok, prompt() returns the typed text', await tabEval(a, 'window.__r'));
  check((await list()).length === 0 && (await card()).hidden, 'the popup closes after the answer');
  check(await W((w) => !w.win.contentView.children.includes(w.mgr.pageDialogs.views.get(w.win).view)), 'the popup view leaves the window (nothing covers the page)');

  // ---------- prompt: esc = cancel -> null; ok untouched -> default; cancel click -> null ----------
  await fire(a, `prompt('Rename?', 'x')`); await waitShown();
  await (await dialogPage()).keyboard.press('Escape');
  check((await got(a)) === 'null', 'esc cancels a prompt: null');
  await fire(a, `prompt('Keep default?', 'keep me')`); await waitShown();
  await (await dialogPage()).click('#ok');
  check((await got(a)) === '"keep me"', 'clicking ok without typing returns the default');
  await fire(a, `prompt('No default')`); await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.field === '', 'prompt without a default shows an empty field', c);
  await (await dialogPage()).click('#cancel');
  check((await got(a)) === 'null', 'clicking cancel returns null');
  await fire(a, `prompt()`); await waitShown();
  await (await dialogPage()).keyboard.press('Enter');
  check((await got(a)) === '""', 'prompt() with no args, ok: empty string (like chrome)');

  // ---------- confirm ----------
  await fire(a, `confirm('Revoke access for deploy-bot?')`); await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.field === null && c.cancel && c.focus === 'ok' && c.message === 'Revoke access for deploy-bot?', 'confirm: no field, ok + cancel, ok focused', c);
  await (await dialogPage()).keyboard.press('Enter');
  check((await got(a)) === 'true', 'confirm, enter: true');
  await fire(a, `confirm('Again?')`); await waitShown();
  await (await dialogPage()).keyboard.press('Escape');
  check((await got(a)) === 'false', 'confirm, esc: false');
  await fire(a, `confirm('Click cancel')`); await waitShown();
  await (await dialogPage()).click('#cancel');
  check((await got(a)) === 'false', 'confirm, cancel click: false');

  // ---------- alert ----------
  await fire(a, `alert('Saved.')`); await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(!c.cancel && c.field === null && c.message === 'Saved.' && c.title === `${host} says`, 'alert: only ok, origin title, message', c);
  await (await dialogPage()).keyboard.press('Enter');
  check((await got(a)) === '"<undefined>"', 'alert, enter: returns undefined');
  await fire(a, `alert({ toString() { return 'objects are stringified' } })`); await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.message === 'objects are stringified', 'alert(obj) shows String(obj) like chrome', c);
  await (await dialogPage()).keyboard.press('Escape');
  check((await got(a)) === '"<undefined>"', 'alert, esc closes it too');

  // ---------- long message ----------
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: a long message from the page`).join('\n');
  await fire(a, `confirm(${JSON.stringify(long)})`); await waitShown();
  const m = await ddom(() => { const e = document.querySelector('#message'); const r = document.querySelector('#card').getBoundingClientRect(); return { scroll: e.scrollHeight > e.clientHeight, cardBottom: r.bottom, vh: innerHeight }; });
  check(m.scroll && m.cardBottom < m.vh, 'a long message scrolls inside the card, the card stays on screen', m);
  await (await dialogPage()).keyboard.press('Escape');
  await got(a);

  // ---------- cross-origin iframe ----------
  const fr = await open(`${base}/withframe?f=${other}/frame`, { activate: true });
  await pause(400);
  await W((w, id) => { const wc = w.tabs.get(id).wc; const f = wc.mainFrame.frames.find((x) => x.url.includes('/frame')); return f.executeJavaScript(`setTimeout(() => { alert('from the frame') }, 30); 1`); }, fr);
  await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.title === `An embedded page at ${new URL(other).host} says` && c.message === 'from the frame', 'a cross-origin iframe\'s alert says "An embedded page at <host> says"', c);
  await (await dialogPage()).keyboard.press('Enter');
  await poll(async () => (await list()).length === 0);

  // ---------- background tab: waits, never activates anything ----------
  const bg = await open(`${base}/background`, { activate: false });
  await W((w, id) => w.activate(id), fr);
  const activeBefore = await W((w) => w.activeId);
  await fire(bg, `confirm('From a background tab')`);
  await poll(async () => (await list()).length === 1);
  await pause(300);
  l = await list();
  check(l.length === 1 && !l[0].shown && (await W((w) => w.activeId)) === activeBefore && (await card()).hidden, 'a background tab\'s dialog waits: not shown, the active tab stays', l);
  await W((w, id) => w.activate(id), bg);
  await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.message === 'From a background tab', 'opening that tab shows its dialog', c);
  await W((w, id) => w.activate(id), fr);
  await poll(async () => (await card()).hidden);
  check((await list()).length === 1, 'switching away hides it again, still pending');
  await W((w, id) => w.activate(id), bg);
  await waitShown();
  await (await dialogPage()).click('#ok');
  check((await got(bg)) === 'true', 'and it answers normally when the user comes back');

  // ---------- typed draft survives a tab switch ----------
  await fire(bg, `prompt('Draft?', '')`); await waitShown();
  await (await dialogPage()).keyboard.type('half typed');
  await W((w, id) => w.activate(id), fr);
  await poll(async () => (await card()).hidden);
  await W((w, id) => w.activate(id), bg);
  await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.field === 'half typed', 'a half-typed prompt keeps its text across a tab switch', c);
  await (await dialogPage()).keyboard.press('Enter');
  check((await got(bg)) === '"half typed"', 'and returns it');

  // ---------- closing / navigating the tab answers with cancel ----------
  await fire(bg, `prompt('Closing tab', 'x')`); await waitShown();
  await W((w, id) => w.closeTab(id, { force: true }), bg);
  await poll(async () => (await list()).length === 0);
  check((await card()).hidden, 'closing a tab with an open prompt clears the popup');
  await fire(fr, `confirm('Navigate away')`); await waitShown();
  await W((w, { id, u }) => w.tabs.get(id).wc.loadURL(u), { id: fr, u: `${base}/after` });
  await poll(async () => (await list()).length === 0);
  check((await card()).hidden, 'navigating the tab away dismisses its dialog');

  // ---------- a page that keeps opening dialogs can be stopped ----------
  await W((w, id) => w.activate(id), a);
  // a fresh load resets the count: reload first so the numbers are clean
  await W(async (w, id) => { const wc = w.tabs.get(id).wc; wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); }, a);
  for (let i = 1; i <= 2; i++) {
    await fire(a, `alert('n${i}')`); await waitShown();
    c = await poll(async () => { const x = await card(); return !x.hidden && x; });
    if (i === 2) check(!c.block, 'the 2nd dialog of a page load has no "don\'t allow more" box', c);
    await (await dialogPage()).keyboard.press('Enter'); await got(a);
  }
  await fire(a, `confirm('n3')`); await waitShown();
  c = await poll(async () => { const x = await card(); return !x.hidden && x; });
  check(c.block, 'from the 3rd on it offers "Don\'t allow more dialogs from this page"', c);
  await (await dialogPage()).click('#block-box');
  await (await dialogPage()).click('#ok');
  check((await got(a)) === 'true', 'that confirm still answers true');
  const t0 = Date.now();
  await fire(a, `[confirm('blocked'), prompt('blocked', 'x'), alert('blocked')]`);
  check((await got(a)) === '[false,null,null]' && Date.now() - t0 < 3000 && (await list()).length === 0, 'after that the page\'s dialogs return at once (false, null, undefined), nothing shows', await tabEval(a, 'window.__r'));
  await W(async (w, id) => { const wc = w.tabs.get(id).wc; wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); }, a);
  await fire(a, `alert('after reload')`);
  await waitShown();
  check(true, 'a reload allows dialogs again');
  await (await dialogPage()).keyboard.press('Enter'); await got(a);

  // ---------- popup windows (oauth style) ----------
  const popupOk = await W(async (w, u) => {
    const wc = w.tabs.get(w.activeId).wc;
    const { BrowserWindow } = process.mainModule.require('electron');
    const made = new Promise((r) => wc.once('did-create-window', (bw) => r(bw)));
    await wc.executeJavaScript(`window.__pop = window.open(${JSON.stringify(u)}, 'pop', 'width=480,height=420'); 1`, true);
    const bw = await made; await new Promise((r) => bw.webContents.isLoading() ? bw.webContents.once('did-finish-load', r) : r());
    global.__testPopup = bw;
    await bw.webContents.executeJavaScript(`window.__r='pending'; setTimeout(() => { window.__r = JSON.stringify(prompt('Popup prompt', 'p')) }, 30); 1`);
    return bw instanceof BrowserWindow;
  }, `${base}/popup`);
  await poll(async () => (await list()).some((x) => x.shown && x.tabId === null));
  const popDlg = await poll(async () => { const ps = (await app.windows()).filter((p) => p.url().includes('/ui/page-dialog.html')); return ps.length === 2 && ps.find((p) => p !== dlg); });
  await popDlg.keyboard.press('Enter');
  const popR = await poll(async () => { const v = await app.evaluate(() => global.__testPopup.webContents.executeJavaScript('window.__r')); return v !== 'pending' && v; });
  check(popupOk && popR === '"p"', 'a window.open popup (oauth style) gets the popup too', popR);
  await app.evaluate(() => global.__testPopup.close());

  // ---------- shots ----------
  if (wantShots) {
    fs.mkdirSync(outDir, { recursive: true });
    const shot = async (name, call, prep) => {
      await fire(a, call); await waitShown(); await poll(async () => !(await card()).hidden);
      if (prep) await prep();
      await pause(350);
      const rect = await W((w, id) => w.panes.find((p) => p.id === id).page, a);
      const tabPng = await W(async (w, id) => (await w.tabs.get(id).wc.capturePage()).toPNG().toString('base64'), a);
      const dlgPng = (await (await dialogPage()).screenshot({ omitBackground: true })).toString('base64');
      await ui.evaluate(({ rect, tabPng, dlgPng }) => {
        const d = document.createElement('div'); d.id = '__shot';
        d.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:99999;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12)`;
        d.innerHTML = `<img src="data:image/png;base64,${tabPng}" style="position:absolute;inset:0;width:100%;height:100%"><img src="data:image/png;base64,${dlgPng}" style="position:absolute;inset:0;width:100%;height:100%">`;
        document.body.append(d);
      }, { rect, tabPng, dlgPng });
      await pause(200);
      await ui.screenshot({ path: path.join(outDir, name + '.png') });
      await ui.evaluate(() => document.getElementById('__shot')?.remove());
      await (await dialogPage()).keyboard.press('Escape'); await got(a);
    };
    await W(async (w, id) => { const wc = w.tabs.get(id).wc; wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); }, a);
    for (const theme of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
      // playwright pins pages it drives to light: follow the theme in the views we screenshot
      for (const p of [ui, await dialogPage()]) await p.emulateMedia({ colorScheme: theme });
      await pause(400);
      await W(async (w, id) => { const wc = w.tabs.get(id).wc; wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); }, a);
      await shot(`prompt-${theme}`, `prompt('Agent name for the new grant', 'deploy-bot')`);
      await shot(`confirm-${theme}`, `confirm('Revoke access for deploy-bot? It loses every grant on this workspace.')`);
      await shot(`alert-${theme}`, `alert('Saved.')`);
      await shot(`long-${theme}`, `confirm(${JSON.stringify(long)})`);
    }
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
    console.log('shots in ' + path.relative(repo, outDir));
  }
} catch (e) {
  check(false, 'fixture run threw', String(e?.stack || e));
} finally {
  await app?.close().catch(() => {});
  s1.close(); s2.close();
  fs.rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
