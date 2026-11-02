// one olive window: a BaseWindow with a ui view (sidebar, palette, chrome) at the
// bottom and one WebContentsView per loaded tab placed on top as rounded cards.
const { BaseWindow, WebContentsView, Menu, clipboard, shell, nativeTheme, app } = require('electron');
const path = require('path');
const { TabMRU } = require('./tab-mru');
const { COMMANDS } = require('./shortcuts');
const { matchesInput, holdForInput, holdReleased, holdRepressed, cancelsWalk } = require('./shortcut-input');
const { toUrl, displayHost, SEARCH } = require('../core/url');
const { commandSuggestions, isAppCommand } = require('../core/app-commands');
const { parseSettingsUrl, isOliveUrl } = require('../core/olive-url');
const { blockedNavigation } = require('./internal-pages');
// sidebar icon for olive:// tabs (they have no site favicon)
const OLIVE_FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><ellipse cx="8" cy="8.5" rx="4.6" ry="6" transform="rotate(-30 8 8.5)" fill="#6b7f3a"/><circle cx="9.6" cy="6.2" r="1.3" fill="#c9d79a"/></svg>');
const TG = require('../core/tab-groups');
const TM = require('../core/tab-meta');

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
    this.title = d.title || ''; // the page's title
    this.customTitle = TM.cleanTitle(d.customTitle); // Rename Tab…: wins over the page title; '' = none
    this.favicon = d.favicon || '';
    this.pinned = !!d.pinned;
    // the url a pinned tab belongs to (domain lock, Reset Pinned Tab); '' when unpinned
    this.pinnedUrl = this.pinned ? d.pinnedUrl || d.url || '' : '';
    this.view = null;
    this.loading = false;
    this.audible = false;
    this.muted = false;
    this.crashed = false;
    this.devtools = null; // WebContentsView hosting devtools
    this.devtoolsRatio = 0.42;
    this.splitId = null;
    this.groupId = null; // tab group (notes/tab-groups-mac-design.md); null = loose
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
      title: TM.shownTitle(this, displayHost(this.url) || 'New Tab'),
      pageTitle: this.title,
      customTitle: this.customTitle,
      url: this.url,
      host: displayHost(this.url),
      favicon: this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: wc ? wc.isAudioMuted() : this.muted,
      pinned: this.pinned,
      pinnedUrl: this.pinnedUrl,
      drifted: this.pinned && TM.drifted(this.pinnedUrl, this.errorFor || this.url),
      splitId: this.splitId,
      groupId: this.groupId,
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
    this.groups = new Map(); // groupId -> {id, name, agent, working, status, collapsed, renamedByUser, lastAgentCall}
    this.agent = []; // tab ids of the agents' groups: the section at the bottom of the sidebar
    this.agentOrder = []; // group ids in that section's order (an empty agent group keeps its place)
    this.selection = []; // the sidebar's multi-selection, mirrored from the ui for menu-bar verbs
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
    this.groupTimer = setInterval(() => this.expireGroups(), 15000);
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
    const groupByKey = new Map();
    for (const g of s.groups || []) {
      // an agent that was working when olive quit is gone: keep its group, status and
      // provenance, drop the pulse
      const group = TG.makeGroup({ name: g.name, agent: !!g.agent, status: g.status || '', collapsed: g.collapsed !== false, working: false });
      group.collapsed = !!g.collapsed;
      group.renamedByUser = !!g.renamedByUser;
      this.groups.set(group.id, group);
      groupByKey.set(g.key, group);
      if (group.agent) this.agentOrder.push(group.id);
    }
    for (const t of s.tabs) {
      const tab = new Tab(this, t);
      this.tabs.set(tab.id, tab);
      byKey.set(t.key, tab);
      const g = !tab.pinned && t.groupKey != null ? groupByKey.get(t.groupKey) : null;
      tab.groupId = g ? g.id : null;
      TG.listOf(this, tab).push(tab.id);
    }
    for (const g of this.groups.values()) TG.fixContiguity(this, g.id);
    TG.prune(this, { by: 'user' });
    for (const sp of s.splits || []) {
      const ids = sp.keys.map((k) => byKey.get(k)).filter((t) => t && !t.pinned).map((t) => t.id); // pinned tabs never split
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
    for (const id of this.allIds()) {
      const t = this.tabs.get(id);
      if (!t || !t.url) continue;
      tabs.push({ key: t.id, url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, pinnedUrl: t.pinnedUrl || undefined, customTitle: t.customTitle || undefined, lastActive: t.lastActive, groupKey: t.groupId });
    }
    const splits = [...this.splits.values()].map((sp) => ({ keys: sp.ids, ratios: sp.ratios }));
    const groups = [...this.groups.values()].map((g) => ({ key: g.id, name: g.name, agent: g.agent, status: g.status, collapsed: g.collapsed, renamedByUser: g.renamedByUser }));
    return {
      bounds: this.win.isDestroyed() ? undefined : this.win.getNormalBounds(),
      sidebarWidth: this.sidebarWidth,
      sidebarHidden: this.sidebarHidden,
      tabs,
      splits,
      groups,
      activeKey: this.activeId,
    };
  }

  allIds() {
    return [...this.pinned, ...this.unpinned, ...(this.agent || [])]; // agent may be unset on a bare prototype (tests)
  }

  // the sidebar list a tab lives in: pinned, the user's list, or the agent section
  listOf(tab) {
    return TG.listOf(this, tab);
  }

  // groupId: open inside that group (appended; agent groups force activate:false). a tab
  // opened from a grouped tab (afterId) lands in the opener's group, like a split.
  createTab({ url = '', activate = true, focusPage = true, afterId = null, index = null, pinned = false, groupId = null, webContents = null, webPreferences = null, title = '' } = {}) {
    const tab = new Tab(this, { url, pinned, title });
    this.tabs.set(tab.id, tab);
    const opener = afterId != null ? this.tabs.get(afterId) : null;
    if (!pinned && groupId == null && opener && !opener.pinned && opener.groupId != null) groupId = opener.groupId;
    const group = !pinned && groupId != null ? this.groups.get(groupId) : null;
    if (group?.agent) activate = false; // the agent section never takes the user's place
    tab.groupId = group ? group.id : null;
    const list = this.listOf(tab);
    let at = 0;
    if (index != null) at = clamp(index, 0, list.length);
    else if (opener && list.includes(opener.id)) {
      const i = list.indexOf(afterId);
      at = i + 1;
      // keep opener's split group contiguous
      if (opener.splitId) {
        let j = i;
        while (j + 1 < list.length && this.tabs.get(list[j + 1])?.splitId === opener.splitId) j++;
        at = j + 1;
      }
    } else if (group) at = TG.appendIndex(this, group.id).index;
    list.splice(at, 0, tab.id);
    if (group) TG.fixContiguity(this, group.id);
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
          nodeIntegrationInSubFrames: true, // only so the page-dialogs preload runs in iframes too (no node: sandboxed)
        },
      });
    }
    tab.view = view;
    tab.crashed = false;
    tab.targetId = null;
    tab.loadedAt = this.mgr.now ? this.mgr.now() : Date.now(); // tab unloading: idle counts from here at the earliest
    tab.dirty = false;
    tab.capturing = false;
    view.setBorderRadius(RADIUS);
    view.setBackgroundColor('#ffffffff');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    if (this.uiOnTop) this.win.contentView.addChildView(this.ui);
    this.wireTab(tab);
    if (tab.muted) view.webContents.setAudioMuted(true);
    if (!webContents && tab.url) {
      this.mgr.applyUserAgent(view.webContents, tab.url);
      view.webContents.loadURL(this.loadUrl(tab.url)).catch(() => {});
    }
    return tab;
  }

  wireTab(tab) {
    const wc = tab.view.webContents;
    this.wireTabKeys(wc);
    this.wireDirtyInput(tab, wc);
    wc.setVisualZoomLevelLimits(1, 4).catch(() => {});

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      // web pages can't open olive:// (or the extension pages behind it)
      if (blockedNavigation(wc.getURL(), url, this.mgr.internal)) return { action: 'deny' };
      if (disposition === 'new-window' && features) {
        // real popup (oauth, payment): keep it a window so window.opener works
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true } },
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

    // domain lock (arc): a link or page-initiated navigation from a pinned tab to another
    // site opens in a new tab next to it and the pinned tab stays put. will-navigate only
    // fires for renderer-initiated main-frame navigations: server redirects (sso hops),
    // back/forward, reload and loadURL (omnibar, reset) never come through here.
    wc.on('will-navigate', (e, legacyUrl) => {
      const url = e.url || legacyUrl;
      if (!url || e.isMainFrame === false) return;
      // links, forms and scripts in web pages can't reach olive://; olive pages can (their
      // section links), and get the canonical address / the extension page directly
      if (blockedNavigation(wc.getURL(), url, this.mgr.internal)) { e.preventDefault(); return; }
      const load = this.loadUrl(url);
      if (load !== url) { e.preventDefault(); wc.loadURL(load).catch(() => {}); return; }
      if (!tab.pinned) return;
      if (!TM.shouldOpenOutside({ pinnedUrl: tab.pinnedUrl || tab.url, currentUrl: tab.committedUrl || tab.url, targetUrl: url })) return;
      e.preventDefault();
      this.recordActivity('navigation', { tabId: tab.id, url, action: 'pinned-domain-lock' });
      this.createTab({ url, activate: true, afterId: tab.id });
    });

    // no iframes of olive:// anywhere (the pages also send frame-ancestors 'none'), and no
    // server redirect from a web page into olive://
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame && e.url && (isOliveUrl(e.url) || this.mgr.internal?.isInternal(e.url))) e.preventDefault();
    });
    let navStart = '';
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) navStart = d.url; });
    wc.on('will-redirect', (e) => {
      if (e.isMainFrame !== false && blockedNavigation(navStart, e.url, this.mgr.internal)) e.preventDefault();
    });

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.mgr.history.update(tab.url, { title });
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, favs) => {
      if (this.mgr.internal?.isInternal(tab.url)) return;
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
    wc.on('did-navigate', (_e, rawUrl) => {
      // a new main document (link, reload, back/forward): typed input and capture are gone
      tab.dirty = false;
      tab.capturing = false;
      if (wc.__oliveRecordingKeys) require('./shortcuts').setRecording(wc, false);
      if (rawUrl.startsWith('data:text/html;olive-error')) return;
      // uBO's own pages show as olive://extensions/ublock/<page>
      const url = this.mgr.internal ? this.mgr.internal.displayUrl(rawUrl) : rawUrl;
      const internal = !!this.mgr.internal?.isInternal(url);
      if (!tab.committedUrl || displayHost(url) !== displayHost(tab.committedUrl)) tab.favicon = '';
      if (internal) tab.favicon = OLIVE_FAVICON;
      tab.committedUrl = url;
      tab.url = url;
      this.mgr.internal?.check(tab);
      // Olive's own pages stay out of history (the palette lists them as commands)
      if (!this.isPrivate && !internal) this.mgr.history.add(url, wc.getTitle());
      this.recordActivity('visit', { tabId: tab.id, url });
      if (this.find.open && tab.id === this.activeId) this.closeFind();
      this.changed();
    });
    wc.on('did-navigate-in-page', (_e, rawUrl, isMainFrame) => {
      if (!isMainFrame) return;
      const url = this.mgr.internal ? this.mgr.internal.displayUrl(rawUrl) : rawUrl;
      tab.url = url;
      this.mgr.internal?.check(tab);
      if (!this.isPrivate && !this.mgr.internal?.isInternal(url)) this.mgr.history.add(url, wc.getTitle());
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
      tab.dirty = false;
      tab.capturing = false;
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
    // landing in a collapsed group (⌃Tab, ⌘1-9, a click from the palette) expands it and
    // it stays expanded (decision 7.4). agents never get here: they open in the background.
    const group = tab.groupId != null ? this.groups.get(tab.groupId) : null;
    if (group?.collapsed) group.collapsed = false;
    if (!mruPreview) { this.tabMRU.touch(id); tab.lastActive = Date.now(); }
    // load other members of the split too
    if (tab.splitId) for (const sid of this.splits.get(tab.splitId).ids) this.ensureView(this.tabs.get(sid));
    this.layout();
    if (focusPage && this.overlay !== 'palette') tab.wc.focus();
    this.changed();
  }

  // by: 'user' | 'agent'. an agent closing the last tab of its own working group keeps the
  // group for the grace window (it opens, reads, closes, opens); a user close removes it.
  // skipStack: the caller already pushed one closed-stack entry (closeGroup).
  closeTab(id, { fromPage = false, force = false, by = 'user', skipStack = false } = {}) {
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
    const list = this.listOf(tab);
    if (!skipStack) {
      if (tab.url && !tab.errorFor) this.pushClosed({ kind: 'tab', url: tab.url, title: tab.title, favicon: tab.favicon, index: list.indexOf(id), groupId: tab.groupId });
      else if (tab.errorFor) this.pushClosed({ kind: 'tab', url: tab.errorFor, title: tab.title, favicon: '', index: list.indexOf(id), groupId: tab.groupId });
    }
    const wasActive = this.activeId === id;
    const split = tab.splitId ? this.splits.get(tab.splitId) : null;
    const siblings = split ? split.ids.filter((x) => x !== id) : [];
    this.removeFromSplit(id);
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    this.unload(tab);
    this.tabs.delete(id);
    this.mgr.internal?.check(tab, { removed: true });
    this.tabMRU.remove(id);
    this.selection = this.selection.filter((x) => x !== id);
    if (tab.groupId != null) TG.prune(this, { by });
    if (wasActive) {
      this.activeId = null;
      if (siblings.length) this.activate(siblings[0]);
      else this.pickNextActive(id, list, idx);
    }
    this.layout();
    this.changed();
    if (this.tabs.size === 0 && !this.destroyed) this.openPalette('new');
  }

  pushClosed(entry) {
    this.closedStack.push(entry);
    if (this.closedStack.length > 50) this.closedStack.shift();
  }

  closeTabs(ids, opts = {}) {
    for (const id of ids) this.closeTab(id, opts);
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

  unload(tab, { reason = 'user' } = {}) {
    if (tab.view) this.recordActivity('tab-unload', { tabId: tab.id, url: tab.url, reason });
    this.dropDevtools(tab);
    tab.dirty = false;
    tab.capturing = false;
    if (tab.view) {
      const view = tab.view;
      tab.view = null;
      tab.loading = false;
      tab.audible = false;
      try { this.win.contentView.removeChildView(view); } catch {}
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  // ⇧⌘T: the last closed tab, or the last closed group as a whole (name, order, collapse)
  reopenClosed() {
    const c = this.closedStack.pop();
    if (!c) return;
    if (c.kind === 'group') {
      const group = TG.makeGroup({ name: c.name, agent: c.agent, status: c.status, collapsed: c.collapsed, working: false });
      group.collapsed = !!c.collapsed;
      this.groups.set(group.id, group);
      if (group.agent) this.agentOrder.push(group.id);
      let first = null;
      c.tabs.forEach((t, i) => {
        const tab = this.createTab({ url: t.url, title: t.title, activate: false, groupId: group.id, index: group.agent ? undefined : c.index + i });
        if (!first) first = tab;
      });
      if (first && !group.agent) this.activate(first.id);
      else this.changed();
      return;
    }
    const groupId = c.groupId != null && this.groups.has(c.groupId) ? c.groupId : null;
    this.createTab({ url: c.url, title: c.title, index: c.index, groupId });
  }

  // drop from the sidebar: ids (whole splits included by the ui) go to `list` at `index`
  // (counted without the moved tabs), into `groupId` or loose. dragging into the pinned
  // strip ungroups (decision 7.1).
  moveTabs(ids, list, index, groupId = null) {
    const tabs = ids.map((id) => this.tabs.get(id)).filter(Boolean);
    if (!tabs.length) return;
    const all = new Set();
    if (list === 'pinned') {
      // pinned tabs never split: pinning takes a tab out of its split, its partners stay
      for (const t of tabs) { this.removeFromSplit(t.id); all.add(t.id); }
    } else for (const t of tabs) for (const x of (t.splitId ? this.splits.get(t.splitId).ids : [t.id])) all.add(x);
    const moving = this.allIds().filter((id) => all.has(id)); // keep their current relative order
    const touched = new Set(tabs.map((t) => t.groupId).filter((g) => g != null));
    TG.place(this, moving, { list: list === 'pinned' ? 'pinned' : list === 'agent' ? 'agent' : 'unpinned', index, groupId: list === 'pinned' ? null : groupId });
    for (const g of touched) TG.fixContiguity(this, g);
    TG.prune(this, { by: 'user' });
    this.syncPinnedUrls();
    this.changed();
  }

  moveTab(id, list, index) {
    this.moveTabs([id], list, index, null);
  }

  // a whole group block moves between top-level items of its own list; agent groups
  // stay in the agent section (2.5)
  moveGroup(groupId, index) {
    const g = this.groups.get(groupId);
    if (!g) return;
    const mem = TG.members(this, groupId);
    if (g.agent) {
      // index counts groups in the section, without this one
      const order = this.agentOrder.filter((x) => x !== groupId);
      order.splice(clamp(index, 0, order.length), 0, groupId);
      this.agentOrder = order;
      const ids = [];
      for (const gid of order) ids.push(...TG.members(this, gid));
      this.agent = ids;
    } else TG.place(this, mem, { list: 'unpinned', index, groupId });
    this.changed();
  }

  setPinned(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab || tab.pinned === pinned) return;
    this.moveTabs([id], pinned ? 'pinned' : 'unpinned', pinned ? this.pinned.length : 0, null);
  }

  // pinning remembers the url the tab is on; unpinning forgets it (re-pinning takes the
  // current url again)
  syncPinnedUrls() {
    for (const t of this.tabs.values()) {
      if (t.pinned && !t.pinnedUrl) t.pinnedUrl = t.errorFor || t.url || '';
      else if (!t.pinned && t.pinnedUrl) t.pinnedUrl = '';
    }
  }

  // Reset Pinned Tab / the sidebar's ↺: back to the pinned url, in place
  resetPinned(id) {
    const tab = this.tabs.get(id);
    if (!tab?.pinned || !tab.pinnedUrl) return;
    this.recordActivity('navigation', { tabId: tab.id, url: tab.pinnedUrl, action: 'reset-pinned' });
    tab.url = tab.pinnedUrl;
    tab.errorFor = null;
    if (tab.wc) {
      this.mgr.applyUserAgent(tab.wc, tab.url);
      tab.wc.loadURL(this.loadUrl(tab.url)).catch(() => {});
    }
    this.activate(tab.id);
  }

  // Rename Tab… / double-click: '' (or only spaces) goes back to the page title
  renameTab(id, name) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.customTitle = TM.cleanTitle(name);
    this.changed();
    return true;
  }

  resetTabName(id) {
    return this.renameTab(id, '');
  }

  // Set Current URL as Pinned URL
  setPinnedUrl(id, url = null) {
    const tab = this.tabs.get(id);
    if (!tab?.pinned) return;
    const next = url || tab.errorFor || tab.url;
    if (!next) return;
    tab.pinnedUrl = next;
    this.changed();
  }

  duplicate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.createTab({ url: tab.url, afterId: tab.pinned ? null : id });
  }

  // "Clear" closes the loose unpinned tabs only; groups, the user's and the agents', stay (decision 7.6)
  clearUnpinned() {
    for (const id of [...this.unpinned]) if (this.tabs.get(id)?.groupId == null) this.closeTab(id);
  }

  looseCount() {
    return this.unpinned.filter((id) => this.tabs.get(id)?.groupId == null).length;
  }

  closeOthers(ids) {
    const keep = new Set(Array.isArray(ids) ? ids : [ids]);
    for (const x of [...this.unpinned]) if (!keep.has(x)) this.closeTab(x);
  }

  // ---------- tab groups (notes/tab-groups-mac-design.md) ----------

  group(id) {
    return this.groups.get(id) || null;
  }

  // ⌃⌘N: the selection (or the active tab) becomes a group where its first tab was,
  // "Untitled Group", expanded, rename field open
  newGroup(ids = null) {
    let tabs = (ids && ids.length ? ids : this.selection.length ? this.selection : [this.activeId])
      .map((id) => this.tabs.get(id)).filter((t) => t && !t.pinned);
    if (!tabs.length) return null;
    const group = TG.makeGroup({ name: TG.DEFAULT_NAME, agent: false, collapsed: false });
    this.groups.set(group.id, group);
    const all = new Set();
    for (const t of tabs) for (const x of (t.splitId ? this.splits.get(t.splitId).ids : [t.id])) all.add(x);
    const moving = this.allIds().filter((id) => all.has(id));
    const firstIdx = Math.min(...moving.map((id) => this.unpinned.indexOf(id)).filter((i) => i >= 0), this.unpinned.length);
    const before = this.unpinned.slice(0, firstIdx).filter((id) => !all.has(id)).length;
    const touched = new Set(tabs.map((t) => t.groupId).filter((g) => g != null));
    TG.place(this, moving, { list: 'unpinned', index: before, groupId: group.id });
    for (const g of touched) TG.fixContiguity(this, g);
    TG.prune(this, { by: 'user' });
    this.selection = [];
    this.sendState();
    this.send('rename-group', { id: group.id });
    this.changed();
    return group;
  }

  // Move to Group ▸: append to an existing group (groupId) or leave the group (null)
  moveToGroup(ids, groupId) {
    const tabs = ids.map((id) => this.tabs.get(id)).filter((t) => t && !t.pinned);
    if (!tabs.length) return;
    if (groupId == null) {
      TG.removeFromGroup(this, tabs.map((t) => t.id));
      return this.changed();
    }
    const g = this.groups.get(groupId);
    if (!g) return;
    const all = new Set();
    for (const t of tabs) for (const x of (t.splitId ? this.splits.get(t.splitId).ids : [t.id])) all.add(x);
    const moving = this.allIds().filter((id) => all.has(id) && this.tabs.get(id).groupId !== groupId);
    if (!moving.length) return;
    const touched = new Set(tabs.map((t) => t.groupId).filter((x) => x != null && x !== groupId));
    const at = TG.appendIndex(this, groupId);
    TG.place(this, moving, { list: at.list, index: at.index, groupId });
    for (const x of touched) TG.fixContiguity(this, x);
    TG.prune(this, { by: 'user' });
    this.changed();
  }

  renameGroup(id, name, { by = 'user' } = {}) {
    const g = this.groups.get(id);
    const clean = TG.cleanName(name);
    if (!g || !clean) return false;
    if (by === 'agent' && g.renamedByUser) return false;
    g.name = clean;
    if (by === 'user') g.renamedByUser = true;
    this.changed();
    return true;
  }

  setGroupCollapsed(id, collapsed) {
    const g = this.groups.get(id);
    if (!g) return;
    g.collapsed = collapsed == null ? !g.collapsed : !!collapsed;
    this.changed();
  }

  // ⌥-click a header: every group follows (NSOutlineView)
  collapseAll(collapsed) {
    for (const g of this.groups.values()) g.collapsed = !!collapsed;
    this.changed();
  }

  collapseOthers(id) {
    for (const g of this.groups.values()) if (g.id !== id) g.collapsed = true;
    this.changed();
  }

  // header × / Close Group: every member closes and ⇧⌘T brings the group back as one
  closeGroup(id, { by = 'user' } = {}) {
    const g = this.groups.get(id);
    if (!g) return;
    const mem = TG.members(this, id);
    const list = g.agent ? this.agent : this.unpinned;
    const entry = {
      kind: 'group', name: g.name, agent: g.agent, status: g.status, collapsed: g.collapsed,
      index: mem.length ? list.indexOf(mem[0]) : this.unpinned.length,
      tabs: mem.map((x) => this.tabs.get(x)).filter((t) => t.url).map((t) => ({ url: t.errorFor || t.url, title: t.title, favicon: t.favicon })),
    };
    if (entry.tabs.length) this.pushClosed(entry);
    this.recordActivity('group-close', { groupId: id, tabs: mem.length, by });
    for (const x of mem) this.closeTab(x, { force: true, by, skipStack: true });
    TG.dropGroup(this, id);
    this.changed();
  }

  // Ungroup (Keep Tabs)
  ungroup(id) {
    TG.ungroup(this, id);
    this.changed();
  }

  newTabInGroup(id) {
    const g = this.groups.get(id);
    if (!g) return;
    g.collapsed = false;
    this.pendingGroup = id; // the palette's next submit lands in this group
    this.openPalette('new');
  }

  setSelection(ids) {
    this.selection = (Array.isArray(ids) ? ids : []).filter((id) => this.tabs.has(id));
  }

  // every 15s: a working agent group goes quiet 2 minutes after its last api call, and
  // an agent group still empty by then disappears
  expireGroups(now = Date.now()) {
    if (this.destroyed) return;
    if (TG.expire(this, now)) this.changed();
  }

  // --- agent api hooks (agent-api.js); every api call that touches a group is a `touch` ---

  createAgentGroup({ name, status = '', collapsed = true } = {}) {
    const group = TG.makeGroup({ name: name || TG.agentDefaultName(this), agent: true, status, collapsed: collapsed !== false, working: true });
    if (!group.name) group.name = TG.agentDefaultName(this);
    this.groups.set(group.id, group);
    this.agentOrder.push(group.id);
    this.changed();
    return group;
  }

  touchGroup(id) {
    TG.touch(this, id);
    this.changed();
  }

  // PATCH /groups/:id; returns {ok} or {error, code}
  patchGroup(id, { name, status, working, collapsed } = {}) {
    const g = this.groups.get(id);
    if (!g) return { error: 'no such group', code: 404 };
    if (name !== undefined) {
      if (!TG.cleanName(name)) return { error: 'name must be 1-60 characters', code: 400 };
      if (!this.renameGroup(id, name, { by: 'agent' })) return { error: 'the user renamed this group; its name is theirs now', code: 409 };
    }
    if (status !== undefined) g.status = TG.cleanStatus(status == null ? '' : String(status));
    if (collapsed !== undefined) g.collapsed = !!collapsed;
    if (working !== undefined) {
      g.working = !!working;
      if (g.working) g.lastAgentCall = Date.now();
      else TG.prune(this, { by: 'user' }); // an empty group ends with its run
    } else if (g.agent) TG.touch(this, id);
    this.changed();
    return { ok: true, group: this.groups.get(id) || null };
  }

  groupInfo(g) {
    const tabIds = TG.members(this, g.id);
    return { id: g.id, name: g.name, agent: g.agent, section: g.agent ? 'agent' : 'list', working: g.working, status: g.status, collapsed: g.collapsed, tabIds, windowId: this.id };
  }

  // ---------- split view ----------

  visibleIds() {
    const tab = this.tabs.get(this.activeId);
    if (!tab || !tab.wc) return [];
    if (tab.splitId) return this.splits.get(tab.splitId).ids.filter((id) => this.tabs.get(id)?.wc);
    return [tab.id];
  }

  // a pinned tab never joins a split (arc): its current url opens in a new normal tab at
  // the top of the list and that one splits instead. returns the tab to split with.
  unpinnedTwin(tab) {
    if (!tab?.pinned) return tab;
    const url = tab.errorFor || tab.url;
    this.recordActivity('tab-open', { tabId: tab.id, url, action: 'split-pinned-clone' });
    return this.createTab({ url, title: tab.title, activate: false, index: 0 });
  }

  // every split goes through here (tab menu, drag onto the page, palette ⇧⏎ / split
  // mode, ⌃⇧=, agent api). returns { a, b } as split, or undefined
  split(aId, bId) {
    let a = this.tabs.get(aId);
    let b = this.tabs.get(bId);
    if (!a || !b || aId === bId) return;
    if (b.splitId && b.splitId === a.splitId) return;
    if (a.splitId && this.splits.get(a.splitId)?.ids.length >= 4) return; // full: before any copy is made
    a = this.unpinnedTwin(a);
    b = this.unpinnedTwin(b);
    aId = a.id;
    bId = b.id;
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
    // keep the split contiguous in a's list, where a's split was; b joins a's tab group (2.8)
    const list = this.listOf(a);
    const group = new Set(sp.ids);
    const firstIdx = list.findIndex((id) => group.has(id) && id !== bId);
    const insertAt = list.slice(0, Math.max(0, firstIdx)).filter((id) => !group.has(id)).length;
    const bGroup = b.groupId;
    TG.removeFromLists(this, sp.ids);
    list.splice(insertAt, 0, ...sp.ids);
    for (const id of sp.ids) { this.tabs.get(id).pinned = false; this.tabs.get(id).groupId = a.groupId; }
    if (a.groupId != null) TG.fixContiguity(this, a.groupId);
    if (bGroup != null && bGroup !== a.groupId) TG.prune(this, { by: 'user' });
    this.ensureView(b);
    this.activate(bId);
    return { a, b };
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

  // what a tab actually loads for a url (olive://extensions/ublock/options is the extension's
  // own page, an old olive:// name its new address); the tab keeps showing the olive:// url
  loadUrl(url) { return this.mgr.internal ? this.mgr.internal.resolveLoad(url) : url; }

  navigate(tab, input) {
    const url = toUrl(input);
    if (!url || !tab) return;
    // private windows don't serve olive:// pages: they open in a normal window
    if (this.isPrivate && isOliveUrl(url)) return this.mgr.internal?.open(url);
    this.recordActivity(url.startsWith(SEARCH) ? 'search' : 'navigation', { tabId: tab.id, url, action: 'navigate', ...(url.startsWith(SEARCH) ? { engine: 'google' } : {}) });
    this.ensureView(tab);
    tab.url = url;
    this.mgr.applyUserAgent(tab.wc, url);
    tab.wc.loadURL(this.loadUrl(url)).catch(() => {});
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
    this.mgr.pageDialogs?.layout(this);
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
    this.mgr.pageDialogs?.layout(this);
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
      agentTabs: this.agent.map(t), // `agent` below is the api endpoint info
      agentOrder: this.agentOrder,
      groups: Object.fromEntries([...this.groups.values()].map((g) => [g.id, { id: g.id, name: g.name, agent: g.agent, working: g.working, status: TG.statusShown(this, g), collapsed: g.collapsed }])),
      looseCount: this.looseCount(),
      splits: Object.fromEntries([...this.splits].map(([k, v]) => [k, v])),
      panes: this.panes,
      find: this.find,
      htmlFullscreen: !!this.htmlFullscreenId,
      appPage: ['settings','activities'].includes(this.inlinePage?.kind) ? {title:this.inlinePage.options.title||'Settings'} : null,
      // the setup row stands in for setup while no olive://onboarding tab is open here
      onboarding: !this.isPrivate && this.mgr.onboarding?.listed() && ![...this.tabs.values()].some(x => /^olive:\/\/onboarding(\/|$)/i.test(x.url || '')) ? {active:false, step:this.mgr.onboarding.saved.step, remaining:Math.max(0,4-require('./onboarding').STEPS.indexOf(this.mgr.onboarding.saved.step))} : null,
      active: !this.inlinePage && active
        ? {
            id: active.id,
            url: active.errorFor || active.url,
            host: displayHost(active.errorFor || active.url),
            title: active.title,
            secure: /^https:/.test(active.url) || isOliveUrl(active.url), // olive:// is local, served by Olive
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

  // context menu on a tab row. ids: the selection when the row is part of it (verbs read
  // "Pin 3 Tabs"), else just this tab. the template is built by tabMenuTemplate so the
  // unit tests can read it without electron.
  tabMenu(id, ids = null) {
    const t = this.tabMenuTemplate(id, ids);
    if (t) Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  tabMenuTemplate(id, ids = null) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const sel = (ids && ids.includes(id) ? ids : [id]).map((x) => this.tabs.get(x)).filter(Boolean);
    const selIds = sel.map((x) => x.id);
    const n = sel.length;
    const tabsWord = n === 1 ? 'Tab' : `${n} Tabs`;
    const active = this.tabs.get(this.activeId);
    const sep = { type: 'separator' };
    const t = [];
    const groupable = sel.filter((x) => !x.pinned);
    if (groupable.length) {
      const inGroups = new Set(groupable.map((x) => x.groupId).filter((g) => g != null));
      const allIn = (gid) => groupable.every((x) => x.groupId === gid);
      const groupItems = [...this.groups.values()].map((g) => ({
        label: (g.agent ? '✦ ' : '') + g.name, type: allIn(g.id) ? 'checkbox' : 'normal', checked: allIn(g.id), enabled: !allIn(g.id),
        click: () => this.moveToGroup(selIds, g.id),
      }));
      t.push({
        label: `Move ${tabsWord} to Group`,
        submenu: [{ label: `New Group with ${tabsWord}`, accelerator: 'Ctrl+Cmd+N', click: () => this.newGroup(selIds) }, ...(groupItems.length ? [sep, ...groupItems] : [])],
      });
      t.push({ label: 'Remove from Group', enabled: inGroups.size > 0, click: () => this.moveToGroup(selIds, null) }, sep);
    }
    const allPinned = sel.every((x) => x.pinned);
    t.push(
      { label: allPinned ? `Unpin ${tabsWord}` : `Pin ${tabsWord}`, click: () => { for (const x of sel) this.setPinned(x.id, !allPinned); } },
      { label: n === 1 ? 'Duplicate' : 'Duplicate Tabs', click: () => { for (const x of sel) this.duplicate(x.id); } },
      { label: n === 1 ? 'Copy Link' : 'Copy Links', enabled: sel.some((x) => x.url), click: () => clipboard.writeText(sel.map((x) => x.url).filter(Boolean).join('\n')) },
      { label: 'Reload', click: () => { for (const x of sel) this.reload(x); } },
      { label: tab.wc?.isAudioMuted() ? 'Unmute' : 'Mute', enabled: sel.some((x) => x.wc), click: () => { for (const x of sel) this.toggleMute(x.id); } },
      sep,
    );
    if (n === 1) {
      if (active && active.id !== id && !(tab.splitId && tab.splitId === active.splitId)) {
        t.push({ label: 'Open in Split View with Current Tab', click: () => this.split(active.id, id) });
      } else t.push({ label: 'Open in Split View with Current Tab', enabled: false });
      if (tab.splitId) t.push({ label: 'Separate Split View', click: () => this.unsplit(id) }, { label: 'Remove from Split View', click: () => { this.removeFromSplit(id); this.activate(id); } });
      t.push(sep, { label: 'Open in New Window', enabled: !!tab.url, click: () => { const url = tab.url; this.closeTab(id); this.mgr.newWindow({ url, private: this.isPrivate }); } });
      t.push(sep);
    }
    if (n === 1) {
      t.push(
        { label: 'Rename Tab…', click: () => this.send('rename-tab', { id }) },
        { label: 'Reset Tab Name', enabled: !!tab.customTitle, click: () => this.resetTabName(id) },
        sep,
      );
    }
    if (n === 1 && tab.pinned) {
      const off = TM.drifted(tab.pinnedUrl, tab.errorFor || tab.url);
      t.push(
        { label: 'Reset Pinned Tab', enabled: off, click: () => this.resetPinned(id) },
        { label: 'Set Current URL as Pinned URL', enabled: off, click: () => this.setPinnedUrl(id) },
        sep,
      );
    }
    if (allPinned) t.push({ label: n === 1 ? 'Unload' : `Unload ${tabsWord}`, enabled: sel.some((x) => x.wc), click: () => this.closeTabs(selIds) }, { label: n === 1 ? 'Remove Pinned Tab' : `Remove ${tabsWord}`, click: () => { for (const x of sel) { this.setPinned(x.id, false); this.closeTab(x.id); } } });
    else t.push(
      { label: 'Unload (Free Memory)', enabled: sel.some((x) => x.wc && !this.visibleIds().includes(x.id)), click: () => { for (const x of sel) if (!this.visibleIds().includes(x.id)) this.unload(x); this.changed(); } },
      { label: `Close ${tabsWord}`, click: () => this.closeTabs(selIds) },
      { label: 'Close Other Tabs', click: () => this.closeOthers(selIds) },
    );
    return t;
  }

  groupMenu(id) {
    const t = this.groupMenuTemplate(id);
    if (t) Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  groupMenuTemplate(id) {
    const g = this.groups.get(id);
    if (!g) return null;
    const sep = { type: 'separator' };
    const mem = TG.members(this, id);
    return [
      { label: 'New Tab in Group', click: () => this.newTabInGroup(id) },
      { label: 'Rename', click: () => { this.send('rename-group', { id }); } },
      sep,
      { label: g.collapsed ? 'Expand' : 'Collapse', click: () => this.setGroupCollapsed(id) },
      { label: 'Collapse Other Groups', enabled: this.groups.size > 1, click: () => this.collapseOthers(id) },
      sep,
      { label: 'Copy All Links', enabled: mem.length > 0, click: () => clipboard.writeText(mem.map((x) => this.tabs.get(x)?.url).filter(Boolean).join('\n')) },
      { label: 'Ungroup (Keep Tabs)', click: () => this.ungroup(id) },
      sep,
      { label: 'Close Group', click: () => this.closeGroup(id) },
    ];
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
      case 'importBrowser': return this.mgr.onboarding?.showImport();
      case 'onboardingLater': return this.mgr.onboarding?.command('later');
      // one Settings page; the old page names open its tabs (src/main/settings-page.js)
      // cmd+, (no tab): focus a Settings tab if there is one (this window first), else open one
      case 'settings': return this.mgr.settingsPage?.show(this, a.tab, { section: a.section || null, origin: a.origin || null });
      case 'shortcuts': return this.mgr.settingsPage?.show(this, 'shortcuts');
      case 'activities': return this.mgr.settingsPage?.show(this, 'activities');
      case 'ledger': return this.mgr.ledgerUI ? this.mgr.ledgerUI.show(this) : require('./ledger-review').show(this);
      case 'ublock': return this.mgr.extensions?.open(this);
      case 'extensions': return this.mgr.settingsPage?.show(this, 'extensions');
      case 'sitePermissions': return this.mgr.settingsPage?.show(this, 'general', { section: 'permissions', origin: active?.url || null });
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
      // native menu dispatch has no keyUp to wait for: always a fresh single step, and
      // never a continuation of a walk whose release we may have missed
      case 'mruNext': this.finishTabWalk(); this.walkTabs(1); return this.finishTabWalk();
      case 'mruPrev': this.finishTabWalk(); this.walkTabs(-1); return this.finishTabWalk();
      case 'nextTab': return this.cycle(1);
      case 'prevTab': return this.cycle(-1);
      case 'selectIndex': return this.selectIndex(a.index);
      case 'togglePin': return active && this.setPinned(active.id, !active.pinned);
      case 'duplicate': return active && this.duplicate(active.id);
      case 'unsplit': return active && this.unsplit(active.id);
      case 'split': return this.split(a.a ?? this.activeId, a.b);
      case 'splitRatios': return this.setSplitRatios(a.splitId, a.ratios);
      case 'devtoolsRatio': return this.setDevtoolsRatio(a.id, a.ratio);
      case 'move': return this.moveTabs(a.ids || [a.id], a.list, a.index, a.groupId ?? null);
      case 'moveGroup': return this.moveGroup(a.id, a.index);
      case 'tabMenu': return this.tabMenu(a.id, a.ids || null);
      case 'groupMenu': return this.groupMenu(a.id);
      case 'closeTabs': return this.closeTabs(a.ids || []);
      case 'selection': return this.setSelection(a.ids);
      case 'newGroup': return this.newGroup(a.ids || null);
      case 'moveToGroup': return this.moveToGroup(a.ids || [], a.groupId ?? null);
      case 'renameGroup': return this.renameGroup(a.id, a.name);
      case 'toggleGroup': return this.setGroupCollapsed(a.id, a.collapsed);
      case 'collapseAll': return this.collapseAll(a.collapsed);
      case 'collapseOthers': return this.collapseOthers(a.id);
      case 'closeGroup': return this.closeGroup(a.id);
      case 'ungroup': return this.ungroup(a.id);
      case 'newTabInGroup': return this.newTabInGroup(a.id);
      case 'mute': return this.toggleMute(a.id);
      case 'resetPinned': return this.resetPinned(a.id);
      case 'renameTab': return this.renameTab(a.id, a.name);
      case 'resetTabName': return this.resetTabName(a.id);
      case 'setPinnedUrl': return this.setPinnedUrl(a.id);
      case 'clearUnpinned': return this.clearUnpinned();
      case 'overlay': return this.setOverlay(a.kind || null);
      case 'submit': return this.submit(a);
      case 'showDownload': return a.path && shell.showItemInFolder(a.path);
      case 'openDownload': return a.path && shell.openPath(a.path);
      case 'clearDownloads':
        for (let i = this.mgr.downloads.length - 1; i >= 0; i--) if (this.mgr.downloads[i].state !== 'progressing') this.mgr.downloads.splice(i, 1);
        return this.mgr.broadcast();
      case 'focusActive': return active?.wc?.focus();
      // an inline sidebar field (tab / group rename) needs the keyboard: the row click that
      // preceded it moved native focus into the page (activate)
      case 'focusUi': return this.ui.webContents.focus();
      case 'newWindow': return this.mgr.newWindow({});
      case 'newPrivateWindow': return this.mgr.newWindow({ private: true });
      case 'copyAgentInfo': clipboard.writeText(JSON.stringify(this.mgr.agentInfo(), null, 2)); return this.send('toast', 'Copied agent endpoints');
      default:
        console.warn('[olive] unknown cmd', type);
    }
  }

  // ↵ follows the palette mode (edit = current tab, new = new tab), ⇧↵ (split) opens in
  // split view, ⌘↵ (newTab) opens a new foreground tab and leaves the current one alone.
  submit({ mode, input, item, split: inSplit, newTab = false }) {
    this.setOverlay(null);
    const pendingGroup = this.pendingGroup;
    this.pendingGroup = null;
    if (item?.kind === 'command') {
      if (item.commandId === 'settings') {
        // the plain Settings command acts like cmd+, ; a deep link names its section
        const target = item.url && item.url !== 'olive://settings' ? parseSettingsUrl(item.url) : null;
        return this.cmd('settings', target || {});
      }
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
    // typed olive:// urls are ordinary addresses; private windows send them to a normal window
    if (this.isPrivate && isOliveUrl(url)) return this.mgr.internal?.open(url);
    if (url.startsWith(SEARCH) && (mode !== 'edit' || newTab)) this.recordActivity('search', { url, engine: 'google' });
    const active = this.tabs.get(this.activeId);
    if (inSplit || mode === 'split') return this.openInSplit(url, active);
    if (newTab === true) return this.createTab(pendingGroup != null && this.groups.has(pendingGroup) ? { url, groupId: pendingGroup } : { url });
    if (mode === 'edit' && active) return this.navigate(active, url);
    if (pendingGroup != null && this.groups.has(pendingGroup)) return this.createTab({ url, groupId: pendingGroup });
    this.createTab({ url });
  }

  // tab unloading never drops a page the user typed into (an unsent message, a half-filled
  // form). a key that edits text, typed while focus is in an editable field of the page,
  // marks the tab dirty until its next main-document navigation / reload / crash / unload.
  // the field check runs in the focused frame (cross-origin iframes too) only on the first
  // such key, so it costs one tiny script per page, not one per keystroke.
  // limits: paste from the context menu, drag-and-drop, autofill and IME composition
  // without a key event don't count; a page can't clear it by itself (no submit detection),
  // only navigating does. see notes/settings-and-unloading.md.
  wireDirtyInput(tab, wc) {
    let checking = false;
    wc.on('before-input-event', (_event, input) => {
      if (tab.dirty || checking || input.type !== 'keyDown' || !editingKey(input)) return;
      const frame = wc.focusedFrame || wc.mainFrame;
      if (!frame) return;
      checking = true;
      frame.executeJavaScript(EDITABLE_FOCUS_CHECK, false).then((editable) => {
        if (editable === true && !tab.dirty && tab.wc === wc) { tab.dirty = true; this.changed(); }
      }).catch(() => {}).finally(() => { checking = false; });
    });
  }

  wireTabKeys(wc) {
    wc.on('before-input-event', (event, input) => {
      if (wc.__oliveRecordingKeys) return; // Settings > Keyboard Shortcuts is recording a shortcut
      // Esc while the walk is held cancels it: back to the start tab, mru untouched,
      // and the later modifier release finds no walk. Swallow the Esc (and its keyUp)
      // so the page / palette / inline page never sees it.
      if (this.tabMRU.walk && cancelsWalk(input)) {
        event.preventDefault();
        this.tabWalkSwallowEscUp = true;
        return this.cancelTabWalk();
      }
      if (input.type === 'keyUp' && this.tabWalkSwallowEscUp && cancelsWalk({ ...input, type: 'keyDown' })) {
        this.tabWalkSwallowEscUp = false;
        return event.preventDefault();
      }
      if (this.tabMRU.walk) {
        if (holdReleased(this.tabWalkHold, input)) this.finishTabWalk();
        // A fresh press of the hold modifier means it was released since the walk
        // began, even if that keyUp never reached us (see primeTabWalkKeys).
        else if (input.type === 'keyDown' && !input.isAutoRepeat && wc !== this.tabWalkPriming && holdRepressed(this.tabWalkHold, input)) this.finishTabWalk();
      }
      if (input.type !== 'keyDown') return;
      // Resolve on every keystroke: remapping and profile switches take effect live.
      for (const [command, dir] of [['mruNext', 1], ['mruPrev', -1]]) {
        const accelerator = this.mgr.shortcuts
          ? this.mgr.shortcuts.accelerator(command)
          : COMMANDS.find(c => c.id === command).accelerator;
        if (!matchesInput(accelerator, input)) continue;
        event.preventDefault(); // suppress both the page key and native menu accelerator
        if (!this.tabMRU.walk) this.tabWalkHold = holdForInput(input);
        this.walkTabs(dir, wc);
        break;
      }
    });
  }

  // source: the webcontents whose keyDown started/continued the walk (null: menu)
  walkTabs(dir, source = null) {
    const id = this.tabMRU.step(this.allIds(), this.activeId, dir);
    if (id != null) this.activate(id, { mruPreview: true });
    if (source && this.tabMRU.walk) this.primeTabWalkKeys(source);
  }

  // Chromium drops every keyUp sent to a webcontents after a keyDown that
  // before-input-event preventDefault()ed, until that webcontents sees its next
  // keyDown (RenderWidgetHostImpl::suppress_events_until_keydown_). That flag
  // outlives focus changes: walking A -> B leaves it set on A, and the next tap
  // B -> A then loses the modifier keyUp in A, so the walk never commits and the
  // following tap drifts down the stale list. So after each walk step, hand the
  // keyboard owner (the previewed page, or the source if focus stayed put) a keyDown
  // for the still-held modifier: it clears the flag, and the page sees a coherent
  // Control down/up pair around the walk.
  primeTabWalkKeys(source) {
    const tab = this.tabs.get(this.activeId);
    // activate() moved focus into the previewed page unless the palette holds it
    const target = this.overlay !== 'palette' && tab?.wc ? tab.wc : source;
    const modifiers = this.tabWalkHold?.modifiers || [];
    if (!modifiers.length || typeof target?.sendInputEvent !== 'function' || target.isDestroyed?.()) return;
    const keyCode = { control: 'Control', meta: 'Meta', alt: 'Alt' };
    this.tabWalkPriming = target;
    try {
      for (const flag of modifiers) target.sendInputEvent({ type: 'keyDown', keyCode: keyCode[flag], modifiers });
    } finally { this.tabWalkPriming = null; }
  }

  cancelTabWalk() {
    const hold = this.tabWalkHold;
    const start = this.tabMRU.cancel();
    if (start == null) return this.finishTabWalk(); // start tab closed mid-walk: commit where we are
    if (start !== this.activeId) this.activate(start, { mruPreview: true });
    // the modifier is still physically down: re-prime the start tab so its keyUp
    // arrives (it then finds no walk and does nothing)
    this.tabWalkHold = hold;
    const tab = this.tabs.get(this.activeId);
    if (tab?.wc) this.primeTabWalkKeys(tab.wc);
    this.tabWalkHold = null;
    this.changed?.();
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
        if (!ql || t.title.toLowerCase().includes(ql) || t.customTitle.toLowerCase().includes(ql) || t.url.toLowerCase().includes(ql)) tabs.push(t);
      }
    }
    tabs.sort((a, b) => b.lastActive - a.lastActive);
    for (const t of tabs.slice(0, q ? 4 : 5)) {
      if (t.id === this.activeId) continue;
      out.push({ kind: 'tab', tabId: t.id, title: t.customTitle || t.title || t.url, url: t.url, favicon: t.favicon, sub: 'Switch to Tab' });
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
    clearInterval(this.groupTimer);
    for (const tab of this.tabs.values()) {
      this.mgr.internal?.check(tab, { removed: true });
      if (tab.devtools?.webContents && !tab.devtools.webContents.isDestroyed()) tab.devtools.webContents.close();
      if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    if (this.ui.webContents && !this.ui.webContents.isDestroyed()) this.ui.webContents.close();
    this.mgr.onWindowClosed(this);
  }
}

// keys that change the text of a field: printable characters, delete keys, enter (textareas),
// and cmd+v / cmd+x paste and cut. not navigation keys or other shortcuts.
function editingKey(input) {
  const k = input.key || '';
  if (input.meta || input.control) return !input.alt && /^[vx]$/i.test(k);
  return k.length === 1 || k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Process' || k === 'Dead';
}

// runs in the page's focused frame: is focus in a field the user can type into?
const EDITABLE_FOCUS_CHECK = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e) return false;
  if (e.isContentEditable) return true;
  if (e.disabled || e.readOnly) return false;
  if (e.tagName === 'TEXTAREA') return true;
  if (e.tagName !== 'INPUT') return false;
  const t = (e.getAttribute('type') || 'text').toLowerCase();
  return !['button','submit','reset','checkbox','radio','range','color','file','image','hidden'].includes(t);
})()`;

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
