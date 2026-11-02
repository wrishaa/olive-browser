// Settings (olive://settings): a normal tab with real urls per section
//   olive://settings[/general] | /shortcuts | /activities | /extensions
// the section bar is plain links (back/forward, reload, split, pin all work like a site).
// the controllers that own the data (shortcuts.js, site-time.js, extension-settings.js,
// permissions.js) answer only the main frame of a Settings tab (InternalPages.sender).
// Every old entry point (menu items, palette commands, old olive:// names) lands here.
const { ipcMain, shell } = require('electron');
const TU = require('../core/tab-unload');
const { TABS, TAB_TITLES, validTab, settingsUrl, webOrigin } = require('../core/olive-url');

class SettingsPage {
  constructor(mgr) {
    this.mgr = mgr;
    this.origin = null; // the site on screen when Settings was last opened (Site permissions)
    ipcMain.handle('olive:settings', async (event, action, payload = {}) => {
      const from = this.trusted(event);
      if (!from) return null;
      payload = payload && typeof payload === 'object' ? payload : {};
      try { return await this.handle(action, payload, from); }
      catch (error) { return { ...this.state(from.page), error: error.message }; }
    });
  }
  trusted(event) { return this.mgr.internal.sender(event, 'settings'); }
  state(page = null) {
    const s = this.mgr.settings;
    const origin = webOrigin(page?.query?.origin || '') || this.origin;
    return {
      tab: page?.tab || 'general', section: page?.query?.section || null,
      tabs: TABS.map(id => ({ id, title: TAB_TITLES[id], url: settingsUrl(id) })),
      unload: {
        values: this.mgr.unloadState(), defaults: { ...TU.DEFAULTS }, limits: { ...TU.LIMITS }, prefillMax: TU.PREFILL_MAX,
        exempt: TU.EXEMPT.map(id => TU.EXEMPT_LABELS[id]),
      },
      agent: { cdp: !!s.cdp, agentApi: s.agentApi !== false, cdpActive: !!this.mgr.agentInfo().cdpEnabled, apiPort: this.mgr.apiPort || null },
      permissions: this.mgr.permissions.globalState(origin),
    };
  }
  async handle(action, payload, from) {
    switch (action) {
      case 'get': return this.state(from.page);
      case 'set': {
        if (![...TU.KEYS, 'cdp', 'agentApi'].includes(payload.key)) throw new Error('unknown setting');
        this.mgr.setSetting(payload.key, payload.value);
        return this.state(from.page);
      }
      case 'permission': this.mgr.permissions.setGlobal(payload.origin, payload.key, payload.value); return this.state(from.page);
      case 'forgetSite': this.mgr.permissions.forgetSite(payload.origin); return this.state(from.page);
      case 'macos': {
        const pane = { microphone: 'Microphone', camera: 'Camera', screen: 'ScreenCapture' }[payload.kind];
        if (!pane) throw new Error('unknown device');
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
        return this.state(from.page);
      }
      default: return null;
    }
  }
  // push fresh state to open General tabs (a setting changed from the menu, the api or
  // another Settings tab)
  push() {
    for (const { tab, page } of this.mgr.internal.tabs('settings', p => p.kind === 'page' && p.tab === 'general')) {
      if (tab.wc && !tab.wc.isDestroyed()) tab.wc.send('olive:settings-state', this.state(page));
    }
  }
  // owner: the OliveWindow it was asked from. tab undefined (cmd+,): focus any Settings tab
  // as it is; a named tab also navigates it there. private windows: a normal window.
  show(owner = this.mgr.focusedWindow(), tab, { section = null, origin = null } = {}) {
    const active = owner && !owner.isPrivate ? owner.tabs.get(owner.activeId) : null;
    const seen = webOrigin(active?.url || '');
    if (seen) this.origin = seen;
    return this.mgr.internal.openSettings(tab === undefined ? undefined : validTab(tab), { section, origin, win: owner });
  }
  close() {}
}

module.exports = { SettingsPage };
