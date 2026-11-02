// Foreground accounting and the Activities section of Settings (olive://settings/activities,
// a normal tab). No network requests.
const { ipcMain, dialog, powerMonitor } = require('electron');
const path = require('node:path');
const { SiteTime, siteForURL, validSite, RANGES } = require('../core/site-time');

// live controllers (one per manager; a test may make several). the sender picks its own.
const controllers = new Set();
let installed = false;
function installIPC() {
  if (installed) return;
  installed = true;
  ipcMain.handle('olive:site-time', async (event, action, payload = {}) => {
    for (const controller of controllers) {
      const from = controller.trusted(event);
      if (from) return controller.handle(event, action, payload && typeof payload === 'object' ? payload : {}, from);
    }
    return null;
  });
}
function rasterData(value) {
  return typeof value === 'string' && value.length <= 262144 && /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=\r\n]+$/i.test(value) ? value : null;
}
function cachedFavicons(mgr, sites) {
  const result = new Map();
  const accept = entry => {
    const site = siteForURL(entry?.url), icon = rasterData(entry?.favicon);
    if (site && sites.has(site) && icon && !result.has(site)) result.set(site, icon);
  };
  // These values are already in memory. Do not fetch remote favicon URLs, even
  // with a cache hint: a cache miss must never disclose the Activities page.
  for (const owner of mgr.windows || []) if (!owner.isPrivate) for (const tab of owner.tabs?.values() || []) accept(tab);
  for (const entry of mgr.history?.map?.values() || []) accept(entry);
  return result;
}
function foregroundPage(mgr, { suspended = false, locked = false } = {}) {
  if (suspended || locked || mgr.quitting || mgr.switchingProfile) return null;
  // focusedWindow() intentionally remembers the last window even when Olive is
  // backgrounded. Native focus, not that fallback, is the authority here.
  const owner = (mgr.windows || []).find(owner => !owner.destroyed && owner.win && !owner.win.isDestroyed() && owner.win.isFocused());
  if (!owner || owner.isPrivate || !owner.win.isVisible() || owner.win.isMinimized() || owner.inlinePage || owner.appPanel || owner.overlay) return null;
  const tab = owner.tabs?.get(owner.activeId), wc = tab?.wc;
  if (!tab || tab.crashed || tab.errorFor || !wc || wc.isDestroyed() || !tab.view?.getVisible() || !owner.visibleIds().includes(tab.id)) return null;
  const bounds = tab.view.getBounds();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const url = wc.getURL(); // never attribute an uncommitted or failed target URL
  return siteForURL(url) ? { owner, tab, url } : null;
}

class SiteTimeController {
  constructor(mgr, options = {}) {
    this.mgr = mgr;
    this.options = options;
    this.disposed = false;
    this.suspended = false;
    this.locked = false;
    this.windowListeners = new Map();
    this.tabListeners = new Map();
    this.powerListeners = [];
    installIPC();
    controllers.add(this);
    this.loadTracker();
    for (const [name, handler] of [
      ['suspend', () => { this.pause(); this.suspended = true; }],
      ['resume', () => { this.suspended = false; this.tracker.update({ active: false }); this.refresh(); }],
      ['lock-screen', () => { this.pause(); this.locked = true; }],
      ['unlock-screen', () => { this.locked = false; this.tracker.update({ active: false }); this.refresh(); }],
    ]) {
      powerMonitor.on(name, handler);
      this.powerListeners.push([name, handler]);
    }
    for (const owner of mgr.windows || []) this.attachWindow(owner);
    if (options.tickMs !== 0) {
      this.timer = setInterval(() => {
        this.refresh();
        const now = this.tracker.monotonicNow();
        if (now - this.lastFlush >= 5000 || now < this.lastFlush) { this.tracker.flush(); this.lastFlush = now; }
      }, options.tickMs || 1000);
      this.timer.unref?.();
    }
  }
  loadTracker() {
    this.dataPath = this.mgr.dataPath;
    this.tracker = new SiteTime(path.join(this.dataPath, 'site-time.json'), this.options);
    this.lastFlush = this.tracker.monotonicNow();
  }
  attachWindow(owner) {
    if (this.disposed || this.windowListeners.has(owner) || !owner?.win || owner.win.isDestroyed()) return;
    const listeners = [];
    for (const name of ['focus', 'blur', 'minimize', 'restore', 'hide', 'show']) {
      const handler = () => this.refresh();
      owner.win.on(name, handler); listeners.push([name, handler]);
    }
    const closed = () => {
      this.detachWindow(owner);
      this.refresh();
    };
    owner.win.on('closed', closed); listeners.push(['closed', closed]);
    this.windowListeners.set(owner, listeners);
    this.refresh();
  }
  detachWindow(owner) {
    for (const [name, handler] of this.windowListeners.get(owner) || []) owner.win.removeListener(name, handler);
    this.windowListeners.delete(owner);
  }
  watchTabs() {
    const live = new Set();
    for (const owner of this.mgr.windows || []) for (const tab of owner.tabs?.values() || []) {
      const wc = tab.wc;
      if (!wc || wc.isDestroyed()) continue;
      live.add(wc);
      if (this.tabListeners.has(wc)) continue;
      const listeners = [];
      for (const name of ['did-navigate', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) {
        const handler = () => this.refresh();
        wc.on(name, handler); listeners.push([name, handler]);
      }
      this.tabListeners.set(wc, listeners);
    }
    for (const [wc, listeners] of this.tabListeners) if (!live.has(wc)) {
      for (const [name, handler] of listeners) wc.removeListener(name, handler);
      this.tabListeners.delete(wc);
    }
  }
  refresh() {
    if (this.disposed) return;
    this.watchTabs();
    const page = this.mgr.dataPath === this.dataPath ? foregroundPage(this.mgr, this) : null;
    this.tracker.update({ url: page?.url, active: !!page, isPrivate: !!page?.owner.isPrivate });
  }
  pause() {
    if (this.disposed) return;
    this.tracker.update({ active: false });
    this.tracker.flush();
  }
  reload() {
    if (this.disposed) return;
    // an open Activities tab of the old profile is refused by trusted() (dataPath check)
    this.tracker.close();
    this.loadTracker();
    this.refresh();
  }
  state(range) {
    this.refresh();
    const state = this.tracker.snapshot(range);
    const icons = cachedFavicons(this.mgr, new Set(state.entries.map(entry => entry.site)));
    state.entries = state.entries.map(entry => ({ ...entry, favicon: icons.get(entry.site) || null }));
    return state;
  }
  // only the main frame of a Settings > Activities tab in a normal window of this profile
  trusted(event) {
    if (this.disposed || this.mgr.dataPath !== this.dataPath || this.mgr.switchingProfile) return null;
    const from = this.mgr.internal?.sender(event, 'settings', { tab: 'activities' });
    return from && from.win.mgr === this.mgr && !from.win.win.isDestroyed() ? from : null;
  }
  async handle(event, action, payload, from) {
    const range = RANGES.includes(payload.range) ? payload.range : 'today';
    if (action === 'get') return this.state(range);
    if (action === 'open') {
      const site = payload.site;
      if (!validSite(site) || !this.tracker.hasSite(site)) return null;
      // a new tab next to Activities; Settings stays where it is (back is one click away)
      from.win.createTab({ url: `https://${site}/`, activate: true, afterId: from.tab.id });
      return null;
    }
    if (action !== 'reset') return null;
    const tracker = this.tracker;
    const answer = await dialog.showMessageBox(from.win.win, {
      type: 'warning', message: 'Reset all site time?',
      detail: 'This deletes site time for this profile on this device. Browsing history, cookies, tabs, and the activity event log are not affected. This cannot be undone.',
      buttons: ['Cancel', 'Reset Site Time'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // A sheet may outlive a profile switch, owner close, or replacement page.
    if (this.tracker !== tracker || !this.trusted(event)) return null;
    if (answer.response === 1) tracker.reset();
    return this.state(range);
  }
  // the Activities tab of Settings (src/main/settings-page.js)
  show(owner = this.mgr.focusedWindow?.()) { return this.mgr.settingsPage?.show(owner, 'activities'); }
  dispose() {
    if (this.disposed) return;
    // Mark disposed before closing a view: close/layout events must not restart.
    this.tracker.update({ active: false });
    this.disposed = true;
    controllers.delete(this);
    clearInterval(this.timer);
    for (const owner of [...this.windowListeners.keys()]) this.detachWindow(owner);
    for (const [wc, listeners] of this.tabListeners) for (const [name, handler] of listeners) wc.removeListener(name, handler);
    this.tabListeners.clear();
    for (const [name, handler] of this.powerListeners) powerMonitor.removeListener(name, handler);
    this.powerListeners = [];
    this.tracker.close();
  }
}
module.exports = { SiteTimeController, foregroundPage, cachedFavicons, rasterData };
