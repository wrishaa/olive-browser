// Isolated setup tests: temporary files, mocked Electron/OS/Keychain; no live profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Onboarding } = require('../src/main/onboarding');
const { preparePackage, verifyPackage } = require('../src/main/extensions');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-setup-test-'));
let prompts = [], opened = [], launched = 0, quit = 0, imported = [];
const handlers = new Map();
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = f => { this.openHandler = f; }; this.webContents.send = () => {}; }
  setMenu() {} loadFile(file) { assert(fs.existsSync(file)); } show() {} focus() {} isDestroyed() { return !!this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); }
}
const electron = { BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: { openExternal: async url => opened.push(url) }, app: { isPackaged: false, relaunch: () => launched++, quit: () => quit++ } };
const importer = {
  discoverBrowsers: async () => [{ id: 'chrome', name: 'Chrome', supported: true, profiles: [{ id: 'chrome:Default', name: 'Personal', dir: '/private/source/profile', supported: true }] }],
  importSelected: async (session, ids) => { imported.push({ session, ids }); return { imported: 2, existing: 1, failed: 0, profiles: [] }; },
};
const mgr = { dataPath: path.join(root, 'fresh'), profileInfo: { id: 'fresh', name: 'Fresh', isLegacy: false }, permissions: { status: () => 'not-determined', osMedia: async types => { prompts.push(types); return false; }, registerScreenAccess: async () => { prompts.push('screen'); return []; } }, session: { id: 'fresh-session' } };
(async () => {
  try {
    const setup = new Onboarding(mgr, { electron, importer });
    assert.equal(setup.maybeRun(), true);
    assert.deepEqual(prompts, [], 'opening setup never prompts');
    assert.equal(setup.view.options.webPreferences.sandbox, true);
    assert.deepEqual(setup.view.openHandler(), { action: 'deny' });
    await assert.rejects(handlers.get('olive:onboarding')({ sender: {} }, 'get'), /Not a setup window/);
    await setup.command('next');
    assert.equal(setup.state().step, 'calls');
    await assert.rejects(setup.command('calls'), /Confirm/);
    await setup.command('calls', { confirmed: true });
    assert.deepEqual(prompts, [['audio'], ['video']], 'camera still requested after microphone denial');
    await setup.command('next');
    assert.equal(setup.state().step, 'import', 'import comes before screen sharing');
    await setup.command('discover');
    assert(!JSON.stringify(setup.state()).includes('/private/source'), 'source paths never reach renderer');
    const payload = { selections: [{ browserId: 'chrome', profileId: 'chrome:Default', cookies: true }] };
    await assert.rejects(setup.command('import', payload), /Keychain/);
    assert.equal(imported.length, 0);
    await setup.command('import', { ...payload, keychainConfirmed: true });
    assert.equal(imported[0].session, mgr.session);
    assert.deepEqual(imported[0].ids, ['chrome:Default']);
    assert.match(setup.state().result.summary, /2 cookies copied/);
    await setup.command('next');
    assert.equal(setup.state().step, 'screen', 'screen sharing is the last step before done');
    await assert.rejects(setup.command('screen'), /Confirm/);
    assert.equal(opened.length, 0);
    await setup.command('screen', { confirmed: true });
    assert.equal(prompts.at(-1), 'screen');
    assert.match(opened.at(-1), /Privacy_ScreenCapture$/);
    assert.equal(launched, 0, 'screen access does not restart automatically');
    await assert.rejects(setup.command('relaunch'), /Confirm/);
    await setup.command('relaunch', { confirmed: true });
    assert.equal(launched, 1); assert.equal(quit, 1); assert.equal(setup.state().step, 'done', 'relaunch lands on the step after screen');
    await setup.command('finish');
    assert.equal(setup.maybeRun(), false);
    mgr.dataPath = path.join(root, 'second'); mgr.profileInfo = { id: 'second', name: 'Second', isLegacy: false };
    setup.reset(); assert.equal(setup.maybeRun(), true); assert.equal(setup.state().step, 'welcome');
    assert.equal(setup.state().result, null);
    await setup.command('later'); assert.equal(setup.maybeRun(), false, 'later does not force setup open on launch'); assert.equal(setup.show(), true, 'manual setup resumes unfinished setup');
    mgr.dataPath = path.join(root, 'legacy'); mgr.profileInfo = { id: 'default', name: 'Default (existing)', isLegacy: true };
    setup.reset(); assert.equal(setup.maybeRun(), false, 'legacy data never opens setup by itself');
    assert(!fs.existsSync(mgr.dataPath), 'legacy profile untouched until the user asks');
    assert.equal(setup.show(), true, 'Set Up Olive… always opens setup, legacy profile too');
    assert.equal(setup.state().step, 'welcome'); setup.close();
    const bundle = path.resolve(__dirname, '../vendor/ublock');
    const record = JSON.parse(fs.readFileSync(path.join(bundle, 'record.json')));
    assert.equal(verifyPackage(path.join(bundle, 'unpacked'), record).version, record.version);
    const prepared = preparePackage(path.join(root, 'blocker'));
    assert(prepared.root.startsWith(root));
    fs.appendFileSync(path.join(prepared.root, 'manifest.json'), ' ');
    assert.throws(() => verifyPackage(prepared.root, record), /integrity/);
    preparePackage(path.join(root, 'blocker'));
    assert.equal(verifyPackage(prepared.root, record).version, record.version, 'damaged profile copy repaired');
    console.log('onboarding unit: PASS (first run, confirmations, import consent, profiles, legacy, bundled integrity)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
