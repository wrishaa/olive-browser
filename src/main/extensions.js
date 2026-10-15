// Narrow uBO Lite spike: unmodified CWS package; native DNR only, no API shims.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const STORE_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
class Extensions {
  constructor(mgr) {
    this.mgr = mgr;
    this.status = { installed: false, enabled: false, name: 'uBO Lite', gap: 'Not installed. Run python3 -I scripts/download-ublock.py.' };
    this.popup = null;
    ipcMain.handle('olive:ublock', async (event, command) => {
      if (!this.popup || event.sender !== this.popup.webContents) throw new Error('not an extension control window');
      if (command === 'toggle') await this.setEnabled(!this.status.enabled);
      if (command === 'original') this.openOriginal();
      return this.status;
    });
  }
  async load(ses) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Olive Extensions/ublock.json'), 'utf8'));
      if (record.storeId !== STORE_ID) throw new Error('unexpected extension');
      const root = fs.realpathSync(record.path);
      const base = fs.realpathSync(path.join(os.homedir(), 'Library/Application Support/Olive Extensions'));
      if (!root.startsWith(base + path.sep)) throw new Error('extension outside package directory');
      // Verify exact download contents, reject extra files/symlinks. Never require() them.
      const found = [];
      const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, item.name);
        if (item.isSymbolicLink()) throw new Error('extension symlink');
        if (item.isDirectory()) walk(p);
        else if (item.isFile()) {
          const rel = path.relative(root, p);
          // Chromium writes compiled DNR caches beside the downloaded sources.
          if (!/^_metadata\/generated_indexed_rulesets\/_ruleset\d+$/.test(rel)) found.push(rel);
        }
        else throw new Error('invalid extension file');
      }};
      walk(root);
      // Electron removes CWS's verification metadata when loading unpacked files.
      const expected = Object.keys(record.files).filter(f => f !== '_metadata/verified_contents.json' || fs.existsSync(path.join(root, f)));
      if (found.length !== expected.length) throw new Error('extension contents changed');
      for (const file of found) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
        if (record.files[file] !== hash) throw new Error('extension integrity mismatch');
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      this.defaultRules = manifest.declarative_net_request.rule_resources.filter(r => r.enabled).map(r => r.id);
      this.ext = await ses.extensions.loadExtension(root);
      this.ses = ses;
      this.helper = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      this.helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await this.helper.loadURL(`chrome-extension://${this.ext.id}/popup.html`);
      this.status = { installed: true, enabled: false, name: 'uBO Lite', version: manifest.version, id: this.ext.id, storeId: STORE_ID, gap: 'Basic network rules only. Electron lacks chrome.permissions in the extension worker: the official popup, per-site modes, cosmetic filtering and picker are not working.' };
      const prefs = path.join(app.getPath('userData'), 'ublock-settings.json');
      this.prefs = prefs;
      let enabled = true;
      try { enabled = JSON.parse(fs.readFileSync(prefs, 'utf8')).enabled !== false; } catch {}
      await this.setEnabled(enabled);
    } catch (e) { this.status.error = e.message; console.error('[olive] ublock:', e.message); }
  }
  async setEnabled(enabled) {
    if (!this.ext || this.helper?.isDestroyed()) throw new Error('extension not loaded');
    // Use Chromium's real DNR API. Defaults aren't activated after the worker fails.
    // Explicit activation is NOT a webRequest filter or a simulated chrome API.
    const result = await this.helper.webContents.executeJavaScript(`(async()=>{
      const all=chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r=>r.id);
      await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds:all});
      if (${!!enabled}) await chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:${JSON.stringify(this.defaultRules)}});
      return chrome.declarativeNetRequest.getEnabledRulesets();
    })()`);
    this.status.enabled = result.length > 0;
    this.status.rulesets = result;
    fs.writeFileSync(this.prefs, JSON.stringify({ enabled: this.status.enabled }), { mode: 0o600 });
    this.mgr.broadcast();
    return this.status;
  }
  open(win) {
    if (!win || win.isPrivate) return;
    if (this.popup && !this.popup.isDestroyed()) return this.popup.focus();
    const bounds = win.win.getBounds();
    const popup = this.popup = new BrowserWindow({ width: 370, height: 345, x: bounds.x + 20, y: bounds.y + 90, title: 'uBO Lite — basic rules', parent: win.win, resizable: false, minimizable: false, maximizable: false, webPreferences: { preload: path.join(__dirname, '../ui/extension-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    popup.setMenu(null);
    popup.webContents.on('will-navigate', event => event.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.once('did-finish-load', () => popup.webContents.send('olive:ublock-state', this.status));
    popup.loadFile(path.join(__dirname, '../ui/extension.html'));
    popup.on('closed', () => { this.popup = null; win.cmd('focusActive'); });
  }
  openOriginal() {
    if (!this.ext) return;
    const w = new BrowserWindow({ width: 400, height: 500, title: 'Official uBO Lite popup (limited in Electron)', webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadURL(`chrome-extension://${this.ext.id}/popup.html`);
  }
}
module.exports = { Extensions };
