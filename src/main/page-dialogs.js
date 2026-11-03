// page dialogs: window.alert / confirm / prompt shown in olive's own popup.
// the page's preload (src/ui/page-dialogs-preload.js) asks over ipc sendSync; we keep the
// event and set returnValue when the user answers, so the page stays blocked meanwhile,
// like chrome. the popup is tab-modal: a transparent view over that tab's pane (the sidebar
// and other tabs keep working). a dialog from a tab that isn't on screen waits until the
// user opens that tab (chrome does the same); it never activates the tab or the window.
// popup windows (oauth etc.) get the popup over their whole content.
// passkeys: electron has no webauthn ui, so while a page's navigator.credentials.create/get
// waits for a security key, src/ui/webauthn-preload.js asks for a 'passkey' prompt here (async
// ipc, not sendSync: the page keeps running). it only has Cancel, which ends the page's call
// with NotAllowedError; the page ends the prompt itself when the call settles.
const { WebContentsView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const D = require('../core/page-dialogs');

class PageDialogs {
  constructor(mgr) {
    this.mgr = mgr;
    this.seq = 0;
    this.pending = new Map(); // id -> request
    this.views = new Map(); // BaseWindow -> { view, ready, shownId }
    this.counter = new D.PageCounter();
    this.wired = new WeakSet();
    ipcMain.on('olive:page-dialog', (e, kind, message, value) => this.request(e, kind, message, value));
    ipcMain.on('olive:page-dialog-answer', (e, id, ok, text, block) => {
      const req = this.pending.get(id);
      if (!req || this.views.get(req.host)?.view.webContents !== e.sender) return;
      if (block === true && req.offerBlock) {
        this.counter.block(req.key);
        for (const other of [...this.pending.values()]) if (other !== req && other.kind !== 'passkey' && other.key === req.key) this.finish(other, D.fallback(other.kind));
      }
      this.finish(req, req.kind === 'passkey' ? 'cancel' : D.result(req.kind, ok === true, text));
    });
    ipcMain.on('olive:webauthn-prompt', (e, pid, op, rpId) => this.passkey(e, pid, op, rpId));
    ipcMain.on('olive:webauthn-prompt-end', (e, pid) => {
      for (const r of [...this.pending.values()]) if (r.kind === 'passkey' && r.wc === e.sender && r.frame === e.senderFrame && r.pid === pid) this.finish(r, null);
    });
  }

  // ---------- requests ----------

  request(e, kind, message, value) {
    const n = D.normalize(kind, message, value);
    if (!n) { e.returnValue = null; return; }
    const wc = e.sender;
    const key = wc.id;
    this.wire(wc);
    if (this.counter.blocked(key)) { e.returnValue = D.fallback(n.kind); return; }
    const where = this.locate(wc);
    if (!where) { e.returnValue = D.fallback(n.kind); return; }
    const frame = e.senderFrame;
    const isMainFrame = !frame || !frame.parent;
    const req = {
      id: ++this.seq, ...n, key, wc, event: e,
      title: D.title(wc.getURL(), frame?.url || '', isMainFrame),
      offerBlock: this.counter.next(key),
      ...where,
    };
    this.pending.set(req.id, req);
    this.refresh(req.host);
  }

  // a page's webauthn request is waiting for an authenticator: show "insert your security key"
  passkey(e, pid, op, rpId) {
    const n = D.passkey(op, rpId);
    if (!n || !Number.isInteger(pid)) return;
    const wc = e.sender;
    this.wire(wc);
    const where = this.locate(wc);
    if (!where) return; // nowhere to show it: the request still ends at its timeout
    const frame = e.senderFrame;
    const req = {
      id: ++this.seq, kind: 'passkey', message: n.message, value: '', key: wc.id, wc, frame, pid,
      title: n.title, offerBlock: false, ...where,
      // 'cancel' (the user's Cancel, or the tab/window going away) ends the page's call
      done: (value) => { if (value !== 'cancel') return; try { if (frame && !frame.isDestroyed?.()) frame.send('olive:webauthn-cancel', pid); } catch {} },
    };
    this.pending.set(req.id, req);
    this.refresh(req.host);
  }

  // which window shows it: an olive window (tab-modal over the tab's pane) or a popup BrowserWindow
  locate(wc) {
    for (const w of this.mgr.windows) {
      if (w.destroyed || w.win.isDestroyed()) continue;
      for (const t of w.tabs.values()) if (t.wc === wc) return { host: w.win, olive: w, tabId: t.id };
    }
    const bw = BrowserWindow.fromWebContents(wc);
    if (bw && !bw.isDestroyed()) return { host: bw, olive: null, tabId: null };
    return null;
  }

  // one-time listeners per page: a new page load resets the count; leaving, crashing or
  // closing answers whatever is still open with the cancel value
  wire(wc) {
    if (this.wired.has(wc)) return;
    this.wired.add(wc);
    const drop = () => { for (const r of [...this.pending.values()]) if (r.wc === wc) this.finish(r, D.fallback(r.kind)); };
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) { this.counter.reset(wc.id); drop(); } });
    wc.on('render-process-gone', drop);
    wc.once('destroyed', () => { drop(); this.counter.reset(wc.id); });
  }

  finish(req, value) {
    if (!this.pending.has(req.id)) return;
    this.pending.delete(req.id);
    if (req.done) req.done(value);
    else try { req.event.returnValue = value; } catch {}
    this.refresh(req.host);
  }

  // ---------- the popup view ----------

  // the rect the popup covers, or null while the dialog's tab isn't on screen
  rectFor(req) {
    if (req.host.isDestroyed()) return null;
    if (!req.olive) { const b = req.host.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; }
    const w = req.olive;
    if (w.inlinePage && !w.inlinePage.isDestroyed?.()) return null;
    const pane = (w.panes || []).find((p) => p.id === req.tabId);
    return pane ? pane.page : null;
  }

  // the request this window should show now: the oldest whose tab is visible
  current(host) {
    let best = null;
    for (const r of this.pending.values()) if (r.host === host && this.rectFor(r) && (!best || r.id < best.id)) best = r;
    return best;
  }

  entry(host) {
    let e = this.views.get(host);
    if (e) return e;
    const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '../ui/page-dialog-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    e = { view, ready: false, shownId: null };
    this.views.set(host, e);
    view.webContents.on('will-navigate', (ev) => ev.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.once('did-finish-load', () => { e.ready = true; this.refresh(host); });
    view.webContents.loadFile(path.join(__dirname, '../ui/page-dialog.html'));
    const onResize = () => this.refresh(host);
    if (host instanceof BrowserWindow) host.on('resize', onResize);
    host.once('closed', () => {
      for (const r of [...this.pending.values()]) if (r.host === host) this.finish(r, D.fallback(r.kind));
      this.views.delete(host);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    });
    return e;
  }

  refresh(host) {
    if (!host || host.isDestroyed()) return;
    const req = this.current(host);
    let e = this.views.get(host);
    if (!req) {
      if (e && e.shownId != null) {
        const focused = !e.view.webContents.isDestroyed() && e.view.webContents.isFocused();
        e.shownId = null;
        e.view.setVisible(false);
        host.contentView.removeChildView(e.view);
        if (e.ready) e.view.webContents.send('olive:page-dialog', null);
        if (focused) this.refocus(host);
      }
      return;
    }
    e = e || this.entry(host);
    if (!e.ready) return;
    const rect = this.rectFor(req);
    e.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    host.contentView.addChildView(e.view); // on top of the tab, the permission cards and the ui
    e.view.setVisible(true);
    if (e.shownId === req.id) return;
    e.shownId = req.id;
    e.view.webContents.send('olive:page-dialog', { id: req.id, kind: req.kind, title: req.title, message: req.message, value: req.value, offerBlock: req.offerBlock });
    // keyboard goes to the dialog when it appears (enter / esc), unless the user is typing in
    // olive's own palette; later layouts never pull focus back
    const w = req.olive;
    if (!w || !(w.overlay && w.ui.webContents.isFocused())) e.view.webContents.focus();
  }

  refocus(host) {
    const w = this.mgr.windows.find((x) => x.win === host);
    if (w) w.tabs.get(w.activeId)?.wc?.focus();
    else if (host instanceof BrowserWindow) host.webContents.focus();
  }

  // window.layout() / setOverlay(): panes moved, a tab was shown or hidden
  layout(oliveWindow) { if (oliveWindow?.win) this.refresh(oliveWindow.win); }

  // for tests and the agent api: what's open
  list() { return [...this.pending.values()].map((r) => ({ id: r.id, kind: r.kind, title: r.title, message: r.message, value: r.value, tabId: r.tabId, shown: this.views.get(r.host)?.shownId === r.id })); }
}

module.exports = { PageDialogs };
