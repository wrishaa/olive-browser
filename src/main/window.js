// one olive window: a BaseWindow with a ui view (sidebar, palette, chrome) at the
// bottom and one WebContentsView per loaded tab placed on top as rounded cards.
const { BaseWindow, WebContentsView, Menu, clipboard, shell, nativeTheme, app } = require('electron');
const path = require('path');
const { TabMRU } = require('./tab-mru');
const { COMMANDS } = require('./shortcuts');
const { matchesInput, holdForInput, holdReleased } = require('./shortcut-input');
const { toUrl, displayHost, SEARCH } = require('../core/url');
const { commandSuggestions, isAppCommand } = require('../core/app-commands');

const UI_HTML = path.join(__dirname, '..', 'ui', 'index.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload.js');

const M = 8; // outer margin around content cards
const GAP = 8; // gap between split panes
const FIND_H = 44;
const RADIUS = 10;

let nextTabId = 1;
let nextWinId = 1;
let nextSplitId = 1;

class Tab {
  constructor(win, d = {}) {
    this.id = nextTabId++;
    this.win = win;
    this.url = d.url || '';
    this.title = d.title || '';
    this.favicon = d.favicon || '';
    this.pinned = !!d.pinned;
    this.view = null;
    this.loading = false;
    this.audible = false;
    this.muted = false;
    this.crashed = false;
    this.devtools = null; // WebContentsView hosting devtools
    this.devtoolsRatio = 0.42;
    this.splitId = null;
    this.targetId = null;
    this.errorFor = null;
    this.lastActive = d.lastActive || 0;
  }

  get wc() {
    const wc = this.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  snapshot() {
    const wc = this.wc;
    return {
      id: this.id,
      title: this.title || displayHost(this.url) || 'New Tab',
      url: this.url,
      host: displayHost(this.url),
      favicon: this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: wc ? wc.isAudioMuted() : this.muted,
      pinned: this.pinned,
      splitId: this.splitId,
      crashed: this.crashed,
      unloaded: !wc,
      devtools: !!this.devtools,
    };
  }
}

class OliveWindow {
  constructor(mgr, opts = {}) {
    this.mgr = mgr;
    this.id = nextWinId++;
    this.isPrivate = !!opts.private;
    this.session = this.isPrivate ? mgr.privateSession(this.id) : mgr.session;
    const s = opts.state || {};
    this.sidebarWidth = clamp(s.sidebarWidth || 252, 180, 440);
    this.sidebarHidden = !!s.sidebarHidden;
    this.tabs = new Map();
    this.pinned = []; // tab ids
    this.unpinned = []; // tab ids
    this.splits = new Map(); // splitId -> {ids, ratios}
    this.activeId = null;
    this.tabMRU = new TabMRU();
    this.closedStack = [];
    this.overlay = null; // 'palette' | 'peek' | null
    this.uiOnTop = false;
    this.find = { open: false, query: '', active: 0, matches: 0 };
    this.htmlFullscreenId = null;
    this.panes = [];
    this.uiReady = false;
    this.stateTimer = null;
    this.destroyed = false;

    const b = s.bounds || {};
    this.win = new BaseWindow({
      width: b.width || 1360,
      height: b.height || 880,
      x: b.x,
      y: b.y,
      minWidth: 640,
      minHeight: 420,
      title: this.isPrivate ? 'Olive (private)' : 'Olive',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      transparent: false,
      show: false,
    });

    this.ui = new WebContentsView({
      webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    this.wireTabKeys(this.ui.webContents);
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(UI_HTML, { query: { private: this.isPrivate ? '1' : '' } });
    this.ui.webContents.on('did-finish-load', () => {
      this.uiReady = true;
      this.syncWindowButtons();
      this.sendState();
      if (this.tabs.size === 0 && !this.inlinePage) this.openPalette('new');
    });
    this.ui.webContents.setWindowOpenHandler(({ url }) => {
      this.createTab({ url, activate: true });
      return { action: 'deny' };
    });
    this.ui.webContents.on('will-navigate', (e) => e.preventDefault());

    this.win.on('resize', () => this.layout());
    // macOS may restore its titlebar buttons during a full-screen transition.
    // Suppress them for the transition, then reapply our sidebar-only policy.
    this.win.on('will-enter-full-screen', () => { this.fullscreenTransition = true; this.syncWindowButtons(); });
    this.win.on('will-leave-full-screen', () => { this.fullscreenTransition = true; this.syncWindowButtons(); });
    this.win.on('enter-full-screen', () => { this.fullscreenTransition = false; this.syncWindowButtons(true); this.layout(); this.sendState(); });
    this.win.on('leave-full-screen', () => { this.fullscreenTransition = false; this.syncWindowButtons(true); this.layout(); this.sendState(); });
    this.win.on('focus', () => { mgr.focused = this; });
    this.win.on('blur', () => this.finishTabWalk());
    this.win.on('move', () => this.mgr.saveSoon());
    this.win.on('close', () => this.mgr.onWindowClosing(this));
    this.win.on('closed', () => this.destroy());

    if (s.tabs) this.restore(s);
    this.layout();
    // agent-opened windows appear without activating olive or taking focus
    if (opts.inactive) this.win.showInactive();
    else {
      this.win.show();
      mgr.focused = this;
    }
  }

  // Only metadata, and never private windows. The manager owns the profile ledger.
  recordActivity(type, details = {}) {
    if (!this.isPrivate) this.mgr.ledger?.record(type, { ...details, windowId: this.id });
  }

  // ---------- tabs ----------

  restore(s) {
    const byKey = new Map();
    for (const t of s.tabs) {
      const tab = new Tab(this, t);
      this.tabs.set(tab.id, tab);
      byKey.set(t.key, tab);
      (tab.pinned ? this.pinned : this.unpinned).push(tab.id);
    }
    for (const sp of s.splits || []) {
      const ids = sp.keys.map((k) => byKey.get(k)).filter(Boolean).map((t) => t.id);
      if (ids.length < 2) continue;
      const sid = nextSplitId++;
      this.splits.set(sid, { ids, ratios: normRatios(sp.ratios, ids.length) });
      for (const id of ids) this.tabs.get(id).splitId = sid;
    }
    this.tabMRU.order = [...this.tabs.values()].sort((a, b) => b.lastActive - a.lastActive).map(t => t.id);
    const active = byKey.get(s.activeKey);
    if (active) this.activate(active.id);
  }

  serialize() {
    const tabs = [];
    for (const id of [...this.pinned, ...this.unpinned]) {
      const t = this.tabs.get(id);
      if (!t || !t.url) continue;
      tabs.push({ key: t.id, url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, lastActive: t.lastActive });
    }
    const splits = [...this.splits.values()].map((sp) => ({ keys: sp.ids, ratios: sp.ratios }));
    return {
      bounds: this.win.isDestroyed() ? undefined : this.win.getNormalBounds(),
      sidebarWidth: this.sidebarWidth,
      sidebarHidden: this.sidebarHidden,
      tabs,
      splits,
      activeKey: this.activeId,
    };
  }

  allIds() {
    return [...this.pinned, ...this.unpinned];
  }

  createTab({ url = '', activate = true, focusPage = true, afterId = null, index = null, pinned = false, webContents = null, webPreferences = null, title = '' } = {}) {
    const tab = new Tab(this, { url, pinned, title });
    this.tabs.set(tab.id, tab);
    const list = pinned ? this.pinned : this.unpinned;
    let at = 0;
    if (index != null) at = clamp(index, 0, list.length);
    else if (afterId != null) {
      const i = list.indexOf(afterId);
      at = i >= 0 ? i + 1 : 0;
      // keep opener's split group contiguous
      const opener = this.tabs.get(afterId);
      if (i >= 0 && opener && opener.splitId) {
        let j = i;
        while (j + 1 < list.length && this.tabs.get(list[j + 1])?.splitId === opener.splitId) j++;
        at = j + 1;
      }
    }
    list.splice(at, 0, tab.id);
    this.recordActivity('tab-open', { tabId: tab.id, url });
    this.ensureView(tab, { webContents, webPreferences });
    if (activate) this.activate(tab.id, { focusPage });
    else this.changed();
    return tab;
  }

  ensureView(tab, { webContents = null, webPreferences = null } = {}) {
    if (tab.wc) return tab;
    let view;
    if (webContents) {
      view = new WebContentsView({ webContents, webPreferences: webPreferences || undefined });
    } else {
      view = new WebContentsView({
        webPreferences: {
          session: this.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: true,
          scrollBounce: true,
          safeDialogs: true,
        },
      });
    }
    tab.view = view;
    tab.crashed = false;
    tab.targetId = null;
    view.setBorderRadius(RADIUS);
    view.setBackgroundColor('#ffffffff');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    if (this.uiOnTop) this.win.contentView.addChildView(this.ui);
    this.wireTab(tab);
    if (tab.muted) view.webContents.setAudioMuted(true);
    if (!webContents && tab.url) {
      this.mgr.applyUserAgent(view.webContents, tab.url);
      view.webContents.loadURL(tab.url).catch(() => {});
    }
    return tab;
  }

  wireTab(tab) {
    const wc = tab.view.webContents;
    this.wireTabKeys(wc);
    wc.setVisualZoomLevelLimits(1, 4).catch(() => {});

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (disposition === 'new-window' && features) {
        // real popup (oauth, payment): keep it a window so window.opener works
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: this.session, sandbox: true, contextIsolation: true } },
        };
      }
      if (disposition === 'save-to-disk' || disposition === 'other') return { action: 'deny' };
      return {
        action: 'allow',
        createWindow: (options) => {
          const t = this.createTab({
            url,
            activate: disposition !== 'background-tab',
            afterId: tab.id,
            webContents: options.webContents,
            webPreferences: options.webPreferences,
          });
          return t.view.webContents;
        },
      };
    });

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.mgr.history.update(tab.url, { title });
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, favs) => {
      tab.favicon = favs[0] || '';
      this.mgr.history.update(tab.url, { favicon: tab.favicon });
      this.changed();
    });
    wc.on('did-start-loading', () => { tab.loading = true; this.changed(); });
    wc.on('did-stop-loading', () => { tab.loading = false; this.changed(); });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.mgr.applyUserAgent(wc, details.url);
      if (details.isMainFrame && !details.isSameDocument && !details.url.startsWith('data:text/html;olive-error')) tab.errorFor = null;
    });
    wc.on('did-navigate', (_e, url) => {
      if (url.startsWith('data:text/html;olive-error')) return;
      if (!tab.committedUrl || displayHost(url) !== displayHost(tab.committedUrl)) tab.favicon = '';
      tab.committedUrl = url;
      tab.url = url;
      if (!this.isPrivate) this.mgr.history.add(url, wc.getTitle());
      this.recordActivity('visit', { tabId: tab.id, url });
      if (this.find.open && tab.id === this.activeId) this.closeFind();
      this.changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (!this.isPrivate) this.mgr.history.add(url, wc.getTitle());
      this.recordActivity('visit', { tabId: tab.id, url, sameDocument: true });
      this.changed();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = aborted
      tab.errorFor = url;
      tab.url = url;
      tab.title = displayHost(url);
      const html = errorPage(url, code, desc);
      wc.loadURL('data:text/html;olive-error;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
      this.changed();
    });
    wc.on('audio-state-changed', (e) => { tab.audible = e.audible; this.changed(); });
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreenId = tab.id;
      if (this.overlay) this.setOverlay(null);
      this.wasFullScreen = this.win.isFullScreen();
      if (!this.wasFullScreen) this.win.setFullScreen(true);
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreenId = null;
      if (!this.wasFullScreen && this.win.isFullScreen()) this.win.setFullScreen(false);
      this.layout();
    });
    wc.on('found-in-page', (_e, r) => {
      if (tab.id !== this.activeId) return;
      this.find.matches = r.matches;
      this.find.active = r.activeMatchOrdinal;
      this.sendState();
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      tab.crashed = true;
      tab.loading = false;
      this.changed();
    });
    // clicking into a split pane makes it the active tab (url bar, shortcuts)
    wc.on('before-mouse-event', (_e, m) => {
      if (m.type !== 'mouseDown') return;
      if (tab.id !== this.activeId && this.visibleIds().includes(tab.id)) {
        this.finishTabWalk();
        this.recordActivity('tab-activate', { tabId: tab.id, url: tab.url });
        this.activeId = tab.id;
        this.tabMRU.touch(tab.id);
        tab.lastActive = Date.now();
        this.changed();
      }
    });
    wc.on('context-menu', (_e, params) => this.pageMenu(tab, params));
    wc.on('devtools-closed', () => this.dropDevtools(tab));
    wc.on('zoom-changed', (_e, dir) => this.zoom(tab, dir === 'in' ? 0.5 : -0.5));
    wc.on('destroyed', () => {
      if (tab.view && tab.view.webContents === wc) {
        // webcontents died under us (e.g. page called window.close())
        if (this.tabs.has(tab.id) && !this.destroyed) setImmediate(() => this.closeTab(tab.id, { fromPage: true }));
      }
    });
    wc.on('close', () => {}); // window.close() from page: 'destroyed' handles cleanup
  }

  // focusPage: false selects the tab without moving keyboard focus into it (agent
  // api: never touch focus in a window the user isn't in).
  activate(id, { mruPreview = false, focusPage = true } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.inlinePage?.close();
    if (!mruPreview) this.finishTabWalk();
    this.ensureView(tab);
    this.mgr.agentWake?.sleep(tab); // shown for real now: drop agent size/focus overrides
    if (tab.crashed) tab.wc.reload();
    if (this.find.open && id !== this.activeId) this.closeFind(false);
    if (this.activeId !== id) this.recordActivity('tab-activate', { tabId: tab.id, url: tab.url });
    this.activeId = id;
    if (!mruPreview) { this.tabMRU.touch(id); tab.lastActive = Date.now(); }
    // load other members of the split too
    if (tab.splitId) for (const sid of this.splits.get(tab.splitId).ids) this.ensureView(this.tabs.get(sid));
    this.layout();
    if (focusPage && this.overlay !== 'palette') tab.wc.focus();
    this.changed();
  }

  closeTab(id, { fromPage = false, force = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.finishTabWalk();
    this.recordActivity('tab-close', { tabId: tab.id, url: tab.url });
    if (tab.pinned && !fromPage && !force) {
      // arc-style: closing a pinned tab unloads it but keeps it in the sidebar
      this.unload(tab);
      if (this.activeId === id) this.activeId = null;
      this.pickNextActive(id);
      this.layout();
      this.changed();
      return;
    }
    if (tab.url && !tab.errorFor) {
      const list = tab.pinned ? this.pinned : this.unpinned;
      this.closedStack.push({ url: tab.url, title: tab.title, favicon: tab.favicon, index: list.indexOf(id) });
      if (this.closedStack.length > 50) this.closedStack.shift();
    } else if (tab.errorFor) {
      this.closedStack.push({ url: tab.errorFor, title: tab.title, favicon: '', index: this.unpinned.indexOf(id) });
    }
    const wasActive = this.activeId === id;
    const split = tab.splitId ? this.splits.get(tab.splitId) : null;
    const siblings = split ? split.ids.filter((x) => x !== id) : [];
    this.removeFromSplit(id);
    const list = tab.pinned ? this.pinned : this.unpinned;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    this.unload(tab);
    this.tabs.delete(id);
    this.tabMRU.remove(id);
    if (wasActive) {
      this.activeId = null;
      if (siblings.length) this.activate(siblings[0]);
      else this.pickNextActive(id, list, idx);
    }
    this.layout();
    this.changed();
    if (this.tabs.size === 0 && !this.destroyed) this.openPalette('new');
  }

  pickNextActive(_closedId, list = this.unpinned, idx = 0) {
    if (this.activeId) return;
    let next = list[idx] ?? list[idx - 1];
    if (next == null) {
      // most recently used loaded tab
      const loaded = [...this.tabs.values()].filter((t) => t.wc).sort((a, b) => b.lastActive - a.lastActive);
      next = loaded[0]?.id;
    }
    if (next != null) this.activate(next);
  }

  unload(tab) {
    if (tab.view) this.recordActivity('tab-unload', { tabId: tab.id, url: tab.url });
    this.dropDevtools(tab);
    if (tab.view) {
      const view = tab.view;
      tab.view = null;
      tab.loading = false;
      tab.audible = false;
      try { this.win.contentView.removeChildView(view); } catch {}
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  reopenClosed() {
    const c = this.closedStack.pop();
    if (!c) return;
    this.createTab({ url: c.url, title: c.title, index: c.index });
  }

  moveTab(id, list, index) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const group = tab.splitId ? [...this.splits.get(tab.splitId).ids] : [id];
    const src = tab.pinned ? this.pinned : this.unpinned;
    const dstPinned = list === 'pinned';
    const dst = dstPinned ? this.pinned : this.unpinned;
    // index is computed by the ui against dst without the dragged items
    for (const g of group) {
      const i = src.indexOf(g);
      if (i >= 0) src.splice(i, 1);
    }
    const at = clamp(index, 0, dst.length);
    dst.splice(at, 0, ...group);
    for (const g of group) this.tabs.get(g).pinned = dstPinned;
    this.changed();
  }

  setPinned(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab || tab.pinned === pinned) return;
    this.moveTab(id, pinned ? 'pinned' : 'unpinned', pinned ? this.pinned.length : 0);
  }

  duplicate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.createTab({ url: tab.url, afterId: tab.pinned ? null : id });
  }

  clearUnpinned() {
    for (const id of [...this.unpinned]) this.closeTab(id);
  }

  closeOthers(id) {
    for (const x of [...this.unpinned]) if (x !== id) this.closeTab(x);
  }

  // ---------- split view ----------

  visibleIds() {
    const tab = this.tabs.get(this.activeId);
    if (!tab || !tab.wc) return [];
    if (tab.splitId) return this.splits.get(tab.splitId).ids.filter((id) => this.tabs.get(id)?.wc);
    return [tab.id];
  }

  split(aId, bId) {
    const a = this.tabs.get(aId);
    const b = this.tabs.get(bId);
    if (!a || !b || aId === bId) return;
    if (b.splitId && b.splitId === a.splitId) return;
    this.removeFromSplit(bId);
    let sp;
    if (a.splitId) {
      sp = this.splits.get(a.splitId);
      if (sp.ids.length >= 4) return;
      sp.ids.push(bId);
      sp.ratios = normRatios(null, sp.ids.length);
      b.splitId = a.splitId;
    } else {
      const sid = nextSplitId++;
      sp = { ids: [aId, bId], ratios: [0.5, 0.5] };
      this.splits.set(sid, sp);
      a.splitId = b.splitId = sid;
    }
    // keep the group contiguous in a's list, where a's group was
    const list = a.pinned ? this.pinned : this.unpinned;
    const group = new Set(sp.ids);
    const firstIdx = list.findIndex((id) => group.has(id) && id !== bId);
    const insertAt = list.slice(0, Math.max(0, firstIdx)).filter((id) => !group.has(id)).length;
    for (const l of [this.pinned, this.unpinned]) {
      for (let i = l.length - 1; i >= 0; i--) if (group.has(l[i])) l.splice(i, 1);
    }
    list.splice(insertAt, 0, ...sp.ids);
    for (const id of sp.ids) this.tabs.get(id).pinned = a.pinned;
    this.ensureView(b);
    this.activate(bId);
  }

  removeFromSplit(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.splitId) return;
    const sid = tab.splitId;
    const sp = this.splits.get(sid);
    tab.splitId = null;
    if (!sp) return;
    sp.ids = sp.ids.filter((x) => x !== id);
    if (sp.ids.length < 2) {
      for (const x of sp.ids) this.tabs.get(x).splitId = null;
      this.splits.delete(sid);
    } else sp.ratios = normRatios(null, sp.ids.length);
  }

  unsplit(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.splitId) return;
    const sp = this.splits.get(tab.splitId);
    for (const x of sp.ids) this.tabs.get(x).splitId = null;
    this.splits.delete(tab.splitId);
    this.activate(id);
  }

  setSplitRatios(splitId, ratios) {
    const sp = this.splits.get(splitId);
    if (!sp || ratios.length !== sp.ids.length) return;
    sp.ratios = normRatios(ratios, sp.ids.length);
    this.layout();
    this.sendState();
    this.mgr.saveSoon();
  }

  openInSplit(url, fromTab) {
    const base = fromTab || this.tabs.get(this.activeId);
    const t = this.createTab({ url, activate: false, afterId: base?.id });
    if (base) this.split(base.id, t.id);
    else this.activate(t.id);
  }

  // ---------- devtools ----------

  toggleDevtools(tab = this.tabs.get(this.activeId)) {
    if (!tab || !tab.wc) return;
    if (tab.devtools) {
      tab.wc.closeDevTools();
      this.dropDevtools(tab);
    } else this.openDevtools(tab);
  }

  openDevtools(tab) {
    if (!tab.wc || tab.devtools) return;
    const dv = new WebContentsView();
    this.wireTabKeys(dv.webContents);
    dv.setBorderRadius(RADIUS);
    dv.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#ff202124' : '#ffffffff');
    this.win.contentView.addChildView(dv);
    if (this.uiOnTop) this.win.contentView.addChildView(this.ui);
    tab.devtools = dv;
    tab.wc.setDevToolsWebContents(dv.webContents);
    tab.wc.openDevTools({ mode: 'detach', activate: false });
    this.layout();
    this.changed();
  }

  dropDevtools(tab) {
    const dv = tab.devtools;
    if (!dv) return;
    tab.devtools = null;
    try { this.win.contentView.removeChildView(dv); } catch {}
    if (dv.webContents && !dv.webContents.isDestroyed()) dv.webContents.close();
    this.layout();
    this.changed();
  }

  inspect(tab, x, y) {
    if (!tab.wc) return;
    if (!tab.devtools) this.openDevtools(tab);
    tab.wc.inspectElement(x, y);
  }

  setDevtoolsRatio(id, r) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.devtoolsRatio = clamp(r, 0.18, 0.82);
    this.layout();
    this.sendState();
  }

  // ---------- navigation ----------

  navigate(tab, input) {
    const url = toUrl(input);
    if (!url || !tab) return;
    this.recordActivity(url.startsWith(SEARCH) ? 'search' : 'navigation', { tabId: tab.id, url, action: 'navigate', ...(url.startsWith(SEARCH) ? { engine: 'google' } : {}) });
    this.ensureView(tab);
    tab.url = url;
    this.mgr.applyUserAgent(tab.wc, url);
    tab.wc.loadURL(url).catch(() => {});
    tab.wc.focus();
    this.changed();
  }

  zoom(tab, delta) {
    if (!tab?.wc) return;
    const wc = tab.wc;
    wc.setZoomLevel(delta === 0 ? 0 : clamp(wc.getZoomLevel() + delta, -6, 9));
  }

  reload(tab, hard = false) {
    if (!tab) return;
    this.recordActivity('navigation', { tabId: tab.id, url: tab.url, action: 'reload' });
    if (!tab.wc) return this.activate(tab.id);
    if (tab.errorFor) return void tab.wc.loadURL(tab.errorFor).catch(() => {});
    hard ? tab.wc.reloadIgnoringCache() : tab.wc.reload();
  }

  // ---------- find ----------

  openFind() {
    const tab = this.tabs.get(this.activeId);
    if (!tab?.wc) return;
    this.find.open = true;
    this.layout();
    this.sendState();
    this.ui.webContents.focus();
    this.send('focus-find');
  }

  doFind(query, { forward = true, findNext = false } = {}) {
    const tab = this.tabs.get(this.activeId);
    if (!tab?.wc) return;
    this.find.query = query;
    if (!query) {
      tab.wc.stopFindInPage('clearSelection');
      this.find.matches = 0;
      this.find.active = 0;
      this.sendState();
      return;
    }
    // electron's `findNext` means "start a new find session" (true for the first request),
    // the opposite of what the name suggests. ours means "go to the next match".
    tab.wc.findInPage(query, { forward, findNext: !findNext });
  }

  closeFind(focus = true) {
    const tab = this.tabs.get(this.activeId);
    if (tab?.wc) tab.wc.stopFindInPage('keepSelection');
    this.find = { open: false, query: this.find.query, active: 0, matches: 0 };
    this.layout();
    this.sendState();
    if (focus && tab?.wc) tab.wc.focus();
  }

  // ---------- overlays ----------

  openPalette(mode = 'new', value = '') {
    this.inlinePage?.close();
    this.setOverlay('palette');
    this.ui.webContents.focus();
    this.send('palette', { mode, value });
  }

  setOverlay(kind) {
    if (kind === 'peek' && (!this.sidebarHidden || this.htmlFullscreenId)) return;
    this.overlay = kind;
    this.syncWindowButtons();
    const top = !!kind;
    if (top !== this.uiOnTop) {
      this.uiOnTop = top;
      if (top) this.win.contentView.addChildView(this.ui);
      else this.win.contentView.addChildView(this.ui, 0);
    }
    if (!kind) {
      const tab = this.tabs.get(this.activeId);
      if (tab?.wc && !this.find.open) tab.wc.focus();
    }
    this.mgr.permissions.layout(this);
    this.inlinePage?.layout();
    this.appPanel?.layout();
    this.mgr.siteTime?.refresh();
    this.sendState();
  }

  toggleSidebar() {
    this.sidebarHidden = !this.sidebarHidden;
    if (!this.sidebarHidden && this.overlay === 'peek') this.setOverlay(null);
    this.layout();
    this.changed();
  }

  setSidebarWidth(w) {
    this.sidebarWidth = clamp(Math.round(w), 180, 440);
    this.layout();
    this.sendState();
    this.mgr.saveSoon();
  }

  // Native traffic lights belong to the sidebar, never to the page below it.
  // Leave macOS full-screen titlebar presentation to the system; keeping our
  // inset buttons hidden there also avoids a second set over the page.
  syncWindowButtons(force = false) {
    if (process.platform !== 'darwin' || this.destroyed || this.win.isDestroyed()) return;
    const visible = this.uiReady && !this.htmlFullscreenId && !this.fullscreenTransition && !this.win.isFullScreen()
      && (!this.sidebarHidden || this.overlay === 'peek');
    if (force || visible !== this.windowButtonsVisible) {
      this.win.setWindowButtonVisibility(visible);
      this.windowButtonsVisible = visible;
    }
  }

  // ---------- layout ----------

  // the rect a single unsplit tab would get on screen. hidden tabs the agent works
  // in are emulated at this size during a step (agent-wake.js).
  hiddenPaneRect() {
    if (this.destroyed || this.win.isDestroyed()) return null;
    const { width: w, height: h } = this.win.getContentBounds();
    const left = this.sidebarHidden ? M : this.sidebarWidth;
    return roundRect({ x: left, y: M, width: Math.max(100, w - left - M), height: Math.max(100, h - M - M) });
  }

  layout() {
    if (this.destroyed || this.win.isDestroyed()) return;
    this.syncWindowButtons();
    const { width: w, height: h } = this.win.getContentBounds();
    this.ui.setBounds({ x: 0, y: 0, width: w, height: h });
    const visible = this.visibleIds();
    const placed = new Map(); // tab id -> {page, devtools}
    this.panes = [];

    const fsTab = this.htmlFullscreenId && visible.includes(this.htmlFullscreenId) ? this.tabs.get(this.htmlFullscreenId) : null;
    if (fsTab) {
      placed.set(fsTab.id, { page: { x: 0, y: 0, width: w, height: h }, radius: 0 });
    } else if (this.inlinePage && !this.inlinePage.isDestroyed()) {
      const rect = this.inlinePage.geometry();
      this.panes = [{id:'setup',rect,page:rect,devtools:null}];
    } else if (visible.length) {
      const left = this.sidebarHidden ? M : this.sidebarWidth;
      const top = M + (this.find.open ? FIND_H : 0);
      const area = { x: left, y: top, width: Math.max(100, w - left - M), height: Math.max(100, h - top - M) };
      const tab0 = this.tabs.get(visible[0]);
      const ratios = tab0.splitId ? this.splits.get(tab0.splitId).ratios : [1];
      const usable = area.width - GAP * (visible.length - 1);
      let x = area.x;
      visible.forEach((id, i) => {
        const pw = i === visible.length - 1 ? area.x + area.width - x : Math.round(usable * (ratios[i] ?? 1 / visible.length));
        const rect = { x, y: area.y, width: pw, height: area.height };
        const tab = this.tabs.get(id);
        let page = rect;
        let dev = null;
        if (tab.devtools) {
          const dw = clamp(Math.round(rect.width * tab.devtoolsRatio), 240, rect.width - 200);
          page = { ...rect, width: rect.width - dw - GAP };
          dev = { x: rect.x + page.width + GAP, y: rect.y, width: dw, height: rect.height };
        }
        placed.set(id, { page, devtools: dev, radius: RADIUS });
        this.panes.push({ id, rect, page, devtools: dev, splitId: tab.splitId || null, index: i });
        x += pw + GAP;
      });
    }

    for (const tab of this.tabs.values()) {
      if (!tab.view) continue;
      const p = placed.get(tab.id);
      if (p) {
        tab.view.setBounds(roundRect(p.page));
        tab.view.setBorderRadius(p.radius);
        tab.view.setVisible(true);
      } else tab.view.setVisible(false);
      if (tab.devtools) {
        if (p && p.devtools) {
          tab.devtools.setBounds(roundRect(p.devtools));
          tab.devtools.setVisible(true);
        } else tab.devtools.setVisible(false);
      }
    }
    this.mgr.permissions.layout(this);
    this.inlinePage?.layout();
    this.appPanel?.layout();
    this.mgr.siteTime?.refresh();
  }

  // ---------- state to ui ----------

  changed() {
    this.mgr.siteTime?.refresh();
    this.mgr.saveSoon();
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, 16);
  }

  send(channel, data) {
    if (this.destroyed || !this.ui.webContents || this.ui.webContents.isDestroyed()) return;
    this.ui.webContents.send('olive:' + channel, data);
  }

  snapshot() {
    const active = this.tabs.get(this.activeId);
    const wc = active?.wc;
    const t = (id) => this.tabs.get(id)?.snapshot();
    return {
      windowId: this.id,
      private: this.isPrivate,
      sidebarWidth: this.sidebarWidth,
      sidebarHidden: this.sidebarHidden,
      fullscreen: this.win.isFullScreen(),
      overlay: this.overlay,
      activeId: this.activeId,
      visibleIds: this.visibleIds(),
      pinned: this.pinned.map(t),
      unpinned: this.unpinned.map(t),
      splits: Object.fromEntries([...this.splits].map(([k, v]) => [k, v])),
      panes: this.panes,
      find: this.find,
      htmlFullscreen: !!this.htmlFullscreenId,
      appPage: ['settings','activities'].includes(this.inlinePage?.kind) ? {title:this.inlinePage.options.title||'Settings'} : null,
      onboarding: !this.isPrivate && this.mgr.onboarding?.eligible() && !this.mgr.onboarding.saved.completed ? {active:this.inlinePage?.kind==='setup', step:this.mgr.onboarding.saved.step, remaining:Math.max(0,4-['welcome','calls','screen','import','done'].indexOf(this.mgr.onboarding.saved.step))} : null,
      active: !this.inlinePage && active
        ? {
            id: active.id,
            url: active.errorFor || active.url,
            host: displayHost(active.errorFor || active.url),
            title: active.title,
            secure: /^https:/.test(active.url),
            loading: active.loading,
            canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
            canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
            devtools: !!active.devtools,
          }
        : null,
      downloads: this.mgr.downloads.slice(0, 6),
      agent: this.mgr.agentInfo(),
      closedCount: this.closedStack.length,
      extension: this.isPrivate ? null : this.mgr.extensions?.status,
    };
  }

  sendState() {
    if (!this.uiReady) return;
    this.send('state', this.snapshot());
  }

  // ---------- menus ----------

  pageMenu(tab, p) {
    const wc = tab.wc;
    if (!wc) return;
    const t = [];
    const sep = { type: 'separator' };
    if (p.linkURL) {
      t.push(
        { label: 'Open Link in New Tab', click: () => this.createTab({ url: p.linkURL, activate: false, afterId: tab.id }) },
        { label: 'Open Link in Split View', click: () => this.openInSplit(p.linkURL, tab) },
        { label: 'Open Link in New Window', click: () => this.mgr.newWindow({ url: p.linkURL, private: this.isPrivate }) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        sep,
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push(
        { label: 'Open Image in New Tab', click: () => this.createTab({ url: p.srcURL, activate: false, afterId: tab.id }) },
        { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
        sep,
      );
    }
    if (p.isEditable) {
      if (p.misspelledWord) {
        for (const s of p.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
        t.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, sep);
      }
      t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, sep);
    } else if (p.selectionText) {
      const q = p.selectionText.trim().replace(/\s+/g, ' ');
      const short = q.length > 24 ? q.slice(0, 24) + '…' : q;
      t.push({ role: 'copy' }, { label: `Search Google for “${short}”`, click: () => this.createTab({ url: SEARCH + encodeURIComponent(q), afterId: tab.id }) }, sep);
    }
    if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !p.selectionText) {
      t.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => this.reload(tab) },
        sep,
        { label: 'Copy Page URL', click: () => clipboard.writeText(tab.url) },
        { label: 'View Page Source', click: () => this.createTab({ url: 'view-source:' + tab.url, afterId: tab.id }) },
        sep,
      );
    }
    t.push({ label: 'Inspect Element', click: () => this.inspect(tab, p.x, p.y) });
    Menu.buildFromTemplate(t).popup({ window: this.win, frame: p.frame });
  }

  tabMenu(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const active = this.tabs.get(this.activeId);
    const sep = { type: 'separator' };
    const t = [
      { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => this.setPinned(id, !tab.pinned) },
      { label: 'Duplicate', click: () => this.duplicate(id) },
      { label: 'Copy Link', enabled: !!tab.url, click: () => clipboard.writeText(tab.url) },
      { label: 'Reload', click: () => this.reload(tab) },
      { label: tab.wc?.isAudioMuted() ? 'Unmute' : 'Mute', enabled: !!tab.wc, click: () => this.toggleMute(id) },
      sep,
    ];
    if (active && active.id !== id && !(tab.splitId && tab.splitId === active.splitId)) {
      t.push({ label: 'Open in Split View with Current Tab', click: () => this.split(active.id, id) });
    }
    if (tab.splitId) t.push({ label: 'Separate Split View', click: () => this.unsplit(id) }, { label: 'Remove from Split View', click: () => { this.removeFromSplit(id); this.activate(id); } });
    t.push(sep, { label: 'Open in New Window', enabled: !!tab.url, click: () => { const url = tab.url; this.closeTab(id); this.mgr.newWindow({ url, private: this.isPrivate }); } });
    t.push(sep);
    if (tab.pinned) t.push({ label: 'Unload', enabled: !!tab.wc, click: () => this.closeTab(id) }, { label: 'Remove Pinned Tab', click: () => { tab.pinned = false; this.pinned = this.pinned.filter((x) => x !== id); this.unpinned.unshift(id); this.closeTab(id); } });
    else t.push({ label: 'Unload (Free Memory)', enabled: !!tab.wc && !this.visibleIds().includes(id), click: () => { this.unload(tab); this.changed(); } }, { label: 'Close Tab', click: () => this.closeTab(id) }, { label: 'Close Other Tabs', click: () => this.closeOthers(id) });
    Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  toggleMute(id) {
    const tab = this.tabs.get(id);
    if (!tab?.wc) return;
    tab.muted = !tab.wc.isAudioMuted();
    tab.wc.setAudioMuted(tab.muted);
    this.changed();
  }

  // ---------- commands from ui / menu ----------

  cmd(type, a = {}) {
    const active = this.tabs.get(this.activeId);
    switch (type) {
      case 'closePanel': return this.appPanel?.close();
      case 'profiles': return this.mgr.profileControls?.show();
      case 'onboarding': return this.mgr.onboarding?.show();
      case 'onboardingLater': return this.mgr.onboarding?.command('later');
      case 'shortcuts': return this.mgr.shortcuts?.showSettings(this);
      case 'activities': return this.mgr.siteTime?.show(this);
      case 'settings': return this.mgr.shortcuts?.showSettings(this);
      case 'ledger': return this.mgr.ledgerUI ? this.mgr.ledgerUI.show(this) : require('./ledger-review').show(this);
      case 'ublock': return this.mgr.extensions?.open(this);
      case 'sitePermissions': return this.mgr.permissions.showSettings(this);
      case 'resetPermissions': this.mgr.permissions.reset(this); break;
      case 'newTab': return this.openPalette('new');
      case 'splitNew': return this.openPalette('split');
      case 'openLocation': return this.openPalette('edit', active ? active.errorFor || active.url : '');
      case 'closeTab':
        if (this.inlinePage) return this.inlinePage.close();
        if (this.overlay === 'palette') return this.setOverlay(null);
        if (this.find.open) return this.closeFind();
        if (!active) return this.win.close();
        return this.closeTab(active.id);
      case 'closeTabId': return this.closeTab(a.id);
      case 'activate': return this.activate(a.id);
      case 'reopenClosed': return this.reopenClosed();
      case 'back': if(this.inlinePage)return this.inlinePage.kind==='setup'?this.mgr.onboarding?.command('back'):this.inlinePage.close(); this.recordActivity('navigation', { tabId: active?.id, url: active?.url, action: 'back' }); return active?.wc?.navigationHistory.goBack();
      case 'forward': this.recordActivity('navigation', { tabId: active?.id, url: active?.url, action: 'forward' }); return active?.wc?.navigationHistory.goForward();
      case 'reload': return this.reload(active);
      case 'hardReload': return this.reload(active, true);
      case 'stop': return active?.wc?.stop();
      case 'devtools': return this.toggleDevtools(active);
      case 'console':
        if (!active?.wc) return;
        if (!active.devtools) this.openDevtools(active);
        return;
      case 'toggleSidebar': return this.toggleSidebar();
      case 'sidebarWidth': return this.setSidebarWidth(a.width);
      case 'zoomIn': return this.zoom(active, 0.5);
      case 'zoomOut': return this.zoom(active, -0.5);
      case 'zoomReset': return this.zoom(active, 0);
      case 'find': return this.openFind();
      case 'findQuery': return this.doFind(a.query, { forward: a.forward !== false, findNext: !!a.findNext });
      case 'findNext': if (!this.find.open) return this.openFind(); return this.doFind(this.find.query, { forward: true, findNext: true });
      case 'findPrev': if (!this.find.open) return this.openFind(); return this.doFind(this.find.query, { forward: false, findNext: true });
      case 'closeFind': return this.closeFind();
      case 'copyUrl': if (active) clipboard.writeText(active.url); return this.send('toast', 'Copied URL');
      case 'mruNext': this.walkTabs(1); return this.finishTabWalk();
      case 'mruPrev': this.walkTabs(-1); return this.finishTabWalk();
      case 'nextTab': return this.cycle(1);
      case 'prevTab': return this.cycle(-1);
      case 'selectIndex': return this.selectIndex(a.index);
      case 'togglePin': return active && this.setPinned(active.id, !active.pinned);
      case 'duplicate': return active && this.duplicate(active.id);
      case 'unsplit': return active && this.unsplit(active.id);
      case 'split': return this.split(a.a ?? this.activeId, a.b);
      case 'splitRatios': return this.setSplitRatios(a.splitId, a.ratios);
      case 'devtoolsRatio': return this.setDevtoolsRatio(a.id, a.ratio);
      case 'move': return this.moveTab(a.id, a.list, a.index);
      case 'tabMenu': return this.tabMenu(a.id);
      case 'mute': return this.toggleMute(a.id);
      case 'clearUnpinned': return this.clearUnpinned();
      case 'overlay': return this.setOverlay(a.kind || null);
      case 'submit': return this.submit(a);
      case 'showDownload': return a.path && shell.showItemInFolder(a.path);
      case 'openDownload': return a.path && shell.openPath(a.path);
      case 'clearDownloads':
        for (let i = this.mgr.downloads.length - 1; i >= 0; i--) if (this.mgr.downloads[i].state !== 'progressing') this.mgr.downloads.splice(i, 1);
        return this.mgr.broadcast();
      case 'focusActive': return active?.wc?.focus();
      case 'newWindow': return this.mgr.newWindow({});
      case 'newPrivateWindow': return this.mgr.newWindow({ private: true });
      case 'copyAgentInfo': clipboard.writeText(JSON.stringify(this.mgr.agentInfo(), null, 2)); return this.send('toast', 'Copied agent endpoints');
      default:
        console.warn('[olive] unknown cmd', type);
    }
  }

  submit({ mode, input, item, split: inSplit }) {
    this.setOverlay(null);
    if (item?.kind === 'command') {
      if (isAppCommand(item.commandId)) return this.cmd(item.commandId);
      return;
    }
    if (item && item.kind === 'tab') {
      const w = this.mgr.windows.find((x) => x.tabs.has(item.tabId));
      if (w) {
        w.win.focus();
        w.activate(item.tabId);
      }
      return;
    }
    const raw = item?.url || input;
    if (!raw) return;
    const url = toUrl(raw);
    if (url.startsWith(SEARCH) && mode !== 'edit') this.recordActivity('search', { url, engine: 'google' });
    const active = this.tabs.get(this.activeId);
    if (inSplit || mode === 'split') return this.openInSplit(url, active);
    if (mode === 'edit' && active) return this.navigate(active, url);
    this.createTab({ url });
  }

  wireTabKeys(wc) {
    wc.on('before-input-event', (event, input) => {
      if (this.tabMRU.walk && holdReleased(this.tabWalkHold, input)) this.finishTabWalk();
      if (input.type !== 'keyDown') return;
      // Resolve on every keystroke: remapping and profile switches take effect live.
      for (const [command, dir] of [['mruNext', 1], ['mruPrev', -1]]) {
        const accelerator = this.mgr.shortcuts
          ? this.mgr.shortcuts.accelerator(command)
          : COMMANDS.find(c => c.id === command).accelerator;
        if (!matchesInput(accelerator, input)) continue;
        event.preventDefault(); // suppress both the page key and native menu accelerator
        if (!this.tabMRU.walk) this.tabWalkHold = holdForInput(input);
        this.walkTabs(dir);
        break;
      }
    });
  }

  walkTabs(dir) {
    const id = this.tabMRU.step(this.allIds(), this.activeId, dir);
    if (id != null) this.activate(id, { mruPreview: true });
  }

  finishTabWalk() {
    this.tabWalkHold = null;
    if (!this.tabMRU.walk) return;
    this.tabMRU.finish(this.activeId);
    const tab = this.tabs.get(this.activeId);
    if (tab) tab.lastActive = Date.now();
    this.mgr.saveSoon?.();
  }

  cycle(dir) {
    const ids = this.allIds();
    if (!ids.length) return;
    let i = ids.indexOf(this.activeId);
    i = (i + dir + ids.length) % ids.length;
    this.activate(ids[i]);
  }

  selectIndex(n) {
    const ids = this.allIds();
    if (!ids.length) return;
    this.activate(n === 9 ? ids[ids.length - 1] : ids[Math.min(n - 1, ids.length - 1)]);
  }

  suggest(query) {
    const q = (query || '').trim();
    const out = commandSuggestions(q);
    if (q) {
      const url = toUrl(q);
      const isSearch = url.startsWith(SEARCH);
      out.push(isSearch ? { kind: 'search', title: q, url, sub: 'Search Google' } : { kind: 'url', title: url.replace(/^https?:\/\//, ''), url, sub: 'Open' });
    }
    const ql = q.toLowerCase();
    const tabs = [];
    for (const w of this.mgr.windows) {
      if (w.isPrivate !== this.isPrivate) continue;
      for (const t of w.tabs.values()) {
        if (!t.url) continue;
        if (!ql || t.title.toLowerCase().includes(ql) || t.url.toLowerCase().includes(ql)) tabs.push(t);
      }
    }
    tabs.sort((a, b) => b.lastActive - a.lastActive);
    for (const t of tabs.slice(0, q ? 4 : 5)) {
      if (t.id === this.activeId) continue;
      out.push({ kind: 'tab', tabId: t.id, title: t.title || t.url, url: t.url, favicon: t.favicon, sub: 'Switch to Tab' });
    }
    if (!this.isPrivate) {
      const seen = new Set(out.map((o) => o.url));
      for (const e of this.mgr.history.search(q, q ? 7 : 5)) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        out.push({ kind: 'history', title: e.title || e.url, url: e.url, favicon: e.favicon, sub: displayHost(e.url) });
      }
    }
    return out.slice(0, 10);
  }

  // ---------- teardown ----------

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const tab of this.tabs.values()) {
      if (tab.devtools?.webContents && !tab.devtools.webContents.isDestroyed()) tab.devtools.webContents.close();
      if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    if (this.ui.webContents && !this.ui.webContents.isDestroyed()) this.ui.webContents.close();
    this.mgr.onWindowClosed(this);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function roundRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
}

function normRatios(r, n) {
  if (!Array.isArray(r) || r.length !== n || r.some((x) => !(x > 0))) return Array(n).fill(1 / n);
  const s = r.reduce((a, b) => a + b, 0);
  return r.map((x) => Math.max(0.1, x / s));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(url, code, desc) {
  const host = displayHost(url);
  return `<!doctype html><meta charset=utf-8><title>${esc(host)}</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0;background:Canvas;color:CanvasText}
  .b{max-width:460px;padding:24px}
  h1{font-size:22px;margin:0 0 8px}
  p{opacity:.7;line-height:1.5;margin:0 0 6px}
  code{font:12px ui-monospace,monospace;opacity:.55}
</style>
<div class=b><h1>Can't open ${esc(host)}</h1><p>${esc(friendly(code, desc))}</p><code>${esc(desc)} (${code})</code></div>`;
}

function friendly(code, desc) {
  if (code === -105 || code === -137) return "The server's address couldn't be found. Check the spelling or your connection.";
  if (code === -106) return "You're offline.";
  if (code === -102) return 'The server refused the connection.';
  if (code === -118 || code === -7) return 'The server took too long to respond.';
  if (code <= -200 && code > -300) return "The site's security certificate isn't valid.";
  return 'The page failed to load. ' + desc;
}

module.exports = { OliveWindow, Tab };
