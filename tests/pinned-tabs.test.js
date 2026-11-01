// pinned tabs: domain lock + reset, rename tab (src/core/tab-meta.js and the OliveWindow model),
// with fakes only: no electron, no real profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const TM = require('../src/core/tab-meta');

const original = Module._load;
Module._load = function (id, ...rest) {
  if (id === 'electron') return { Menu: {}, clipboard: { writeText() {} }, shell: {}, nativeTheme: {}, app: {}, BaseWindow: class {}, WebContentsView: class {} };
  return original.call(this, id, ...rest);
};
const { OliveWindow, Tab } = require('../src/main/window');
Module._load = original;

// a window with the real model methods and no views: tabs never load
function fakeWindow() {
  const w = Object.create(OliveWindow.prototype);
  Object.assign(w, {
    id: 1, isPrivate: false, destroyed: false, tabs: new Map(), pinned: [], unpinned: [], agent: [], agentOrder: [],
    splits: new Map(), groups: new Map(), selection: [], activeId: null, closedStack: [], loads: [],
    tabMRU: { touch() {}, remove() {} },
    mgr: { saveSoon() {}, applyUserAgent() {}, ledger: null },
  });
  w.ensureView = (tab) => tab;
  w.layout = () => {};
  w.changed = () => {};
  w.sendState = () => {};
  w.send = (ch, d) => { (w.sent ||= []).push([ch, d]); };
  w.activate = (id) => { w.activeId = id; };
  w.add = (url, opts = {}) => {
    const t = new Tab(w, { url, title: opts.title || '', pinned: !!opts.pinned, pinnedUrl: opts.pinnedUrl });
    w.tabs.set(t.id, t);
    (t.pinned ? w.pinned : w.unpinned).push(t.id);
    return t;
  };
  return w;
}

const labels = (tpl) => tpl.filter((x) => x.label).map((x) => x.label);
const item = (tpl, label) => tpl.find((x) => x.label === label);

test('siteOf: registrable domain, ips and localhost are their own site', () => {
  assert.equal(TM.siteOf('https://mail.google.com/mail/u/0/'), 'google.com');
  assert.equal(TM.siteOf('https://accounts.google.com/signin'), 'google.com');
  assert.equal(TM.siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(TM.siteOf('https://a.b.example.com.au/'), 'example.com.au');
  assert.equal(TM.siteOf('https://dj.github.io/x'), 'dj.github.io');
  assert.equal(TM.siteOf('http://127.0.0.1:8080/a'), '127.0.0.1');
  assert.equal(TM.siteOf('http://localhost:8080/a'), 'localhost');
  assert.equal(TM.siteOf('data:text/html,hi'), null);
  assert.equal(TM.siteOf('about:blank'), null);
  assert.equal(TM.siteOf('not a url'), null);
  assert.ok(TM.sameSite('https://mail.google.com', 'https://google.com/'));
  assert.ok(!TM.sameSite('https://google.com', 'https://github.com'));
  assert.ok(!TM.sameSite('https://a.github.io', 'https://b.github.io'));
  assert.ok(!TM.sameSite('http://127.0.0.1:1/', 'http://localhost:1/'));
});

test('domain lock: only cross-site, non-auth targets while the tab is on its pinned site', () => {
  const pinnedUrl = 'https://mail.google.com/mail/u/0/';
  const go = (targetUrl, currentUrl = pinnedUrl) => TM.shouldOpenOutside({ pinnedUrl, currentUrl, targetUrl });
  assert.equal(go('https://mail.google.com/mail/u/0/#inbox/123'), false, 'same page');
  assert.equal(go('https://drive.google.com/'), false, 'same site, other subdomain');
  assert.equal(go('https://accounts.google.com/ServiceLogin'), false, 'same-site sign-in');
  assert.equal(go('https://github.com/olive'), true, 'other site');
  assert.equal(go('http://localhost:3000/'), true);
  assert.equal(go('https://login.microsoftonline.com/common/oauth2/authorize'), false, 'identity provider');
  assert.equal(go('https://example.com/oauth/authorize?client_id=1'), false, 'oauth path');
  assert.equal(go('https://news.ycombinator.com/', 'https://idp.example.com/sso'), false, 'mid sso hop: off-site already');
  assert.equal(go('mailto:a@b.c'), false, 'non-http');
  assert.equal(go('javascript:void 0'), false);
  assert.equal(TM.shouldOpenOutside({ pinnedUrl: 'data:text/html,x', currentUrl: '', targetUrl: 'https://github.com' }), false, 'no site to lock to');
});

test('drifted: ignores fragment and a trailing slash', () => {
  assert.equal(TM.drifted('https://a.com/', 'https://a.com'), false);
  assert.equal(TM.drifted('https://a.com/x', 'https://a.com/x#y'), false);
  assert.equal(TM.drifted('https://a.com/x', 'https://a.com/y'), true);
  assert.equal(TM.drifted('https://a.com/x', 'https://a.com/x?q=1'), true);
  assert.equal(TM.drifted('', 'https://a.com/'), false);
});

test('pinning remembers the url, unpinning forgets it; snapshot reports drift', () => {
  const w = fakeWindow();
  const t = w.add('https://app.example.com/home');
  assert.equal(t.pinnedUrl, '');
  w.setPinned(t.id, true);
  assert.equal(t.pinned, true);
  assert.equal(t.pinnedUrl, 'https://app.example.com/home');
  assert.equal(t.snapshot().drifted, false);
  t.url = 'https://app.example.com/settings';
  assert.equal(t.snapshot().drifted, true);
  assert.equal(t.snapshot().pinnedUrl, 'https://app.example.com/home');
  w.setPinned(t.id, false);
  assert.equal(t.pinnedUrl, '');
  w.setPinned(t.id, true); // re-pin: the current url
  assert.equal(t.pinnedUrl, 'https://app.example.com/settings');
});

test('session: pinnedUrl survives serialize/restore, old sessions fall back to url', () => {
  const t = new Tab(null, { url: 'https://a.com/now', pinned: true, pinnedUrl: 'https://a.com/start' });
  assert.equal(t.pinnedUrl, 'https://a.com/start');
  assert.equal(new Tab(null, { url: 'https://a.com/now', pinned: true }).pinnedUrl, 'https://a.com/now');
  assert.equal(new Tab(null, { url: 'https://a.com/now', pinnedUrl: 'https://x.com' }).pinnedUrl, '', 'unpinned tabs carry none');
  const w = fakeWindow();
  w.win = { isDestroyed: () => true };
  const p = w.add('https://a.com/now', { pinned: true, pinnedUrl: 'https://a.com/start' });
  w.add('https://b.com/');
  const s = w.serialize();
  assert.equal(s.tabs.find((x) => x.key === p.id).pinnedUrl, 'https://a.com/start');
  assert.equal(s.tabs.find((x) => x.key !== p.id).pinnedUrl, undefined);
});

test('reset and set-as-pinned-url menu items, only for a drifted pinned tab', () => {
  const w = fakeWindow();
  const p = w.add('https://a.com/start', { pinned: true });
  let tpl = w.tabMenuTemplate(p.id);
  assert.ok(labels(tpl).includes('Reset Pinned Tab'));
  assert.equal(item(tpl, 'Reset Pinned Tab').enabled, false);
  assert.equal(item(tpl, 'Set Current URL as Pinned URL').enabled, false);
  p.url = 'https://a.com/elsewhere';
  tpl = w.tabMenuTemplate(p.id);
  assert.equal(item(tpl, 'Reset Pinned Tab').enabled, true);
  // reset: back to the pinned url (unloaded tab: just the url, activates it)
  item(tpl, 'Reset Pinned Tab').click();
  assert.equal(p.url, 'https://a.com/start');
  assert.equal(w.activeId, p.id);
  // set current url as pinned
  p.url = 'https://a.com/new-home';
  item(w.tabMenuTemplate(p.id), 'Set Current URL as Pinned URL').click();
  assert.equal(p.pinnedUrl, 'https://a.com/new-home');
  assert.equal(p.snapshot().drifted, false);
  // normal tabs never show them
  const n = w.add('https://b.com/');
  assert.ok(!labels(w.tabMenuTemplate(n.id)).includes('Reset Pinned Tab'));
});

test('custom title: cleaned, wins over the page title, empty means none', () => {
  assert.equal(TM.cleanTitle('  My\n  Inbox  '), 'My Inbox');
  assert.equal(TM.cleanTitle(null), '');
  assert.equal(TM.cleanTitle('x'.repeat(300)).length, 200);
  assert.equal(TM.shownTitle({ customTitle: 'Mail', title: 'Inbox (3) - Gmail' }), 'Mail');
  assert.equal(TM.shownTitle({ customTitle: '   ', title: 'Inbox (3) - Gmail' }), 'Inbox (3) - Gmail');
  assert.equal(TM.shownTitle({ customTitle: '', title: '' }, 'a.com'), 'a.com');
});

test('rename tab: sticks over page title changes, reset and empty go back, persists', () => {
  const w = fakeWindow();
  w.win = { isDestroyed: () => true };
  for (const pinned of [false, true]) {
    const t = w.add('https://a.com/' + pinned, { title: 'Page A', pinned });
    let tpl = w.tabMenuTemplate(t.id);
    assert.ok(labels(tpl).includes('Rename Tab…'));
    assert.equal(item(tpl, 'Reset Tab Name').enabled, false);
    item(tpl, 'Rename Tab…').click();
    assert.deepEqual(w.sent.at(-1), ['rename-tab', { id: t.id }]);
    w.cmd('renameTab', { id: t.id, name: '  Work   mail ' });
    assert.equal(t.snapshot().title, 'Work mail');
    t.title = 'Inbox (4)'; // the page retitles itself
    assert.equal(t.snapshot().title, 'Work mail');
    assert.equal(t.snapshot().pageTitle, 'Inbox (4)');
    // persists
    const saved = w.serialize().tabs.find((x) => x.key === t.id);
    assert.equal(saved.customTitle, 'Work mail');
    assert.equal(new Tab(null, saved).snapshot().title, 'Work mail');
    tpl = w.tabMenuTemplate(t.id);
    item(tpl, 'Reset Tab Name').click();
    assert.equal(t.snapshot().title, 'Inbox (4)');
    assert.equal(w.serialize().tabs.find((x) => x.key === t.id).customTitle, undefined);
    w.renameTab(t.id, 'again');
    w.cmd('renameTab', { id: t.id, name: '   ' }); // clearing the field
    assert.equal(t.snapshot().title, 'Inbox (4)');
  }
});
