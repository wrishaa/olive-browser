// Permission callbacks live in main; only the trusted, bounded toast view can resolve them.
const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const labels = { media: 'camera / microphone', geolocation: 'your location', notifications: 'notifications', midiSysex: 'MIDI devices', 'clipboard-read': 'read your clipboard', 'clipboard-sanitized-write': 'write to your clipboard', 'display-capture': 'screen sharing', openExternal: 'open another app', 'idle-detection': 'idle detection', hid: 'HID devices', serial: 'serial devices', usb: 'USB devices', 'storage-access': 'cross-site storage', 'top-level-storage-access': 'cross-site storage', 'speaker-selection': 'audio output devices', keyboardLock: 'keyboard lock', 'window-management': 'window management', 'local-network-access': 'your local network' };
class Permissions {
  constructor(mgr) {
    this.mgr = mgr; this.pending = new Map(); this.views = new Map(); this.seq = 0; this.privateChoices = {};
    ipcMain.on('olive:permission', (e, id, allow) => {
      const p = this.pending.get(id);
      if (p && this.views.get(p.win)?.view.webContents === e.sender && typeof allow === 'boolean') this.finish(p, allow, true);
    });
  }
  keys(origin, permission, details = {}) {
    if (permission !== 'media') return [`${origin}|${permission}`];
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    return (types.length ? [...new Set(types)].sort() : ['unknown']).map(t => `${origin}|media:${t}`);
  }
  install(ses, persist) {
    const choices = persist ? this.mgr.perms.data : this.privateChoices;
    ses.setPermissionCheckHandler((_wc, permission, rawOrigin, details) => {
      let origin; try { origin = new URL(rawOrigin).origin; } catch { return false; }
      if (permission === 'fullscreen' || permission === 'pointerLock') return true;
      return this.keys(origin, permission, details).every(k => choices[k] === true);
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
      if (permission === 'fullscreen' || permission === 'pointerLock') return callback(true);
      const win = this.mgr.windows.find(w => [...w.tabs.values()].some(t => t.wc === wc));
      let origin; try { origin = new URL(details.requestingUrl || wc?.getURL()).origin; } catch { return callback(false); }
      if (!win || !wc || wc.isDestroyed() || origin === 'null') return callback(false);
      const keys = this.keys(origin, permission, details);
      if (keys.some(k => choices[k] === false)) return callback(false);
      if (keys.every(k => choices[k] === true)) return callback(true);
      const p = { id: ++this.seq, wc, win, origin, keys, callback, choices, persist, permission,
        label: permission === 'media' ? (details.mediaTypes || []).map(t => t === 'audio' ? 'microphone' : t === 'video' ? 'camera' : t).join(' and ') || labels.media : labels[permission] || permission };
      p.navigate = (e) => { if (!e.isSameDocument) this.finish(p, false, false); };
      p.destroy = () => this.finish(p, false, false);
      wc.on('did-start-navigation', p.navigate); wc.once('destroyed', p.destroy);
      this.pending.set(p.id, p); this.refresh(win);
    });
  }
  finish(p, allow, remember) {
    if (!this.pending.delete(p.id)) return;
    p.wc.removeListener('did-start-navigation', p.navigate); p.wc.removeListener('destroyed', p.destroy);
    if (remember) { for (const key of p.keys) p.choices[key] = allow; if (p.persist) this.mgr.perms.save(); }
    try { p.callback(allow); } catch {}
    this.refresh(p.win);
  }
  reset(win) {
    const tab = win?.tabs.get(win.activeId); let origin;
    try { origin = new URL(tab.wc?.getURL() || tab.url).origin; } catch { return; }
    for (const p of [...this.pending.values()]) if (p.origin === origin) this.finish(p, false, false);
    for (const choices of [this.mgr.perms.data, this.privateChoices]) for (const k of Object.keys(choices)) if (k.startsWith(origin + '|')) delete choices[k];
    this.mgr.perms.save(); win.send('toast', `Permissions reset for ${origin}. Reload the page to ask again.`);
  }
  refresh(win) {
    if (win.destroyed || win.win.isDestroyed()) return;
    const items = [...this.pending.values()].filter(p => p.win === win).map(({ id, origin, label }) => ({ id, origin, label }));
    let entry = this.views.get(win);
    if (!entry && items.length) {
      const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '../ui/permission-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      view.setBackgroundColor('#00000000');
      entry = { view, items, ready: false }; this.views.set(win, entry);
      view.webContents.on('will-navigate', e => e.preventDefault());
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.once('did-finish-load', () => { entry.ready = true; this.refresh(win); });
      view.webContents.loadFile(path.join(__dirname, '../ui/permissions.html'));
      win.win.once('closed', () => {
        for (const p of [...this.pending.values()]) if (p.win === win) this.finish(p, false, false);
        clearTimeout(entry.timer); this.views.delete(win);
        if (!view.webContents.isDestroyed()) view.webContents.close();
      });
    }
    if (!entry) return;
    clearTimeout(entry.timer); entry.items = items;
    if (entry.ready) entry.view.webContents.send('olive:permissions', items);
    if (items.length) this.layout(win);
    else entry.timer = setTimeout(() => {
      if (win.win.isDestroyed()) return;
      const focused = !entry.view.webContents.isDestroyed() && entry.view.webContents.isFocused();
      win.win.contentView.removeChildView(entry.view); entry.view.setVisible(false);
      if (focused) win.tabs.get(win.activeId)?.wc?.focus();
    }, 220);
  }
  layout(win) {
    const e = this.views.get(win); if (!e?.items.length || win.win.isDestroyed()) return;
    const { width, height } = win.win.getContentBounds();
    const h = Math.min(e.items.length * 132 + 24, Math.max(132, Math.floor(height * .6)));
    e.view.setBounds({ x: 12, y: Math.max(0, height - h - 12), width: Math.min(360, width - 24), height: h });
    e.view.setVisible(true); win.win.contentView.addChildView(e.view);
  }
}
module.exports = { Permissions };
