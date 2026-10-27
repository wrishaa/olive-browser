// Trusted app panel. IPC is bound to this exact main-frame WebContents, not tabs.
const { ipcMain, dialog } = require('electron');
const { AppPanel } = require('./app-panel');
const fs = require('fs');
const path = require('path');
const { TYPES, RETENTION } = require('../core/ledger');
const entries = new Map();
let installed = false;
function show(owner) {
  if (owner.isPrivate || !owner.mgr.ledger) return;
  for (const entry of entries.values()) if (entry.owner === owner) { entry.win.show(); entry.win.focus(); return; }
  if (!installed) {
    installed = true;
    ipcMain.handle('olive:ledger', async (e, action, payload = {}) => {
      const entry = entries.get(e.sender.id);
      if (!entry || e.sender !== entry.win.webContents || e.senderFrame !== entry.win.webContents.mainFrame || entry.owner.isPrivate) return null;
      if (action === 'close') { entry.win.close(); return null; }
      const ledger = entry.owner.mgr.ledger;
      if (action === 'configure') ledger.configure({ enabled: payload.enabled, retentionDays: payload.retentionDays });
      if (action === 'delete') {
        const count = ledger.matching(payload.filter).length;
        const result = await dialog.showMessageBox(entry.owner.win, { type: 'warning', message: `Delete ${count} activity events?`, detail: 'This cannot be undone. Browsing history is not affected.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 });
        if (result.response === 1 && !entry.win.isDestroyed() && entry.owner.mgr.ledger === ledger) ledger.remove(payload.filter);
      }
      if (action === 'export') {
        const format = payload.format === 'csv' ? 'csv' : 'json';
        const result = await dialog.showSaveDialog(entry.owner.win, { defaultPath: `olive-activity.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (!result.canceled && result.filePath && !entry.win.isDestroyed() && entry.owner.mgr.ledger === ledger) {
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
  const win = new AppPanel(owner, { width: 880, height: 600, title: 'activity ledger', webPreferences: { preload: path.join(__dirname, '../ui/ledger-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  entries.set(win.webContents.id, { owner, win });
  const id = win.webContents.id;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => entries.delete(id));
  win.loadFile(path.join(__dirname, '../ui/ledger.html'));
}
class LedgerUI {
  constructor(mgr) { this.mgr = mgr; }
  show(owner = this.mgr.focusedWindow?.()) { if (owner) show(owner); }
  close() {
    for (const entry of [...entries.values()]) if (entry.owner.mgr === this.mgr && !entry.win.isDestroyed()) entry.win.close();
  }
  dispose() { this.close(); }
}
module.exports = { LedgerUI, show };
