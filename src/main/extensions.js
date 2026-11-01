// Narrow uBO Lite spike: unmodified CWS package; native DNR only, no API shims.
const { app, BrowserWindow, ipcMain } = require('electron');
const { AppPanel } = require('./app-panel');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePrefs, serializePrefs } = require('../core/extension-prefs');
const STORE_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';

// CWS bytes are pinned in the app, never fetched or patched at first run.
// Electron mutates unpacked extension metadata, so load a verified profile-local copy.
function verifyPackage(root, record) {
  if (record.storeId !== STORE_ID || !record.files || typeof record.files !== 'object') throw new Error('unexpected extension');
  const found = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name), rel = path.relative(root, p).split(path.sep).join('/');
    if (item.isSymbolicLink()) throw new Error('extension symlink');
    if (item.isDirectory()) walk(p);
    else if (item.isFile()) {
      if (!/^_metadata\/generated_indexed_rulesets\/_ruleset\d+$/.test(rel)) found.push(rel);
    } else throw new Error('invalid extension file');
  }};
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('extension symlink');
  walk(root);
  const expected = Object.keys(record.files).filter(f => f !== '_metadata/verified_contents.json' || fs.existsSync(path.join(root, f)));
  if (found.length !== expected.length) throw new Error('extension contents changed');
  for (const file of found) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (record.files[file] !== hash) throw new Error('extension integrity mismatch');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.version !== record.version) throw new Error('unexpected manifest');
  return manifest;
}
function preparePackage(dataPath, bundle = app?.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked/vendor/ublock')
  : path.join(__dirname, '../../vendor/ublock')) {
  const record = JSON.parse(fs.readFileSync(path.join(bundle, 'record.json'), 'utf8'));
  const source = path.join(bundle, 'unpacked');
  verifyPackage(source, record);
  const root = path.join(dataPath, 'extensions', `ublock-${record.version}`);
  try { verifyPackage(root, record); } catch {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.cpSync(source, root, { recursive: true, dereference: false });
  }
  return { root, manifest: verifyPackage(root, record) };
}
class Extensions {
  constructor(mgr) {
    this.mgr = mgr;
    this.status = { installed: false, enabled: false, name: 'uBO Lite', gap: 'Starting the bundled network blocker…' };
    this.popup = this.originalPopup = null;
    ipcMain.handle('olive:ublock', async (event, command) => {
      if (!this.popup || event.sender !== this.popup.webContents) throw new Error('not an extension control window');
      if (command === 'close') { this.popup.close(); return this.status; }
      if (command === 'toggle') await this.setEnabled(!this.status.enabled);
      if (command === 'original') this.openOriginal();
      return this.status;
    });
  }
  async load(ses) {
    try {
      await this.dispose();
      this.prefs = path.join(this.mgr.dataPath || app.getPath('userData'), 'ublock-settings.json');
      const { root, manifest } = preparePackage(path.dirname(this.prefs));
      this.defaultRules = manifest.declarative_net_request.rule_resources.filter(r => r.enabled).map(r => r.id);
      this.ses = ses;
      // loadExtension resolves before all extension state is ready. uBOL can also
      // restart itself once after a failed worker start, invalidating open pages.
      this.newContext();
      this.onExtensionReady = (_event, ext) => {
        if (path.resolve(ext.path) !== path.resolve(root)) return;
        this.ext = ext;
        if (!this.context.pending) this.newContext();
        this.context.pending = false;
        this.context.resolve(ext);
        if (this.initialized) this.setEnabled(this.desiredEnabled).catch(error => this.fail(error));
      };
      this.onExtensionUnloaded = (_event, ext) => {
        if (path.resolve(ext.path) !== path.resolve(root)) return;
        this.newContext();
        this.status.enabled = false;
      };
      ses.extensions.on('extension-ready', this.onExtensionReady);
      ses.extensions.on('extension-unloaded', this.onExtensionUnloaded);
      this.helper = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      this.helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.ext = await ses.extensions.loadExtension(root);
      this.status = { installed: true, enabled: false, name: 'uBO Lite', version: manifest.version, id: this.ext.id, storeId: STORE_ID, gap: 'Basic network rules only. Electron lacks chrome.permissions in the extension worker: the official popup, per-site modes, cosmetic filtering and picker are not working.' };
      let saved = parsePrefs(null);
      try { saved = parsePrefs(fs.readFileSync(this.prefs, 'utf8')); } catch {}
      // The sidebar button is opt-in; blocking itself does not depend on it.
      this.status.showInToolbar = saved.showInToolbar;
      this.status.optionsPage = typeof manifest.options_page === 'string' ? manifest.options_page : null;
      this.icon = iconData(root, manifest);
      await this.setEnabled(saved.enabled);
      this.initialized = true;
    } catch (e) { this.fail(e); }
    return this.status;
  }
  fail(error) {
    this.status.installed = false; this.status.enabled = false;
    this.status.error = error.message;
    console.error('[olive] ublock:', error.message);
  }
  newContext() {
    this.context?.reject(new Error('Extension context invalidated.'));
    const context = { pending: true };
    context.promise = new Promise((resolve, reject) => { context.resolve = resolve; context.reject = reject; });
    // A reload may happen while no command is awaiting this generation.
    context.promise.catch(() => {});
    this.context = context;
  }
  async readyHelper() {
    const context = this.context;
    let timer;
    try {
      const ext = await Promise.race([context.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extension readiness timed out')), 10000);
      })]);
      if (context !== this.context) throw new Error('Extension context invalidated.');
      if (this.helperContext !== context) {
        await this.helper.loadURL(`chrome-extension://${ext.id}/popup.html`);
        const ready = await this.helper.webContents.executeJavaScript(`document.readyState === 'complete' && chrome.runtime.id === ${JSON.stringify(ext.id)} && !!chrome.runtime.getManifest().declarative_net_request`);
        if (!ready || context !== this.context) throw new Error('Extension context invalidated.');
        this.helperContext = context;
      }
      return context;
    } finally { clearTimeout(timer); }
  }
  async dispose() {
    this.initialized = false;
    this.context?.reject(new Error('extension not loaded'));
    if (this.ses) {
      if (this.onExtensionReady) this.ses.extensions.removeListener('extension-ready', this.onExtensionReady);
      if (this.onExtensionUnloaded) this.ses.extensions.removeListener('extension-unloaded', this.onExtensionUnloaded);
    }
    this.onExtensionReady = this.onExtensionUnloaded = this.context = this.helperContext = null;
    // Let an already-running operation observe cancellation before unloading.
    if (this.operation) await this.operation.catch(() => {});
    this.operation = null;
    if (this.popup && !this.popup.isDestroyed()) this.popup.close();
    if (this.originalPopup && !this.originalPopup.isDestroyed()) this.originalPopup.close();
    if (this.helper && !this.helper.isDestroyed()) this.helper.destroy();
    if (this.ext && this.ses) { try { await this.ses.extensions.removeExtension(this.ext.id); } catch {} }
    this.popup = this.originalPopup = this.helper = this.ext = this.ses = null;
    this.status = { installed: false, enabled: false, name: 'uBO Lite', gap: 'Starting the bundled network blocker…' };
  }
  setEnabled(enabled) {
    this.desiredEnabled = !!enabled;
    // UI commands and automatic post-restart activation must not race each other.
    const operation = (this.operation || Promise.resolve()).catch(() => {}).then(() => this.applyEnabled(!!enabled));
    this.operation = operation;
    return operation;
  }
  async applyEnabled(enabled) {
    if (!this.ext || !this.helper || this.helper.isDestroyed()) throw new Error('extension not loaded');
    // Use Chromium's real DNR API. Defaults aren't activated after the worker fails.
    // A context invalidation gets one event-driven retry, never a polling sleep.
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = this.context;
      try {
        await this.readyHelper();
        result = await this.helper.webContents.executeJavaScript(`(async()=>{
          const all=chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r=>r.id);
          await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds:all});
          if (${enabled}) await chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:${JSON.stringify(this.defaultRules)}});
          return chrome.declarativeNetRequest.getEnabledRulesets();
        })()`);
        if (context !== this.context) throw new Error('Extension context invalidated.');
        break;
      } catch (error) {
        if (attempt || !this.context || (context === this.context && !/Extension context invalidated/.test(error.message))) throw error;
        if (context === this.context) this.newContext();
      }
    }
    this.status.enabled = result.length > 0;
    this.status.rulesets = result;
    delete this.status.error;
    this.savePrefs();
    this.mgr.broadcast();
    return this.status;
  }
  savePrefs() {
    if (!this.prefs) return;
    fs.writeFileSync(this.prefs, serializePrefs({ enabled: typeof this.desiredEnabled === "boolean" ? this.desiredEnabled : this.status.enabled, showInToolbar: this.status.showInToolbar === true }), { mode: 0o600 });
  }
  setShowInToolbar(show) {
    if (typeof show !== 'boolean') throw new Error('extension setting must be boolean');
    if (!this.status.installed) throw new Error('extension not loaded');
    this.status.showInToolbar = show;
    this.savePrefs();
    this.mgr.broadcast();
    return this.status;
  }
  open(win) {
    if (!win || win.isPrivate || win.win.isDestroyed()) return;
    if (this.popup && !this.popup.isDestroyed()) {
      if (this.popup.owner === win) return this.popup.focus();
      this.popup.close();
    }
    const popup = this.popup = new AppPanel(win, { width: 370, height: 385, title: 'uBO Lite — basic rules', webPreferences: { preload: path.join(__dirname, '../ui/extension-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    popup.setMenu(null);
    popup.webContents.on('will-navigate', event => event.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.once('did-finish-load', () => popup.webContents.send('olive:ublock-state', this.status));
    popup.loadFile(path.join(__dirname, '../ui/extension.html'));
    popup.on('closed', () => { if (this.popup === popup) this.popup = null; });
  }
  openOriginal() {
    const win = this.mgr.focusedWindow();
    if (!this.ext || !win || win.isPrivate || win.win.isDestroyed()) return;
    if (this.originalPopup && !this.originalPopup.isDestroyed()) {
      if (this.originalPopup.owner === win) return this.originalPopup.focus();
      this.originalPopup.close();
    }
    const popup = this.originalPopup = new AppPanel(win, { width: 400, height: 540, title: 'Official uBO Lite popup (limited in Electron)', webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.loadURL(`chrome-extension://${this.ext.id}/popup.html`);
    popup.on('closed', () => { if (this.originalPopup === popup) this.originalPopup = null; });
  }
}
// Extension icon as a data URL from the verified local copy (never a remote fetch).
function iconData(root, manifest) {
  const icons = manifest.icons || manifest.action?.default_icon || {};
  const size = Object.keys(icons).map(Number).filter(n => n >= 32).sort((a, b) => a - b)[0] || Object.keys(icons).map(Number).sort((a, b) => b - a)[0];
  const rel = icons[size];
  if (typeof rel !== 'string' || !/\.png$/i.test(rel)) return null;
  const file = path.resolve(root, rel.replace(/^\/+/, ''));
  if (!file.startsWith(path.resolve(root) + path.sep)) return null;
  try { return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'); } catch { return null; }
}
module.exports = { Extensions, iconData, verifyPackage, preparePackage };
