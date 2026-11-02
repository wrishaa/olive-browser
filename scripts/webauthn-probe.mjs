import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
// Manual probe (not in test:native): what navigator.credentials.create/get do on a real
// site in a throwaway profile. Never touches installed Olive or the real profile.
// Run: node scripts/webauthn-probe.mjs [--app /path/To.app] [--url https://webauthn.io/] [--attach platform|cross-platform|any] [--ms 8000] [--shot file.png]
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const appPath = arg('--app', path.join(repo, 'node_modules/electron/dist/Electron.app'));
const url = arg('--url', 'https://webauthn.io/');
const attach = arg('--attach', 'any');
const ms = Number(arg('--ms', '8000'));
const shot = arg('--shot', '');
const exe = fs.readdirSync(path.join(appPath, 'Contents/MacOS'))[0];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-passkey-probe-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const isRepoApp = appPath.includes('node_modules/electron');
let app; const out = { appPath, url, attach };
try {
  app = await _electron.launch({ executablePath: path.join(appPath, 'Contents/MacOS', exe), args: isRepoApp ? [repo] : [], cwd: repo,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'passkey-test', OLIVE_CDP_PORT: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  const tabId = await app.evaluate(async (_, url) => {
    while (!global.olive?.ready) await new Promise(r => setTimeout(r, 50));
    global.olive.onboarding?.close?.();
    const w = global.olive.focusedWindow();
    const t = w.createTab({ url, activate: true });
    await new Promise(r => { const done = () => r(); t.wc.once('did-finish-load', done); setTimeout(done, 15000); });
    return t.id;
  }, url);
  // a webauthn request can hang past its own timeout (electron has no timeout ui): cap it
  const run = code => Promise.race([app.evaluate(async (_, { tabId, code }) => {
    const t = global.olive.focusedWindow().tabs.get(tabId);
    return t.wc.executeJavaScript(code, true);
  }, { tabId, code }), new Promise(r => setTimeout(() => r({ hung: true, after: ms + 5000 }), ms + 5000))]);
  const force = arg('--force-group', '');
  // --force-group: call configureWebAuthn without the entitlement (shows why olive gates it)
  if (force) out.forced = await app.evaluate(({ app }, g) => { try { app.configureWebAuthn({ touchID: { keychainAccessGroup: g } }); return 'configured ' + g; } catch (e) { return String(e); } }, force);
  out.webauthn = await app.evaluate(() => global.olive.webauthn);
  // --virtual usb|internal: a CDP virtual authenticator on the tab (stands in for a security key / touch id)
  const virt = arg('--virtual', '');
  if (virt) out.virtual = await app.evaluate(async (_, { tabId, virt }) => {
    const d = global.olive.focusedWindow().tabs.get(tabId).wc.debugger; d.attach('1.3');
    await d.sendCommand('WebAuthn.enable', { enableUI: false });
    return d.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: virt, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }, { tabId, virt });
  if (process.argv.includes('--check-only')) {
    out.uvpaa = await run(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`);
  } else if (process.argv.includes('--ui')) {
    // webauthn.io's own buttons: the site's js does create/get (incl. aborting its conditional get).
    out.uvpaa = await run(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`);
    out.inputs = await run(`[...document.querySelectorAll('input,button,select')].map(e=>e.id||e.name||e.textContent.trim()).slice(0,30)`);
    // record what the site's own create/get calls resolve to
    await run(`(()=>{window.__log=[];const c=navigator.credentials;for(const k of ['create','get']){const f=c[k].bind(c);c[k]=o=>{const t=Date.now(),e={k,mediation:o?.mediation||'',attach:o?.publicKey?.authenticatorSelection?.authenticatorAttachment||'',hints:o?.publicKey?.hints||[],timeout:o?.publicKey?.timeout};window.__log.push(e);return f(o).then(r=>{e.ok=true;e.attachment=r?.authenticatorAttachment;e.ms=Date.now()-t;return r},x=>{e.ok=false;e.err=x.name+': '+x.message;e.ms=Date.now()-t;throw x})}}return 1})()`);
    const waitLog = async n => { const end = Date.now() + ms; while (Date.now() < end) { const l = await run('window.__log'); if (l.filter(e => e.ms != null && e.mediation !== 'conditional').length >= n) break; await new Promise(r => setTimeout(r, 500)); } };
    await run(`(()=>{const i=document.querySelector('#input-email');i.value='olive-probe-'+Date.now();i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#register-button').click();return 1})()`);
    const state = () => run(`(()=>{const q=s=>[...document.querySelectorAll(s)].map(e=>e.innerText.trim()).filter(Boolean);return {alerts:q('.alert,[role=alert],.toast,.text-danger,.text-success'),body:document.body.innerText.slice(0,120)}})()`);
    await waitLog(1); out.afterRegister = await state(); out.logRegister = await run('window.__log');
    await run(`(()=>{document.querySelector('#login-button').click();return 1})()`);
    await waitLog(2); out.afterLogin = await state(); out.logLogin = await run('window.__log');
  } else {
  const abortSig = process.argv.includes('--abort') ? `,signal:AbortSignal.timeout(${ms})` : '';
  const sel = attach === 'any' ? '' : `authenticatorAttachment:'${attach}',`;
  out.uvpaa = await run(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`);
  out.cond = await run(`PublicKeyCredential.isConditionalMediationAvailable?.()`);
  const t0 = Date.now();
  out.create = await run(`(async()=>{const rnd=n=>crypto.getRandomValues(new Uint8Array(n));try{const c=await navigator.credentials.create({publicKey:{challenge:rnd(32),rp:{name:'webauthn.io',id:location.hostname},user:{id:rnd(16),name:'olive-passkey-probe',displayName:'olive passkey probe'},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{${sel}residentKey:'preferred',userVerification:'preferred'},timeout:${ms}}${abortSig}});window.__cred=c.rawId;return {ok:true,id:c.id,type:c.type,attachment:c.authenticatorAttachment,transports:c.response.getTransports?.()}}catch(e){return {ok:false,name:e.name,message:e.message}}})()`);
  out.createMs = Date.now() - t0;
  const t1 = Date.now();
  out.get = await run(`(async()=>{try{const a=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:location.hostname,allowCredentials:window.__cred?[{type:'public-key',id:window.__cred}]:[],userVerification:'preferred',timeout:${ms}}});return {ok:true,id:a.id,attachment:a.authenticatorAttachment}}catch(e){return {ok:false,name:e.name,message:e.message}}})()`);
  out.getMs = Date.now() - t1;
  }
  if (shot) {
    const png = await app.evaluate(async (_, tabId) => (await global.olive.focusedWindow().tabs.get(tabId).wc.capturePage()).toPNG().toString('base64'), tabId);
    fs.writeFileSync(shot, Buffer.from(png, 'base64')); out.shot = shot;
  }
} catch (e) { out.error = String(e.stack || e); }
finally { if (app) await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 2));
