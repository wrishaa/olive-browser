// Activity Event Log (olive://ledger): a normal tab. IPC answers only the main frame of an
// olive://ledger tab in a normal window (InternalPages.sender); dialogs sheet on its window.
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { TYPES, RETENTION } = require('../core/ledger');
const managers = new Set();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  ipcMain.handle('olive:ledger', async (e, action, payload = {}) => {
    let from = null;
    for (const mgr of managers) { from = mgr.internal?.sender(e, 'ledger'); if (from) break; }
    if (!from) return null;
    payload = payload && typeof payload === 'object' ? payload : {};
    const owner = from.win, mgr = owner.mgr;
    const ledger = mgr.ledger;
    if (!ledger) return null;
    const still = () => !owner.destroyed && mgr.ledger === ledger && from.tab.wc && !from.tab.wc.isDestroyed();
    if (action === 'configure') ledger.configure({ enabled: payload.enabled, retentionDays: payload.retentionDays });
    if (action === 'delete') {
      const count = ledger.matching(payload.filter).length;
      const result = await dialog.showMessageBox(owner.win, { type: 'warning', message: `Delete ${count} activity events?`, detail: 'This cannot be undone. Browsing history is not affected.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 });
      if (result.response === 1 && still()) ledger.remove(payload.filter);
    }
    if (action === 'export') {
      const format = payload.format === 'csv' ? 'csv' : 'json';
      const result = await dialog.showSaveDialog(owner.win, { defaultPath: `olive-activity.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (!result.canceled && result.filePath && still()) {
        // No file paths come from the renderer; chmod existing exports too.
        try {
          const fd = fs.openSync(result.filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, ledger.export(format, payload.filter)); } finally { fs.closeSync(fd); }
        } catch { return { error: 'Could not export activity' }; }
      }
    }
    if (!['get', 'configure', 'delete', 'export'].includes(action)) return null;
    const filter = payload.filter || {};
    return { events: ledger.list(filter), total: ledger.matching(filter).length, settings: ledger.settings, types: TYPES, retention: RETENTION, error: ledger.error };
  });
}
// the menu / palette entry: focus an open olive://ledger tab, else open one
function show(owner) {
  if (!owner?.mgr?.ledger || !owner.mgr.internal) return null;
  managers.add(owner.mgr); install();
  return owner.mgr.internal.open('olive://ledger', { win: owner, reuse: () => true });
}
class LedgerUI {
  constructor(mgr) { this.mgr = mgr; managers.add(mgr); install(); }
  show(owner = this.mgr.focusedWindow?.()) { return owner ? show(owner) : null; }
  close() {}
  dispose() { managers.delete(this.mgr); }
}
module.exports = { LedgerUI, show };
