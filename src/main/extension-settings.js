// Trusted inline Extensions page (Olive > Extensions…, palette "Extensions").
// Lists bundled extensions; toggles go through the Extensions controller so the
// sidebar and the saved prefs stay in one place. No network requests.
const { ipcMain } = require('electron');
const path = require('node:path');
const { AppPanel } = require('./app-panel');
const { extensionRows } = require('../core/extension-prefs');

class ExtensionSettings {
  constructor(mgr) {
    this.mgr = mgr;
    this.view = null;
    ipcMain.handle('olive:extensions', async (event, action, payload = {}) => {
      if (!this.trusted(event)) return null;
      payload = payload && typeof payload === 'object' ? payload : {};
      return this.handle(action, payload);
    });
  }
  get extensions() { return this.mgr.extensions; }
  trusted(event) {
    const view = this.view;
    return !!(view && !view.isDestroyed() && !view.owner.isPrivate && event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame);
  }
  rows() {
    const x = this.extensions;
    if (!x) return [];
    return extensionRows([{ ...x.status, icon: x.icon || null }]);
  }
  async handle(action, payload) {
    const x = this.extensions;
    if (action === 'get') return this.rows();
    if (!x || payload.id !== x.status.id) throw new Error('unknown extension');
    if (action === 'set') {
      if (typeof payload.value !== 'boolean') throw new Error('extension setting must be boolean');
      if (payload.key === 'enabled') await x.setEnabled(payload.value);
      else if (payload.key === 'showInToolbar') x.setShowInToolbar(payload.value);
      else throw new Error('unknown extension setting');
      return this.rows();
    }
    if (action === 'options') {
      const owner = this.view.owner;
      if (!(await x.probeOptions())) return { ok: false, message: `${x.status.name}’s options page can’t start in Olive yet: it needs the extension’s background worker. Blocking is unaffected.` };
      if (this.view?.owner !== owner || owner.destroyed) return { ok: false, message: '' };
      x.openOptions(owner);
      return { ok: true };
    }
    throw new Error('unknown action');
  }
  // Called by the Extensions controller whenever its status changes.
  push() {
    const view = this.view;
    if (view && !view.isDestroyed() && !view.webContents.isDestroyed()) view.webContents.send('olive:extensions-state', this.rows());
  }
  show(owner = this.mgr.focusedWindow?.()) {
    if (!owner || owner.isPrivate || owner.destroyed || owner.win.isDestroyed()) return;
    if (this.view && !this.view.isDestroyed() && this.view.owner === owner) { this.view.show(); this.view.focus(); return; }
    this.close();
    const view = this.view = new AppPanel(owner, {
      title: 'Extensions',
      webPreferences: { preload: path.join(__dirname, '../ui/extensions-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.once('closed', () => { if (this.view === view) this.view = null; });
    view.loadFile(path.join(__dirname, '../ui/extensions.html'));
    return view;
  }
  close() { if (this.view && !this.view.isDestroyed()) this.view.close(); this.view = null; }
}
module.exports = { ExtensionSettings };
