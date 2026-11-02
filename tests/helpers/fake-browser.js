// A tiny stand-in for Olive's windows and tabs, enough for InternalPages (the olive:// sender
// check, open/reuse, views) and the controllers that answer olive:// pages.
const { EventEmitter } = require('node:events');
const { InternalPages } = require('../../src/main/internal-pages');
let ids = 0, clock = 0;
function fakeWc(url) {
  const wc = new EventEmitter();
  wc.id = ++ids; wc.mainFrame = { url }; wc.sent = []; wc.dead = false;
  wc.isDestroyed = () => wc.dead;
  wc.send = (channel, value) => wc.sent.push([channel, value]);
  wc.focus = () => {};
  return wc;
}
class FakeWindow {
  constructor(mgr, { isPrivate = false } = {}) {
    this.mgr = mgr; this.id = ++ids; this.isPrivate = isPrivate; this.destroyed = false;
    this.win = Object.assign(new EventEmitter(), { show() {}, focus() {}, isDestroyed: () => this.destroyed });
    this.tabs = new Map(); this.activeId = null; this.closed = [];
    mgr.windows.push(this);
  }
  createTab({ url = '', activate = true } = {}) {
    const tab = { id: ++ids, url, lastActive: 0, pinned: false, wc: fakeWc(url) };
    this.tabs.set(tab.id, tab);
    if (activate) this.activate(tab.id);
    return tab;
  }
  activate(id) { this.activeId = id; const t = this.tabs.get(id); if (t) t.lastActive = ++clock; }
  // a committed navigation: the main frame's url changes with it
  navigate(tab, url) { tab.url = url; tab.wc.mainFrame.url = url; this.mgr.internal.check(tab); }
  closeTab(id) { const tab = this.tabs.get(id); if (!tab) return; this.tabs.delete(id); this.closed.push(tab); tab.wc.dead = true; this.mgr.internal.check(tab, { removed: true }); }
}
function fakeBrowser(extra = {}) {
  const mgr = { windows: [], focused: null, ...extra };
  mgr.focusedWindow = () => mgr.focused;
  mgr.newWindow = (o = {}) => new FakeWindow(mgr, o);
  mgr.internal = new InternalPages(mgr);
  return mgr;
}
// the ipc event a tab's main frame (or a subframe) sends
const eventFrom = (tab, frame = tab.wc.mainFrame) => ({ sender: tab.wc, senderFrame: frame });
module.exports = { fakeBrowser, FakeWindow, eventFrom, fakeWc };
