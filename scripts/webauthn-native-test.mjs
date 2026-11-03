import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
// passkeys in a disposable Electron fixture (never attaches to installed Olive, no network):
// a localhost page (secure context, rpId localhost) and CDP virtual authenticators standing in
// for touch id ('internal') and a security key ('usb').
//  1. a request no authenticator answers ends with NotAllowedError at its timeout and frees the
//     slot (electron alone: pending forever, then "A request is already pending")
//  2. register + login with a security key
//  3. two passkeys for one site + get() without allowCredentials: olive's chooser picks one
//     (electron alone: NotAllowedError)
//  4. dev electron is not signed with a keychain group: touch id stays off (uvpaa false)
//  5. no key present: olive shows its "insert your security key" prompt within 2 s (electron has
//     no webauthn ui: before, the page just waited with nothing on screen), Cancel ends the call
//     with NotAllowedError at once, and a fast key never flashes the prompt
// Run: node scripts/webauthn-native-test.mjs [--app /path/to/Packaged.app] [--shot file.png]
//   --app runs the same checks against a packaged build (asar, packaged preload paths). use a
//   throwaway copy with its own bundle id; the test always uses a temp profile.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const packaged = argv('--app');
const shotFile = argv('--shot');
const label = packaged ? 'packaged' : 'dev electron';
const shots = path.join(repo, 'notes/test-shots'); fs.mkdirSync(shots, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-webauthn-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>olive passkey fixture</title><h1>passkey fixture</h1>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
let app;
const helpers = `
  window.rnd = n => crypto.getRandomValues(new Uint8Array(n));
  window.b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  window.reg = async (name, extra = {}) => { try { const c = await navigator.credentials.create({ publicKey: { challenge: rnd(32), rp: { name: 'fixture', id: 'localhost' }, user: { id: new TextEncoder().encode(name), name, displayName: name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'preferred', ...(extra.sel || {}) }, timeout: extra.timeout || 20000 }, ...(extra.signal ? { signal: extra.signal } : {}) }); return { ok: true, id: c.id, attachment: c.authenticatorAttachment }; } catch (e) { return { ok: false, name: e.name, message: e.message }; } };
  window.login = async (ids, extra = {}) => { try { const a = await navigator.credentials.get({ publicKey: { challenge: rnd(32), rpId: 'localhost', allowCredentials: (ids || []).map(id => ({ type: 'public-key', id: Uint8Array.from(atob(id.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((id.length + 3) % 4)), c => c.charCodeAt(0)) })), userVerification: 'preferred', timeout: extra.timeout || 20000 } }); return { ok: true, id: a.id, user: a.response.userHandle ? new TextDecoder().decode(a.response.userHandle) : null }; } catch (e) { return { ok: false, name: e.name, message: e.message }; } };
  1`;
try {
  const exe = packaged ? path.join(packaged, 'Contents/MacOS', fs.readdirSync(path.join(packaged, 'Contents/MacOS'))[0]) : path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  app = await _electron.launch({ executablePath: exe, args: packaged ? [] : [repo], cwd: repo,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'passkey-test', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  const tabId = await app.evaluate(async (_, url) => {
    while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
    global.olive.onboarding?.close?.();
    const w = global.olive.focusedWindow(); w.win.setTitle('Olive passkey synthetic fixture');
    for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true });
    const t = w.createTab({ url, activate: true, focusPage: false });
    await new Promise(r => { t.wc.once('did-finish-load', r); setTimeout(r, 10000); });
    return t.id;
  }, url);
  const run = (code, ms = 30000) => Promise.race([app.evaluate((_, { tabId, code }) => global.olive.focusedWindow().tabs.get(tabId).wc.executeJavaScript(code, true), { tabId, code }), new Promise(r => setTimeout(() => r({ hung: true, ms }), ms))]);
  const cdp = (method, params = {}) => app.evaluate(async (_, { tabId, method, params }) => { const d = global.olive.focusedWindow().tabs.get(tabId).wc.debugger; if (!d.isAttached()) d.attach('1.3'); return d.sendCommand(method, params); }, { tabId, method, params });
  await run(helpers);

  // 4. touch id gate in dev electron
  const state = await app.evaluate(() => global.olive.webauthn);
  check(state && state.enabled === false && /not signed/.test(state.reason), `${label}: touch id passkeys stay off (no keychain group entitlement)`, state);
  check(await run('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()') === false, `${label}: isUserVerifyingPlatformAuthenticatorAvailable() is false`);
  if (packaged) check(await app.evaluate(({ app }) => app.isPackaged), 'running the packaged build (app.isPackaged)');

  // 5. no key: the user sees olive's prompt, and Cancel ends the call
  const prompts = () => app.evaluate(() => (global.olive.pageDialogs?.list?.() || []).filter(d => d.kind === 'passkey'));
  await run(`window.__pk = reg('no-key', { timeout: 60000, sel: { authenticatorAttachment: 'cross-platform' } }); 1`);
  let seen = [], t0 = Date.now();
  while (Date.now() - t0 < 2000) { seen = await prompts(); if (seen.some(d => d.shown)) break; await new Promise(r => setTimeout(r, 100)); }
  const seenMs = Date.now() - t0;
  check(seen.length === 1 && seen[0].shown && /localhost/.test(seen[0].title) && /security key/i.test(seen[0].message), `no key: the passkey prompt is on screen within 2 s (${seenMs} ms), not a silent wait`, seen);
  if (shotFile && seen.length) {
    const png = await app.evaluate(async () => { const w = global.olive.focusedWindow(); const e = global.olive.pageDialogs.views.get(w.win); return (await e.view.webContents.capturePage()).toPNG().toString('base64'); });
    fs.writeFileSync(shotFile, Buffer.from(png, 'base64'));
  }
  t0 = Date.now();
  const clicked = await app.evaluate(async () => { const w = global.olive.focusedWindow(); const e = global.olive.pageDialogs.views.get(w.win); if (!e) return false; return e.view.webContents.executeJavaScript(`(() => { const b = document.querySelector('#cancel'); if (!b || b.hidden || !document.querySelector('#ok').hidden) return false; b.click(); return true; })()`); }).catch(() => false);
  let r0 = await run('window.__pk', 5000);
  check(clicked && r0.ok === false && r0.name === 'NotAllowedError' && Date.now() - t0 < 3000, `no key: Cancel (the prompt's only button) ends the call with NotAllowedError (${Date.now() - t0} ms)`, { clicked, r0 });
  await new Promise(r => setTimeout(r, 300));
  check((await prompts()).length === 0, 'no key: the prompt is gone after cancel', await prompts());

  // 1. nobody answers (--skip-hang: leave out, to check 2/3 alone on an old build)
  if (!process.argv.includes('--skip-hang')) {
  let t0 = Date.now();
  let r = await run(`reg('nobody', { timeout: 10000, sel: { authenticatorAttachment: 'cross-platform' } })`, 20000);
  const took = Date.now() - t0;
  check(r.ok === false && r.name === 'NotAllowedError' && took >= 10000 && took < 15000, `unanswered create ends with NotAllowedError at its timeout (${took} ms)`, r);
  await new Promise(r => setTimeout(r, 300));
  check((await prompts()).length === 0, 'timed-out request: its prompt is gone', await prompts());
  r = await run(`(async () => { const ac = new AbortController(); setTimeout(() => ac.abort(), 500); return reg('again', { signal: ac.signal, sel: { authenticatorAttachment: 'cross-platform' } }); })()`, 10000);
  check(r.ok === false && r.name === 'AbortError', 'next request on the page is accepted (not "A request is already pending")', r);
  }
  let r;

  // 2. security key: register + login
  await cdp('WebAuthn.enable', { enableUI: false });
  const usb = await cdp('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  r = await run(`reg('key-user')`);
  check(r.ok && r.attachment === 'cross-platform', 'security key: register', r);
  check((await prompts()).length === 0, 'security key: a fast key never leaves a prompt up', await prompts());
  const keyCred = r.id;
  r = await run(`login(${JSON.stringify([keyCred])})`);
  check(r.ok && r.id === keyCred && r.user === 'key-user', 'security key: login with the registered credential', r);
  await cdp('WebAuthn.removeVirtualAuthenticator', { authenticatorId: usb.authenticatorId });

  // 3. two discoverable passkeys, chooser
  const plat = await cdp('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const a = await run(`reg('alice')`), b = await run(`reg('bob')`);
  check(a.ok && b.ok && a.id !== b.id, 'platform-style authenticator: two passkeys registered', { a, b });
  await app.evaluate(({ dialog }) => { global.__webauthnShown = []; global.__realShowMessageBox ||= dialog.showMessageBox; dialog.showMessageBox = async (...args) => { const o = args.find(x => x && x.buttons); global.__webauthnShown.push(o); return { response: o.buttons.indexOf('bob') }; }; });
  r = await run(`login([])`);
  const shown = await app.evaluate(() => global.__webauthnShown);
  check(shown.length === 1 && shown[0].buttons.includes('alice') && shown[0].buttons.includes('bob') && shown[0].buttons.at(-1) === 'Cancel' && /localhost/.test(shown[0].message), 'get() without allowCredentials shows the passkey chooser', shown);
  check(r.ok && r.id === b.id && r.user === 'bob', 'chooser: the picked passkey signs in', r);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const o = args.find(x => x && x.buttons); return { response: o.cancelId }; }; });
  r = await run(`login([])`);
  check(r.ok === false && r.name === 'NotAllowedError', 'chooser cancel: NotAllowedError', r);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = global.__realShowMessageBox; });
  await cdp('WebAuthn.removeVirtualAuthenticator', { authenticatorId: plat.authenticatorId });
} catch (error) { results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) }); console.error(error); }
finally {
  fs.writeFileSync(path.join(shots, 'webauthn-native-test.json'), JSON.stringify(results, null, 2));
  if (app) await app.close().catch(() => {});
  server.close(); fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`); if (results.some(r => !r.ok)) process.exitCode = 1;
