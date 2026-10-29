// Setup survives the Screen Recording relaunch: quitting never pauses it, the next
// launch continues after the screen step, and browser import is reachable any time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Onboarding } = require('../src/main/onboarding');

class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
  setMenu() {} loadFile() {} show() {} focus() {} isDestroyed() { return !!this.destroyed; }
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
}
const importer = {
  discoverBrowsers: async () => [{ id: 'chrome', name: 'Chrome', profiles: [{ id: 'chrome:Default', name: 'Personal' }] }],
  importSelected: async () => ({ imported: 3, existing: 0, failed: 0, profiles: [] }),
};
// One "process": its own electron app emitter, manager and Onboarding over a shared profile dir.
function launch(dataPath, screen = 'not-determined') {
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, relaunch() { app.relaunched = true; }, quit() { app.emit('before-quit'); app.emit('will-quit'); } });
  const electron = { BrowserWindow: Window, ipcMain: { handle() {} }, shell: { openExternal: async () => {} }, app };
  const mgr = { dataPath, profileInfo: { id: 'p', name: 'P', isLegacy: false }, session: {},
    permissions: { status: kind => kind === 'screen' ? screen : 'not-determined', osMedia: async () => false, registerScreenAccess: async () => [] } };
  return { app, mgr, setup: new Onboarding(mgr, { electron, importer }) };
}
const saved = dir => JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olive-resume-test-'));

async function toScreenRequested(setup) {
  assert.equal(setup.maybeRun(), true);
  await setup.command('next'); assert.equal(setup.state().step, 'calls');
  await setup.command('next'); assert.equal(setup.state().step, 'import');
  await setup.command('next'); assert.equal(setup.state().step, 'screen');
  await setup.command('screen', { confirmed: true });
}

test('quit mid-screen step (macOS Quit & Reopen) → relaunch shows setup at the next step (done)', async () => {
  const dir = tmp();
  try {
    const first = launch(dir);
    await toScreenRequested(first.setup);
    assert.equal(saved(dir).step, 'screen', 'step persisted on every change');
    first.app.quit(); // tcc / SIGTERM: before-quit → main closes every window, setup view included
    first.setup.close();
    assert.notEqual(saved(dir).paused, true, 'quitting is not "set up later"');
    assert.equal(saved(dir).completed, false);
    const second = launch(dir, 'granted');
    assert.equal(second.setup.maybeRun(), true, 'setup comes back after relaunch');
    assert.equal(second.setup.state().step, 'done');
    assert.equal(saved(dir).step, 'done', 'resumed step persisted');
    assert.equal(saved(dir).completed, false, 'completed only after Start Browsing');
    // Not granted yet (user quit without turning it on): stays on the screen step but still shows.
    const dir2 = tmp();
    try {
      const a = launch(dir2); await toScreenRequested(a.setup); a.app.quit(); a.setup.close();
      const b = launch(dir2, 'denied');
      assert.equal(b.setup.maybeRun(), true); assert.equal(b.setup.state().step, 'screen');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mgr.quitting alone (main before-quit runs first) also keeps setup unpaused', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    await toScreenRequested(run.setup);
    run.mgr.quitting = true; run.setup.close();
    assert.notEqual(saved(dir).paused, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('in-app Quit and Reopen lands on the step after screen', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    await toScreenRequested(run.setup);
    await run.setup.command('relaunch', { confirmed: true });
    run.setup.close();
    assert.equal(run.app.relaunched, true);
    const next = launch(dir, 'granted');
    assert.equal(next.setup.maybeRun(), true); assert.equal(next.setup.state().step, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state paused by the old quit bug (old order: screen before import) resumes after screen', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'onboarding.json'), JSON.stringify({ version: 1, step: 'screen', completed: false, screenRequested: true, paused: true }));
    const run = launch(dir, 'granted');
    assert.equal(run.setup.maybeRun(), true); assert.equal(run.setup.state().step, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Set Up Later and closing setup by hand still pause it', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    assert.equal(run.setup.maybeRun(), true);
    await run.setup.command('later');
    assert.equal(saved(dir).paused, true);
    assert.equal(launch(dir).setup.maybeRun(), false, 'later does not force setup open on launch');
    const again = launch(dir);
    assert.equal(again.setup.show(), true);
    for (let i = 0; i < 3; i++) await again.setup.command('next');
    await again.setup.command('screen', { confirmed: true });
    again.setup.close(); // user closes it, app keeps running
    assert.equal(saved(dir).paused, true); assert.equal(saved(dir).pausedBy, 'user');
    assert.equal(launch(dir, 'granted').setup.maybeRun(), false, 'a hand-paused setup is not forced open, even after a grant');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plain quit (Cmd-Q) mid-flow → relaunch resumes at the same step', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    run.setup.maybeRun(); await run.setup.command('next'); await run.setup.command('next');
    assert.equal(run.setup.state().step, 'import');
    run.app.quit(); run.setup.close();
    const next = launch(dir);
    assert.equal(next.setup.maybeRun(), true); assert.equal(next.setup.state().step, 'import');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Set Up Olive… always opens: mid-flow after a hand close, after done, and on a legacy profile', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    run.setup.maybeRun(); await run.setup.command('next'); await run.setup.command('next');
    run.setup.close(); assert.equal(saved(dir).paused, true);
    assert.equal(run.setup.show(), true, 'menu reopens paused setup'); assert.equal(run.setup.state().step, 'import');
    for (let i = 0; i < 2; i++) await run.setup.command('next');
    await run.setup.command('finish'); assert.equal(run.setup.view, null);
    assert.equal(run.setup.show(), true, 'menu reopens setup after done'); assert.equal(run.setup.state().step, 'welcome');
    const legacy = launch(dir); legacy.mgr.profileInfo = { id: 'default', name: 'Default (existing)', isLegacy: true };
    assert.equal(legacy.setup.maybeRun(), false, 'legacy never auto-opens');
    assert.equal(legacy.setup.show(), true, 'legacy opens on request');
    assert.equal(legacy.setup.showImport(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('done stays done across relaunch and quit', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    run.setup.maybeRun();
    for (let i = 0; i < 4; i++) await run.setup.command('next');
    assert.equal(run.setup.state().step, 'done');
    assert.equal(saved(dir).completed, false, 'completed only on finish');
    await run.setup.command('finish');
    assert.equal(saved(dir).completed, true);
    run.app.quit();
    const next = launch(dir, 'granted');
    assert.equal(next.setup.maybeRun(), false);
    assert.equal(saved(dir).step, 'done'); assert.equal(saved(dir).completed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('menu Import from Browser opens the import step directly, without touching setup progress', async () => {
  const dir = tmp();
  try {
    const run = launch(dir);
    run.setup.maybeRun();
    for (let i = 0; i < 4; i++) await run.setup.command('next');
    await run.setup.command('finish');
    assert.equal(run.setup.showImport(), true);
    assert.equal(run.setup.state().step, 'import'); assert.equal(run.setup.state().only, 'import');
    await run.setup.command('discover');
    await run.setup.command('import', { selections: [{ browserId: 'chrome', profileId: 'chrome:Default', cookies: true }], keychainConfirmed: true });
    assert.match(run.setup.state().result.summary, /3 cookies copied/);
    await run.setup.command('next'); // "Done"
    assert.equal(run.setup.view, null, 'Done closes the import panel');
    assert.equal(saved(dir).completed, true); assert.equal(saved(dir).step, 'done'); assert.notEqual(saved(dir).paused, true);
    // Mid-setup: import-only over an unfinished setup leaves the saved step alone and does not pause.
    const dir2 = tmp();
    try {
      const mid = launch(dir2); mid.setup.maybeRun(); await mid.setup.command('next');
      mid.setup.showImport(); assert.equal(mid.setup.state().step, 'import');
      await mid.setup.command('skip');
      assert.equal(saved(dir2).step, 'calls'); assert.notEqual(saved(dir2).paused, true);
      assert.equal(mid.setup.show(), true); assert.equal(mid.setup.state().step, 'calls', 'Set Up Olive… goes back to the real step');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('menu and omnibar expose Import from Browser', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/menu.js'), 'utf8');
  assert.match(src, /'Import from Browser…', click: \(\) => mgr\.onboarding\?\.showImport\(\)/);
  assert.ok(src.indexOf('Import from Browser…') < src.indexOf('Import from Arc…'));
  const { commandSuggestions, isAppCommand } = require('../src/core/app-commands');
  assert.equal(isAppCommand('importBrowser'), true);
  assert.equal(commandSuggestions('import')[0].commandId, 'importBrowser');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/main/window.js'), 'utf8'), /case 'importBrowser': return this\.mgr\.onboarding\?\.showImport\(\);/);
});
