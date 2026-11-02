// Extensions tab of Settings (olive://settings/extensions; Olive > Extensions…, palette "Extensions").
// Lists bundled extensions; toggles go through the Extensions controller so the
// sidebar and the saved prefs stay in one place. No network requests.
const { ipcMain } = require('electron');
const { extensionRows } = require('../core/extension-prefs');

class ExtensionSettings {
  constructor(mgr) {
    this.mgr = mgr;
    ipcMain.handle('olive:extensions', async (event, action, payload = {}) => {
      const from = this.trusted(event);
      if (!from) return null;
      payload = payload && typeof payload === 'object' ? payload : {};
      return this.handle(action, payload, from);
    });
  }
  get extensions() { return this.mgr.extensions; }
  // only the main frame of a Settings > Extensions tab (olive://settings/extensions)
  trusted(event) { return this.mgr.internal?.sender(event, 'settings', { tab: 'extensions' }) || null; }
  rows() {
    const x = this.extensions;
    if (!x) return [];
    return extensionRows([{ ...x.status, icon: x.icon || null }]);
  }
  async handle(action, payload, from) {
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
      const owner = from.win;
      if (!(await x.probeOptions())) return { ok: false, message: `${x.status.name}’s options page didn’t finish loading. Blocking is unaffected.` };
      if (owner.destroyed) return { ok: false, message: '' };
      x.openOptions(owner);
      return { ok: true };
    }
    throw new Error('unknown action');
  }
  // Called by the Extensions controller whenever its status changes.
  push() { this.mgr.internal?.send('settings', 'olive:extensions-state', this.rows(), page => page.tab === 'extensions'); }
  // the Extensions tab of Settings
  show(owner = this.mgr.focusedWindow?.()) { return this.mgr.settingsPage?.show(owner, 'extensions'); }
  close() {}
}
module.exports = { ExtensionSettings };
