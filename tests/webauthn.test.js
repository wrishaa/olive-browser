// passkeys: src/main/webauthn.js (when touch id gets turned on, account chooser),
// src/ui/webauthn-preload.js (hung requests end at their timeout) in a vm, and
// scripts/passkey-signing.mjs (entitlements only with a matching provisioning profile).
// native check: scripts/webauthn-native-test.mjs.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const webauthn = require('../src/main/webauthn');

const ents = groups => `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>`
  + (groups ? `<key>keychain-access-groups</key>\n\t<array>\n${groups.map(g => `\t\t<string>${g}</string>`).join('\n')}\n\t</array>` : '') + `</dict></plist>`;
// a fake mach-o: junk bytes, then the signature's entitlements blob
const binary = groups => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 255]), Buffer.from(ents(groups), 'latin1'), Buffer.from([0, 0, 7])]);

test('keychain groups are read from the signed binary', () => {
  assert.deepEqual(webauthn.keychainGroups(binary(['GLUU6G59Y3.com.reframe.olive.webauthn'])), ['GLUU6G59Y3.com.reframe.olive.webauthn']);
  assert.deepEqual(webauthn.keychainGroups(binary(['GLUU6G59Y3.shared', 'GLUU6G59Y3.com.reframe.olive.webauthn'])), ['GLUU6G59Y3.shared', 'GLUU6G59Y3.com.reframe.olive.webauthn']);
  assert.deepEqual(webauthn.keychainGroups(binary(null)), []);
  assert.deepEqual(webauthn.keychainGroups(Buffer.alloc(0)), []);
  assert.equal(webauthn.pickGroup(['GLUU6G59Y3.shared', 'GLUU6G59Y3.com.reframe.olive.webauthn']), 'GLUU6G59Y3.com.reframe.olive.webauthn');
  assert.equal(webauthn.pickGroup(['GLUU6G59Y3.shared']), null);
  assert.equal(webauthn.pickGroup(['GLUU6G59Y3.a.webauthn'], 'GLUU6G59Y3.b.webauthn'), null, 'override must be signed too');
});

function fakeApp() { const calls = []; return { calls, configureWebAuthn: o => calls.push(o) }; }
const tmpDirs = []; after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpBinary(groups) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-webauthn-test-')); tmpDirs.push(d); const f = path.join(d, 'Olive'); fs.writeFileSync(f, binary(groups)); return f; }

test('touch id is only configured when the binary carries a .webauthn keychain group', () => {
  let app = fakeApp();
  let r = webauthn.configure(app, { platform: 'darwin', execPath: tmpBinary(null), env: {} });
  assert.equal(r.enabled, false); assert.match(r.reason, /not signed/); assert.equal(app.calls.length, 0);

  app = fakeApp();
  r = webauthn.configure(app, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} });
  assert.equal(r.enabled, true); assert.equal(r.group, 'GLUU6G59Y3.com.reframe.olive.webauthn');
  assert.deepEqual(app.calls, [{ touchID: { keychainAccessGroup: 'GLUU6G59Y3.com.reframe.olive.webauthn', promptReason: 'sign in to $1' } }]);

  app = fakeApp();
  assert.equal(webauthn.configure(app, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: { OLIVE_WEBAUTHN: '0' } }).enabled, false);
  assert.equal(webauthn.configure(app, { platform: 'linux', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} }).enabled, false);
  assert.equal(webauthn.configure({}, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} }).enabled, false, 'old electron');
  assert.equal(app.calls.length, 0);
  const throwing = { configureWebAuthn() { throw new Error('nope'); } };
  assert.deepEqual(webauthn.configure(throwing, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} }).reason, 'nope');
});

test('configureWebAuthn waits for app ready (electron 44 crashes when called before ready)', async () => {
  let ready; const whenReady = new Promise(r => { ready = r; });
  const app = { ...fakeApp(), isReady: () => false, whenReady: () => whenReady };
  const r = webauthn.configure(app, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} });
  assert.equal(r.enabled, true); assert.equal(app.calls.length, 0, 'not called before ready');
  ready(); await whenReady; await null;
  assert.equal(app.calls.length, 1, 'called once ready');
  const late = { isReady: () => false, whenReady: () => Promise.resolve(), configureWebAuthn() { throw new Error('late nope'); } };
  const s = webauthn.configure(late, { platform: 'darwin', execPath: tmpBinary(['GLUU6G59Y3.com.reframe.olive.webauthn']), env: {} });
  await Promise.resolve(); await null;
  assert.equal(s.enabled, false); assert.equal(s.reason, 'late nope');
});

function picker(response) {
  const ses = new EventEmitter(), shown = [];
  const dialog = { showMessageBox: async (...a) => { shown.push(a); if (response instanceof Error) throw response; return { response }; } };
  webauthn.installAccountPicker(ses, { dialog, windowFor: f => (f ? { win: f } : null)?.win });
  webauthn.installAccountPicker(ses, { dialog, windowFor: () => null }); // second install is a no-op
  const pick = details => new Promise(resolve => { const got = []; ses.emit('select-webauthn-account', {}, details, (...a) => { got.push(a); setTimeout(() => resolve({ got, shown }), 10); }); });
  return { ses, pick };
}
const accounts = [{ credentialId: 'AAA', name: 'dj@reframe.so', displayName: 'dj' }, { credentialId: 'BBB', name: 'work@reframe.so', displayName: 'work@reframe.so' }];

test('several passkeys: the chooser answers with the picked credential, exactly once', async () => {
  assert.equal(new EventEmitter().listenerCount('select-webauthn-account'), 0);
  const { ses, pick } = picker(1);
  assert.equal(ses.listenerCount('select-webauthn-account'), 1);
  const { got, shown } = await pick({ relyingPartyId: 'webauthn.io', accounts, frame: 'FRAME' });
  assert.deepEqual(got, [['BBB']]);
  assert.equal(shown[0][0], 'FRAME', 'sheet on the tab window');
  assert.deepEqual(shown[0][1].buttons, ['dj (dj@reframe.so)', 'work@reframe.so', 'Cancel']);
  assert.equal(shown[0][1].cancelId, 2); assert.match(shown[0][1].message, /webauthn\.io/);
});

test('chooser cancel, failure and empty lists cancel the request (callback with no id)', async () => {
  assert.deepEqual((await picker(2).pick({ relyingPartyId: 'x', accounts })).got, [[]]);
  assert.deepEqual((await picker(new Error('boom')).pick({ relyingPartyId: 'x', accounts })).got, [[]]);
  assert.deepEqual((await picker(0).pick({ relyingPartyId: 'x', accounts: [] })).got, [[]]);
  const one = await picker(0).pick({ relyingPartyId: 'x', accounts: [accounts[0]] });
  assert.deepEqual(one.got, [['AAA']]); assert.equal(one.shown.length, 0);
  assert.equal(webauthn.accountLabel({}), 'passkey');
});

// ---------- page-world shim ----------
function page() {
  const timers = [];
  const ctx = vm.createContext({ AbortController, AbortSignal, DOMException, Object, Number, Math, Promise,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.cleared = true; } });
  ctx.globalThis = ctx;
  vm.runInContext(`
    var calls = [];
    globalThis.CredentialsContainer = class CredentialsContainer {
      // like electron with no authenticator: never settles unless aborted
      create(o) { calls.push(['create', o]); return new Promise((res, rej) => { if (o && o.signal) o.signal.addEventListener('abort', () => rej(o.signal.reason)); if (o && o.answer) res({ id: 'cred' }); }); }
      get(o) { calls.push(['get', o]); return new Promise((res, rej) => { if (o && o.signal) o.signal.addEventListener('abort', () => rej(o.signal.reason)); if (o && o.answer) res({ id: 'cred' }); }); }
    };
    var credentials = new CredentialsContainer();`, ctx);
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/webauthn-preload.js'), 'utf8');
  const sent = [], on = {};
  const ipcRenderer = { send: (...a) => sent.push(a), on: (ch, fn) => { on[ch] = fn; } };
  const electron = { ipcRenderer, contextBridge: { executeInMainWorld: ({ func, args }) => { ctx.__args = args; vm.runInContext(`(${func.toString()})(...__args)`, ctx); } } };
  vm.runInNewContext(src, { require: n => { if (n !== 'electron') throw new Error(n); return electron; }, Map });
  // timeout timers vs the 600 ms "show the prompt" timers
  const deadlines = () => timers.filter(t => t.ms !== 600), shows = () => timers.filter(t => t.ms === 600);
  return { ctx, timers, deadlines, shows, sent, on, run: code => vm.runInContext(code, ctx) };
}

test('a passkey request nobody answers fails with NotAllowedError at its (clamped) timeout', async () => {
  const p = page();
  const pending = p.run(`credentials.create({ publicKey: { timeout: 60000 } })`);
  assert.equal(p.deadlines().length, 1); assert.equal(p.deadlines()[0].ms, 61000);
  p.deadlines()[0].fn();
  await assert.rejects(pending, e => e.name === 'NotAllowedError' && /timed out or was not allowed/.test(e.message));
  p.run(`credentials.get({ publicKey: { timeout: 1 } })`); assert.equal(p.deadlines()[1].ms, 11000, 'chromium lower clamp');
  p.run(`credentials.get({ publicKey: { timeout: 3600000 } })`); assert.equal(p.deadlines()[2].ms, 601000, 'upper clamp');
  p.run(`credentials.get({ publicKey: {} })`); assert.equal(p.deadlines()[3].ms, 301000, 'default when unset');
});

test('a waiting passkey request shows olive\'s prompt (electron has none); its Cancel ends the call, settling hides it', async () => {
  const p = page();
  const pending = p.run(`credentials.create({ publicKey: { rp: { id: 'webauthn.io', name: 'x' }, timeout: 60000 } })`);
  assert.equal(p.sent.length, 0, 'nothing shown before the short delay (a fast key never flashes it)');
  p.shows()[0].fn();
  assert.deepEqual(p.sent[0], ['olive:webauthn-prompt', 1, 'create', 'webauthn.io']);
  p.on['olive:webauthn-cancel']({}, 1); // the user pressed Cancel
  await assert.rejects(pending, e => e.name === 'NotAllowedError');
  await new Promise(r => setImmediate(r));
  assert.equal(p.deadlines()[0].cleared, true);
  // a request that settles while its prompt is up takes the prompt down
  const ok = p.run(`credentials.get({ publicKey: { rpId: 'webauthn.io' } })`);
  p.shows()[1].fn();
  assert.deepEqual(p.sent.at(-1), ['olive:webauthn-prompt', 2, 'get', 'webauthn.io']);
  p.deadlines()[1].fn(); await assert.rejects(ok, e => e.name === 'NotAllowedError'); await new Promise(r => setImmediate(r));
  assert.deepEqual(p.sent.at(-1), ['olive:webauthn-prompt-end', 2]);
  // answered before the delay: the show timer is cleared, nothing is sent
  const n = p.sent.length;
  await p.run(`credentials.get({ publicKey: {}, answer: true })`);
  assert.equal(p.shows()[2].cleared, true); assert.equal(p.sent.length, n);
});

test('answered requests clear the timer; conditional, non-passkey and page aborts are untouched', async () => {
  const p = page();
  assert.equal((await p.run(`credentials.get({ publicKey: { timeout: 60000 }, answer: true })`)).id, 'cred');
  assert.equal(p.deadlines()[0].cleared, true);
  p.run(`credentials.get({ publicKey: {}, mediation: 'conditional' })`);
  p.run(`credentials.get({ password: true })`);
  assert.equal(p.timers.length, 2, 'no timer and no prompt for conditional / non-publicKey');
  assert.equal(p.run(`calls[1][1].signal`), undefined, 'conditional request passed through as is');
  // the page's own signal still aborts, with the page's reason
  const pending = p.run(`globalThis.ac = new AbortController(); credentials.create({ publicKey: {}, signal: ac.signal })`);
  p.run(`ac.abort(new DOMException('mine', 'AbortError'))`);
  await assert.rejects(pending, e => e.name === 'AbortError' && e.message === 'mine');
  assert.equal(p.run(`Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, 'create').value.name`), 'create');
});

// ---------- signing ----------
test('passkey entitlements need a provisioning profile for this team + app id', async () => {
  const s = await import('../scripts/passkey-signing.mjs');
  const good = { team: 'GLUU6G59Y3', appId: 'GLUU6G59Y3.com.reframe.olive', groups: ['GLUU6G59Y3.*'], platforms: ['OSX'], expires: new Date(Date.now() + 864e5) };
  assert.deepEqual(s.profileProblems(good, { bundleId: 'com.reframe.olive' }), []);
  assert.deepEqual(s.profileProblems({ ...good, appId: 'GLUU6G59Y3.*' }, { bundleId: 'com.reframe.olive' }), []);
  assert.equal(s.profileProblems({ ...good, team: 'MUJ69H4YR2' }, { bundleId: 'com.reframe.olive' }).length, 1);
  assert.match(s.profileProblems({ ...good, appId: 'GLUU6G59Y3.com.other' }, { bundleId: 'com.reframe.olive' })[0], /does not cover/);
  assert.match(s.profileProblems({ ...good, groups: ['GLUU6G59Y3.com.other.*'] }, { bundleId: 'com.reframe.olive' })[0], /keychain-access-groups/);
  assert.match(s.profileProblems({ ...good, platforms: ['iOS'] }, { bundleId: 'com.reframe.olive' })[0], /not macOS/);
  assert.match(s.profileProblems({ ...good, expires: new Date(0) }, { bundleId: 'com.reframe.olive' })[0], /expired/);
  const base = fs.readFileSync(path.join(__dirname, '../assets/entitlements.plist'), 'utf8');
  assert.doesNotMatch(base, /keychain-access-groups/, 'shipped base set has no restricted entitlement');
  const out = s.withPasskeyEntitlements(base, { bundleId: 'com.reframe.olive' });
  assert.deepEqual(webauthn.keychainGroups(out), ['GLUU6G59Y3.com.reframe.olive.webauthn']);
  assert.match(out, /<key>com.apple.application-identifier<\/key><string>GLUU6G59Y3.com.reframe.olive<\/string>/);
  assert.match(out, /com.apple.security.device.camera/);
  // no profile: base entitlements, nothing embedded
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-sign-test-')); const logs = [];
  const r = s.passkeySigning({ root, app: root, bundleId: 'com.reframe.olive', baseEntitlements: 'BASE', env: {}, log: m => logs.push(m) });
  assert.equal(r.entitlements, 'BASE'); assert.match(logs[0], /passkeys stay off/);
  assert.equal(fs.existsSync(path.join(root, 'Contents', 'embedded.provisionprofile')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
