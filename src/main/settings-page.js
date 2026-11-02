// One Settings page (olive://settings): a trusted inline page in the browser pane with
// tabs General | Keyboard Shortcuts | Activities | Extensions. Each tab is its own local
// document loaded into the same page; the controllers that own the data (shortcuts.js,
// site-time.js, extension-settings.js, permissions.js) answer only this page's main frame.
// Every old entry point (menu items, palette commands, olive:// aliases) lands here.
const { ipcMain, shell } = require('electron');
const path = require('node:path');
const { AppPanel } = require('./app-panel');
const TU = require('../core/tab-unload');
const { TABS, TAB_TITLES, validTab, settingsUrl } = require('../core/settings-url');

const FILES = { general: 'settings-general.html', shortcuts: 'shortcuts.html', activities: 'site-time.html', extensions: 'extensions.html' };

class SettingsPage {
  constructor(mgr) {
    this.mgr = mgr;
    this.view = null;
    this.tab = null;
    this.section = null;
    this.origin = null; // the site that was on screen when Settings opened (Site permissions)
    ipcMain.handle('olive:settings', async (event, action, payload = {}) => {
      if (!this.trusted(event)) return null;
      payload = payload && typeof payload === 'object' ? payload : {};
      try { return await this.handle(action, payload); }
      catch (error) { return { ...this.state(), error: error.message }; }
    });
  }
  trusted(event) {
    const view = this.view;
    return !!(view && !view.isDestroyed() && !view.owner.isPrivate && !view.owner.destroyed && event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame);
  }
  state() {
    const s = this.mgr.settings;
    return {
      tab: this.tab, section: this.section, tabs: TABS.map(id => ({ id, title: TAB_TITLES[id], url: settingsUrl(id) })),
      unload: {
        values: this.mgr.unloadState(), defaults: { ...TU.DEFAULTS }, limits: { ...TU.LIMITS }, prefillMax: TU.PREFILL_MAX,
        exempt: TU.EXEMPT.map(id => TU.EXEMPT_LABELS[id]),
      },
      agent: { cdp: !!s.cdp, agentApi: s.agentApi !== false, cdpActive: !!this.mgr.agentInfo().cdpEnabled, apiPort: this.mgr.apiPort || null },
      permissions: this.mgr.permissions.globalState(this.origin),
    };
  }
  async handle(action, payload) {
    switch (action) {
      case 'get': return this.state();
      case 'tab': this.load(validTab(payload.tab)); return null;
      case 'close': this.close(); return null;
      case 'set': {
        if (![...TU.KEYS, 'cdp', 'agentApi'].includes(payload.key)) throw new Error('unknown setting');
        this.mgr.setSetting(payload.key, payload.value);
        return this.state();
      }
      case 'permission': this.mgr.permissions.setGlobal(payload.origin, payload.key, payload.value); return this.state();
      case 'forgetSite': this.mgr.permissions.forgetSite(payload.origin); return this.state();
      case 'macos': {
        const pane = { microphone: 'Microphone', camera: 'Camera', screen: 'ScreenCapture' }[payload.kind];
        if (!pane) throw new Error('unknown device');
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
        return this.state();
      }
      case 'ledger': { const owner = this.view.owner; this.close(); owner.cmd('ledger'); return null; }
      default: return null;
    }
  }
  // push fresh state to the General tab (a setting changed from the menu or the api)
  push() {
    const view = this.view;
    if (view && !view.isDestroyed() && !view.webContents.isDestroyed() && this.tab === 'general') view.webContents.send('olive:settings-state', this.state());
  }
  // owner: an OliveWindow. private windows can't host it: the last normal window (or a new one) does.
  show(owner = this.mgr.focusedWindow(), tab = 'general', { section = null } = {}) {
    if (!owner || owner.isPrivate || owner.destroyed) {
      owner = this.mgr.windows.filter(w => !w.isPrivate && !w.destroyed).pop() || this.mgr.newWindow({});
      owner.win.show(); owner.win.focus();
    }
    tab = validTab(tab);
    if (this.view && !this.view.isDestroyed() && this.view.owner === owner) {
      this.section = section;
      if (this.tab !== tab || section) this.load(tab);
      this.view.show(); this.view.focus();
      return this.view;
    }
    this.close();
    const active = owner.tabs.get(owner.activeId);
    this.origin = active?.url || null;
    this.section = section;
    const view = this.view = new AppPanel(owner, {
      title: 'Settings', captureEscape: true,
      webPreferences: { preload: path.join(__dirname, '../ui/settings-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // the controllers behind the tabs answer this page only
    const unbind = this.mgr.shortcuts.bind(view);
    const es = this.mgr.extensionSettings; if (es) es.view = view;
    this.mgr.siteTime?.adopt(view);
    view.once('closed', () => {
      unbind();
      if (es && es.view === view) es.view = null;
      if (this.view === view) { this.view = null; this.tab = null; }
    });
    this.load(tab);
    return view;
  }
  load(tab) {
    const view = this.view;
    if (!view || view.isDestroyed()) return;
    this.tab = tab;
    // the shortcut recorder needs every key combination, Escape included; other tabs keep
    // menu shortcuts (cmd+w, cmd+,) and Escape closes the page
    view.webContents.setIgnoreMenuShortcuts(tab === 'shortcuts');
    view.options.captureEscape = tab === 'shortcuts' || tab === 'activities'; // these documents handle Escape themselves
    view.webContents.loadFile(path.join(__dirname, '../ui', FILES[tab]), { query: this.section ? { section: this.section } : {} }).catch(() => {});
    view.owner.sendState();
  }
  close() { if (this.view && !this.view.isDestroyed()) this.view.close(); this.view = null; this.tab = null; }
}

module.exports = { SettingsPage, FILES };
