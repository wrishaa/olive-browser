// Olive's own pages are normal tabs at olive:// urls (src/core/olive-url.js).
//
// - the scheme is registered privileged (standard + secure) before ready, and handled per
//   profile session (main.js setupSession). private sessions don't serve it: an olive:// url
//   in a private window opens in a normal window instead.
// - pages and their css/js come only from src/ui, by plain file name. every response says
//   frame-ancestors 'none' / X-Frame-Options DENY / CORP same-origin, so no web page can
//   frame or embed them; the navigation guards in window.js stop web pages from navigating,
//   redirecting or window.open-ing to olive:// (typed urls, menus and palette still can).
// - one frame preload (ui/olive-preload.js) exposes the page bridges only in an olive://
//   main frame; main answers internal ipc only through sender() below: the sender is the
//   main frame of a tab in a normal window, currently at the expected olive:// page.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const U = require('../core/olive-url');

const UI = path.join(__dirname, '..', 'ui');
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };
const HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const WAITING = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>uBO Lite</title>'
  + '<style>body{font:13px -apple-system,system-ui;color:#777;display:grid;place-items:center;height:90vh}</style><p>uBO Lite is starting…</p>';

class InternalPages {
  constructor(mgr, { uiDir = UI } = {}) { this.mgr = mgr; this.uiDir = uiDir; this.views = new Set(); }

  // protocol.handle('olive', ...) -> a fetch Response
  async respond(request) {
    const r = U.parseOliveUrl(request.url);
    if (r?.kind === 'redirect') return new Response(null, { status: 302, headers: { ...HEADERS, Location: r.location } });
    // an extension page asked for before the extension is up (session restore): wait, then
    // try again (the refresh is a navigation main resolves to the extension page)
    if (r?.kind === 'extension') return new Response(WAITING, { status: 200, headers: { ...HEADERS, 'Content-Type': TYPES.html } });
    const file = r?.kind === 'page' ? r.file : r?.kind === 'asset' ? r.asset : null;
    const full = file && path.join(this.uiDir, file);
    let body = null;
    if (full && path.dirname(full) === this.uiDir) { try { body = await fs.promises.readFile(full); } catch {} }
    if (!body) return new Response('Not found', { status: 404, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(body, { status: 200, headers: { ...HEADERS, 'Content-Type': TYPES[path.extname(file).slice(1)] || 'application/octet-stream' } });
  }

  extensionId() { return this.mgr.extensions?.ext?.id || null; }
  // what a tab loads for a url: olive://extensions/ublock/<page> is the extension's own page
  // (old names go straight to their new address, olive:settings to olive://settings)
  resolveLoad(url, hops = 0) {
    const ext = U.extensionLoadUrl(url, this.extensionId());
    if (ext) return ext;
    const r = U.parseOliveUrl(url);
    if (r?.kind === 'redirect' && hops < 2) return this.resolveLoad(r.location, hops + 1);
    return r ? r.url : url;
  }
  // what the address bar (and session, history, agent api) shows for a committed url
  // (chromium writes a bare olive://settings as olive://settings/: show it without the slash)
  displayUrl(url) {
    const ext = U.extensionDisplayUrl(url, this.extensionId());
    if (ext) return ext;
    return typeof url === 'string' ? url.replace(/^(olive:\/\/[a-z0-9-]+)\/(?=$|[?#])/i, '$1') : url;
  }
  isInternal(url) { return U.isOliveUrl(url) || !!U.extensionDisplayUrl(url, this.extensionId()); }

  tabForWebContents(wc) {
    for (const w of this.mgr.windows) for (const t of w.tabs.values()) if (t.wc && t.wc === wc) return { win: w, tab: t };
    return null;
  }
  // the ipc trust check: -> { win, tab, page } or null
  sender(event, host, { tab: settingsTab = null } = {}) {
    const wc = event?.sender, frame = event?.senderFrame;
    if (!wc || !frame || wc.isDestroyed?.() || frame !== wc.mainFrame) return null;
    const page = U.parseOliveUrl(frame.url);
    if (!page || page.kind !== 'page' || page.host !== host) return null;
    if (settingsTab && page.tab !== settingsTab) return null;
    const found = this.tabForWebContents(wc);
    if (!found || found.win.isPrivate || found.win.destroyed) return null;
    return { ...found, page };
  }
  // tabs currently showing a page of this host (pushing state to them)
  tabs(host, test = () => true) {
    const out = [];
    for (const w of this.mgr.windows) {
      if (w.isPrivate || w.destroyed) continue;
      for (const t of w.tabs.values()) {
        const page = U.parseOliveUrl(t.url);
        if (page && page.host === host && test(page, t)) out.push({ win: w, tab: t, page });
      }
    }
    return out;
  }
  send(host, channel, payload, test) {
    for (const { tab } of this.tabs(host, test)) if (tab.wc && !tab.wc.isDestroyed()) tab.wc.send(channel, payload);
  }

  normalWindow(win = this.mgr.focusedWindow()) {
    if (win && !win.isPrivate && !win.destroyed) return win;
    const w = this.mgr.windows.filter(x => !x.isPrivate && !x.destroyed).pop() || this.mgr.newWindow({});
    return w;
  }
  // open an olive:// url as a tab. reuse(page, tab) picks an existing tab to focus instead:
  // the current window first, then the others; within a window the most recently used.
  // navigate: load url into the reused tab when it shows something else.
  open(url, { win = this.mgr.focusedWindow(), reuse = null, navigate = false, activate = true } = {}) {
    const home = this.normalWindow(win);
    if (reuse) {
      const found = this.tabs(U.parseOliveUrl(url)?.host || '', reuse)
        .sort((a, b) => (b.win === home) - (a.win === home) || (b.tab.lastActive || 0) - (a.tab.lastActive || 0))[0];
      if (found) {
        const { win: w, tab } = found;
        if (navigate && tab.url !== url) w.navigate(tab, url);
        w.win.show(); w.win.focus(); w.activate(tab.id);
        return tab;
      }
    }
    home.win.show(); home.win.focus();
    return home.createTab({ url, activate });
  }
  // Settings: cmd+, (tab undefined) focuses an existing Settings tab as it is; an entry
  // point that names a tab (Keyboard Shortcuts…, Extensions…, site permissions) also shows
  // that tab in it. no Settings tab: a new foreground tab.
  openSettings(tab, { section = null, origin = null, win } = {}) {
    const url = U.settingsUrl(tab || 'general', { section, origin });
    return this.open(url, { win, reuse: () => true, navigate: !!tab });
  }

  // a controller that used to own a panel (onboarding) keeps its view-shaped handle:
  // show/focus/close/isDestroyed/'closed', backed by an olive:// tab. an open tab of that
  // host (restored from the session, or typed) is adopted instead of opening another.
  view(url, { win, host = U.parseOliveUrl(url)?.host } = {}) {
    for (const v of this.views) if (!v.closed && v.host === host) return v;
    const existing = this.tabs(host, p => p.kind === 'page')
      .sort((a, b) => (b.win === win) - (a.win === win) || (b.tab.lastActive || 0) - (a.tab.lastActive || 0))[0];
    if (existing) { existing.win.win.show(); existing.win.win.focus(); existing.win.activate(existing.tab.id); return this.adopt(existing.win, existing.tab, host); }
    const tab = this.open(url, { win });
    const owner = this.mgr.windows.find(w => w.tabs.get(tab?.id) === tab);
    return tab && owner ? this.adopt(owner, tab, host) : null;
  }
  adopt(win, tab, host) {
    for (const v of this.views) if (!v.closed && v.tab === tab && v.host === host) return v;
    const v = new TabView(this, win, tab, host);
    this.views.add(v);
    return v;
  }
  // window.js calls this when a tab commits a navigation, is closed for good, or its window
  // goes away: a view whose tab no longer shows its page is gone ('closed')
  check(tab, { removed = false } = {}) {
    for (const v of [...this.views]) {
      if (v.tab !== tab) continue;
      const page = U.parseOliveUrl(tab.url);
      if (removed || !page || page.host !== v.host) v.gone(removed ? 'closed' : 'navigated');
    }
  }
}

class TabView extends EventEmitter {
  constructor(internal, win, tab, host) { super(); this.internal = internal; this.win = win; this.tab = tab; this.host = host; this.closed = false; }
  get owner() { return this.win; }
  get webContents() { return this.tab.wc && !this.tab.wc.isDestroyed() ? this.tab.wc : null; }
  isDestroyed() { return this.closed; }
  show() { if (this.closed || this.win.destroyed) return; this.win.win.show(); this.win.activate(this.tab.id); }
  focus() { if (this.closed || this.win.destroyed) return; this.win.win.focus(); this.tab.wc?.focus(); }
  setMenu() {}
  // the controller closes its page (setup finished / later): close the tab for good
  close() {
    if (this.closed) return;
    if (!this.win.destroyed && this.win.tabs.get(this.tab.id) === this.tab) this.win.closeTab(this.tab.id, { force: true });
    this.gone('closed');
  }
  gone(reason) {
    if (this.closed) return;
    this.closed = true;
    this.internal.views.delete(this);
    this.emit('closed', reason);
  }
}

// web content may not reach olive:// (or the extension pages behind it) by itself: links,
// form posts, redirects, window.open, iframes. a page that is itself internal may.
function blockedNavigation(fromUrl, toUrl, internal) {
  const target = internal ? internal.isInternal(toUrl) : U.isOliveUrl(toUrl);
  if (!target) return false;
  const from = internal ? internal.isInternal(fromUrl || '') : U.isOliveUrl(fromUrl || '');
  return !from;
}

module.exports = { InternalPages, TabView, blockedNavigation, HEADERS };
