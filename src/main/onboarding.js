// First-run setup is profile-local and optional. It never opens by itself for legacy
// data, but Set Up Olive… / Import from Browser… always open it on request.
const fs = require('fs');
const path = require('path');
// Screen sharing is last before done: granting it makes macOS quit and reopen Olive,
// so everything else (import included) is behind the user by then.
const STEPS = ['welcome', 'calls', 'import', 'screen', 'done'];
class Onboarding {
  constructor(mgr, deps = {}) {
    this.mgr = mgr;
    this.electron = deps.electron || require('electron');
    this.importer = deps.importer;
    this.Panel = deps.Panel || (deps.electron ? deps.electron.BrowserWindow : null);
    this.view = null; this.busy = false; this.sources = []; this.quitting = false; this.only = null;
    this.reload();
    // Quitting closes the setup view too. That is not the user setting up later:
    // macOS (Screen Recording "Quit & Reopen", SIGTERM) and app.quit() all land here first.
    for (const event of ['before-quit', 'will-quit']) this.electron.app.on?.(event, () => { this.quitting = true; });
    this.electron.ipcMain.handle('olive:onboarding', async (event, action, payload = {}) => {
      if (!this.view || this.view.isDestroyed() || event.sender !== this.view.webContents || (this.view.webContents.mainFrame && event.senderFrame !== this.view.webContents.mainFrame)) throw new Error('Not a setup window');
      return this.command(action, payload);
    });
  }
  eligible() { return !!this.mgr.profileInfo && !!this.mgr.dataPath; }
  autoEligible() { return this.eligible() && this.mgr.profileInfo.isLegacy === false; }
  // The sidebar row: unfinished setup in a fresh profile, or setup the user opened by hand.
  listed() { return this.eligible() && !this.saved.completed && (this.autoEligible() || fs.existsSync(this.file || '') || !!(this.view && !this.view.isDestroyed())); }
  reload() {
    const file = this.mgr.dataPath ? path.join(this.mgr.dataPath, 'onboarding.json') : null;
    if (file !== this.file) { this.generation = (this.generation || 0) + 1; this.sources = []; this.result = null; this.progress = ''; this.busy = false; }
    this.file = file;
    this.saved = { version: 1, step: 'welcome', completed: false };
    if (!this.eligible()) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === 1) this.saved = { ...this.saved, ...saved, step: STEPS.includes(saved.step) ? saved.step : 'welcome' };
    } catch {}
  }
  save() {
    if (!this.eligible()) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  system() {
    const service = this.mgr.permissions;
    return Object.fromEntries(['microphone', 'camera', 'screen'].map(kind => [kind, service?.status(kind) || 'unknown']));
  }
  state() {
    return { step: this.only || this.saved.step, only: this.only, completed: this.saved.completed, profile: this.mgr.profileInfo?.name || 'Your profile',
      system: this.system(), callsRequested: !!this.saved.callsRequested, imported: !!this.saved.imported, screenRequested: !!this.saved.screenRequested, result: this.result || null,
      blocker: this.mgr.extensions?.status || { installed: false, enabled: false, gap: 'The network blocker is starting.' },
      browsers: this.sources.map(b => ({ id: b.id, name: b.name, profiles: b.profiles.map(p => ({ id: p.id, name: p.name, available: p.available, reason: p.reason })) })),
      busy: this.busy, progress: this.progress || '', appPath: this.electron.app.isPackaged ? path.dirname(path.dirname(this.electron.app.getPath('exe'))) : null };
  }
  // A relaunch after granting Screen Recording continues at the next step.
  // Legacy state (no pausedBy) was paused by the quit itself, so it resumes too.
  resumeAfterScreen() {
    if (this.saved.completed || this.saved.step !== 'screen' || !this.saved.screenRequested || this.system().screen !== 'granted') return false;
    if (this.saved.paused && this.saved.pausedBy === 'user') return false;
    this.saved.paused = false; delete this.saved.pausedBy; this.saved.step = 'screen'; this.advance();
    return true;
  }
  maybeRun() { if (!this.autoEligible()) return false; this.reload(); this.resumeAfterScreen(); if (this.saved.completed || this.saved.paused) return false; return this.show(); }
  pause() { this.saved.paused = true; this.saved.pausedBy = 'user'; this.save(); }
  quittingNow() { return this.quitting || !!this.mgr.quitting; }
  // Import from other browsers at any time, without moving or reopening setup.
  showImport() {
    if (!this.eligible()) return false;
    this.only = 'import'; this.result = null; this.progress = '';
    if (this.view && !this.view.isDestroyed()) { this.push(); this.view.show(); this.view.focus(); return true; }
    return this.show({ only: 'import' });
  }
  show(options = {}) {
    if (!this.eligible()) return false;
    if (!options.only && this.only) { this.only = null; this.push(); }
    if (this.view && !this.view.isDestroyed()) { this.view.show(); this.view.focus(); return true; }
    if (options.only) return this.open();
    // Non-modal: skipping setup never prevents normal browsing.
    if (this.saved.completed) { this.saved.completed = false; this.saved.step = 'welcome'; }
    this.saved.paused = false; delete this.saved.pausedBy; this.save();
    return this.open();
  }
  open() {
    const options = { width: 740, height: 650, title: 'Set up Olive', webPreferences: { preload: path.join(__dirname, '../ui/onboarding-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } };
    const focused = this.mgr.focusedWindow?.();
    const owner = focused?.isPrivate ? this.mgr.windows.find(w=>!w.isPrivate) || this.mgr.newWindow({}) : focused;
    const view = this.view = this.Panel ? new this.Panel(options) : new (require('./inline-page').InlinePage)(owner, options);
    view.setMenu(null);
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    Promise.resolve(view.loadFile(path.join(__dirname, '../ui/onboarding.html'))).then(()=>{if(!view.isDestroyed())view.focus();});
    view.on('closed', () => {
      if (this.view === view) this.view = null;
      const standalone = !!this.only; this.only = null;
      // Only a person closing setup pauses it; quitting keeps the saved step so the next launch resumes.
      if (!standalone && !this.saved.completed && !this.quittingNow()) this.pause();
      this.mgr.broadcast?.();
    });
    this.mgr.broadcast?.();
    return true;
  }
  close() { if (this.view && !this.view.isDestroyed()) this.view.close(); }
  // Call after the manager has switched dataPath/profileInfo; no module-global state.
  reset() { this.close(); this.sources = []; this.result = null; this.progress = ''; this.reload(); }
  advance() {
    let n = STEPS.indexOf(this.saved.step) + 1;
    const status = this.system();
    for (;;) {
      if (STEPS[n] === 'calls' && status.microphone === 'granted' && status.camera === 'granted') n++;
      else if (STEPS[n] === 'screen' && status.screen === 'granted') n++;
      else break;
    }
    this.saved.step = STEPS[Math.min(n, STEPS.length - 1)]; this.save();
  }
  getImporter() {
    if (!this.importer) {
      try { this.importer = require('./browser-import'); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; throw new Error('Browser import is not available in this build. You can skip it and import later.'); }
    }
    return this.importer;
  }
  async discover() {
    // Discovery only lists profiles; it never opens cookies or the Keychain.
    // Only IDs/names/capabilities reach the renderer; source paths remain in main.
    const found = await this.getImporter().discoverBrowsers();
    this.sources = (Array.isArray(found) ? found : found.browsers || []).map(b => ({ ...b, id: String(b.id), name: String(b.name || b.id), profiles: (b.profiles || []).map(p => ({ ...p, id: String(p.id ?? p.dir), name: String(p.name || p.id || p.dir), available: { history: false, bookmarks: false, cookies: p.supported !== false && b.supported !== false } })) }));
  }
  async command(action, payload = {}) {
    if (!this.eligible()) throw new Error('Setup is not available for this profile');
    if (action === 'get') return this.state();
    if (this.busy) throw new Error('Please wait for the current step to finish.');
    this.busy = true;
    const generation = this.generation;
    const ensureActive = () => { if (generation !== this.generation || this.file !== path.join(this.mgr.dataPath, 'onboarding.json')) throw new Error('The active profile changed. Reopen setup in that profile.'); };
    try {
      if (this.only && ['next', 'skip', 'back', 'later', 'finish'].includes(action)) { this.close(); }
      else if (action === 'next' || action === 'skip') this.advance();
      else if (action === 'back') { this.saved.step = STEPS[Math.max(0, STEPS.indexOf(this.saved.step) - 1)]; this.save(); }
      else if (action === 'later') { this.pause(); this.close(); }
      else if (action === 'finish') { this.saved.completed = true; this.saved.step = 'done'; this.save(); this.close(); this.mgr.focusedWindow?.()?.openPalette('new'); }
      else if (action === 'calls') {
        if (this.saved.step !== 'calls' || payload.confirmed !== true) throw new Error('Confirm the macOS permission warning first.');
        // The service asks only for not-determined grants. Do not stop after a
        // microphone denial: camera is independently useful and independently gated.
        await this.mgr.permissions.osMedia(['audio']); ensureActive();
        await this.mgr.permissions.osMedia(['video']); ensureActive();
        this.saved.callsRequested = true; this.save();
      } else if (action === 'screen') {
        if (this.saved.step !== 'screen' || payload.confirmed !== true) throw new Error('Confirm the screen recording warning first.');
        await this.mgr.permissions.registerScreenAccess(); ensureActive();
        this.saved.screenRequested = true; this.save();
        await this.electron.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      } else if (action === 'system') {
        if (!['microphone', 'camera', 'screen'].includes(payload.kind)) throw new Error('Unknown system permission');
        const pane = { microphone: 'Microphone', camera: 'Camera', screen: 'ScreenCapture' }[payload.kind];
        await this.electron.shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
      } else if (action === 'relaunch') {
        if (!this.saved.screenRequested) throw new Error('Set up screen access before relaunching.');
        if (this.electron.dialog) {
          const owner = this.view?.owner?.win || this.mgr.focusedWindow?.()?.win;
          const result = await this.electron.dialog.showMessageBox(owner, {type:'none',message:'Quit and reopen Olive?',detail:'Your tabs are saved. Active calls and unsaved page work may be interrupted. Setup finishes when Olive reopens.',buttons:['Cancel','Quit and Reopen'],defaultId:0,cancelId:0});
          if (result.response !== 1) return this.state();
          ensureActive();
        } else if (payload.confirmed !== true) throw new Error('Confirm relaunch first.');
        this.saved.step = STEPS[STEPS.indexOf('screen') + 1]; this.saved.paused = false; delete this.saved.pausedBy; this.save();
        this.electron.app.relaunch(); this.electron.app.quit();
      } else if (action === 'discover') {
        await this.discover(); ensureActive();
      } else if (action === 'import') {
        if (this.state().step !== 'import') throw new Error('Open the import step first.');
        const selections = [];
        for (const selection of Array.isArray(payload.selections) ? payload.selections : []) {
          const browser = this.sources.find(b => b.id === selection.browserId);
          const profile = browser?.profiles.find(p => p.id === selection.profileId);
          if (!profile) throw new Error('That browser profile is no longer available. Scan again.');
          const types = ['history', 'bookmarks', 'cookies'].filter(t => selection[t] === true && profile.available?.[t] !== false);
          if (types.length) selections.push({ browserId: browser.id, profileId: profile.id, types });
        }
        if (!selections.length) throw new Error('Choose at least one item to import.');
        if (selections.some(s => s.types.includes('cookies')) && payload.keychainConfirmed !== true) throw new Error('Confirm the Keychain warning before importing sign-ins.');
        this.progress = 'Importing selected data…'; this.push();
        // Capture the session now: a later profile switch cannot redirect cookies.
        const session = this.mgr.session;
        const report = await this.getImporter().importSelected(session, selections.map(s => s.profileId));
        ensureActive();
        this.result = { ...report, summary: `${report.imported || 0} cookies copied · ${report.existing || 0} existing cookies kept · ${report.failed || 0} skipped or failed. ${report.profiles?.filter(p => p.error).map(p => `${p.browser} / ${p.profile}: ${p.error}`).join(' ') || ''}` };
        this.progress = ''; this.saved.imported = true; this.save();
      } else throw new Error('Unknown setup action');
    } finally { if (generation === this.generation) this.busy = false; }
    this.mgr.broadcast?.();
    return this.state();
  }
  push() { this.mgr.broadcast?.(); if (this.view && !this.view.isDestroyed()) this.view.webContents.send('olive:onboarding-state', this.state()); }
}
module.exports = { Onboarding, STEPS };
