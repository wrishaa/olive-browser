// Extensions tab of Settings (olive://settings/extensions; Olive > Extensions…, palette "Extensions").
// Lists bundled extensions; toggles go through the Extensions controller so the
// sidebar and the saved prefs stay in one place. No network requests.
const { ipcMain } = require('electron');
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
      if (!(await x.probeOptions())) return { ok: false, message: `${x.status.name}’s options page didn’t finish loading. Blocking is unaffected.` };
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
  // the Extensions tab of Settings (src/main/settings-page.js sets this.view)
  show(owner = this.mgr.focusedWindow?.()) { return this.mgr.settingsPage?.show(owner, 'extensions'); }
  close() { if (this.view && !this.view.isDestroyed()) this.view.close(); this.view = null; }
}
module.exports = { ExtensionSettings };
