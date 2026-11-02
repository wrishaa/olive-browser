const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeBrowser, FakeWindow, eventFrom } = require('./helpers/fake-browser');
const { blockedNavigation, HEADERS } = require('../src/main/internal-pages');

test('ipc trusts only the main frame of an olive:// tab of the right page, in a normal window', () => {
  const mgr = fakeBrowser();
  const w = new FakeWindow(mgr), p = new FakeWindow(mgr, { isPrivate: true });
  const settings = w.createTab({ url: 'olive://settings/shortcuts' });
  const web = w.createTab({ url: 'https://example.com/' });
  const I = mgr.internal;
  assert.equal(I.sender(eventFrom(settings), 'settings').tab, settings);
  assert.equal(I.sender(eventFrom(settings), 'settings', { tab: 'shortcuts' }).page.tab, 'shortcuts');
  assert.equal(I.sender(eventFrom(settings), 'settings', { tab: 'general' }), null, 'another section');
  assert.equal(I.sender(eventFrom(settings), 'ledger'), null, 'another page');
  assert.equal(I.sender(eventFrom(settings, { url: 'olive://settings/shortcuts' }), 'settings'), null, 'a subframe');
  assert.equal(I.sender(eventFrom(web), 'settings'), null, 'a web page');
  web.wc.mainFrame.url = 'olive://settings'; // the tab navigated there (main reports frame urls, pages can't set them)
  assert.ok(I.sender(eventFrom(web), 'settings'), 'the frame url main reports is what counts');
  const priv = p.createTab({ url: 'olive://ledger' });
  assert.equal(I.sender(eventFrom(priv), 'ledger'), null, 'never in a private window');
  const stray = { sender: { mainFrame: { url: 'olive://ledger' }, isDestroyed: () => false }, senderFrame: null };
  stray.senderFrame = stray.sender.mainFrame;
  assert.equal(I.sender(stray, 'ledger'), null, 'not a tab (popup window, devtools, ...)');
  assert.equal(I.sender({}, 'ledger'), null);
});

test('open reuses a tab in the current window first, then other windows; private windows hand off', () => {
  const mgr = fakeBrowser();
  const a = new FakeWindow(mgr), b = new FakeWindow(mgr), p = new FakeWindow(mgr, { isPrivate: true });
  mgr.focused = a;
  const I = mgr.internal;
  const first = I.openSettings(undefined);
  assert.equal(first.url, 'olive://settings'); assert.equal(a.activeId, first.id);
  a.createTab({ url: 'https://x.example/' });
  assert.equal(I.openSettings(undefined), first, 'cmd+, focuses the open Settings tab');
  assert.equal(a.activeId, first.id);
  first.url = 'olive://settings/shortcuts';
  I.openSettings(undefined);
  assert.equal(first.url, 'olive://settings/shortcuts', 'cmd+, leaves its section alone');
  I.openSettings('extensions');
  assert.equal(first.url, 'olive://settings/extensions', 'a named section navigates it');
  mgr.focused = b;
  const inB = b.createTab({ url: 'olive://settings/general' });
  assert.equal(I.openSettings(undefined), inB, 'the current window wins');
  b.closeTab(inB.id);
  assert.equal(I.openSettings(undefined), first, 'else any window');
  mgr.focused = p;
  const led = I.open('olive://ledger');
  assert.ok(!p.tabs.has(led.id), 'a private window opens it in a normal one');
  assert.equal(I.tabs('ledger').length, 1);
});

test('views follow their tab: navigating away or closing it is "closed"; restored tabs are adopted', () => {
  const mgr = fakeBrowser();
  const w = new FakeWindow(mgr); mgr.focused = w;
  const I = mgr.internal;
  const restored = w.createTab({ url: 'olive://onboarding/screen' });
  w.createTab({ url: 'https://x.example/' });
  const v = I.view('olive://onboarding/welcome', { win: w });
  assert.equal(v.tab, restored, 'an open setup tab is adopted, not duplicated');
  assert.equal(w.activeId, restored.id);
  assert.equal(I.view('olive://onboarding', { win: w }), v);
  const why = [];
  v.on('closed', r => why.push(r));
  w.navigate(restored, 'olive://onboarding/done');
  assert.equal(v.isDestroyed(), false, 'a step change is the same page');
  w.navigate(restored, 'https://elsewhere.example/');
  assert.deepEqual(why, ['navigated']);
  const v2 = I.view('olive://onboarding/welcome', { win: w });
  assert.notEqual(v2.tab, restored);
  v2.close();
  assert.ok(!w.tabs.has(v2.tab.id), 'close() closes the tab');
  assert.equal(v2.isDestroyed(), true);
});

test('scheme handler: pages and assets from src/ui only, redirects, no framing, 404 otherwise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-ui-'));
  fs.writeFileSync(path.join(dir, 'settings-general.html'), '<p>general</p>');
  fs.writeFileSync(path.join(dir, 'settings-nav.js'), 'nav()');
  fs.writeFileSync(path.join(dir, 'olive-preload.js'), 'secret()');
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.js'), 'x');
  const mgr = fakeBrowser();
  const I = new (require('../src/main/internal-pages').InternalPages)(mgr, { uiDir: dir });
  const get = url => I.respond({ url });
  let r = await get('olive://settings');
  assert.equal(r.status, 200); assert.equal(await r.text(), '<p>general</p>');
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  r = await get('olive://settings/settings-nav.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  for (const bad of ['olive://settings/olive-preload.js', 'olive://settings/../outside.js', 'olive://settings/%2e%2e%2foutside.js', 'olive://nope', 'olive://settings/nope', 'olive://ledger'])
    assert.equal((await get(bad)).status, 404, bad);
  r = await get('olive://extensions');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'olive://settings/extensions');
  r = await get('olive://extensions/ublock/options');
  assert.equal(r.status, 200); assert.match(await r.text(), /http-equiv="refresh"/, 'uBO not up yet: a waiting page that retries');
  assert.ok(HEADERS['X-Frame-Options']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('web pages may not navigate into olive:// or the uBO pages; olive pages may', () => {
  const mgr = fakeBrowser({ extensions: { ext: { id: 'abcdefghijklmnopabcdefghijklmnop' } } });
  const I = mgr.internal;
  const ubo = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/dashboard.html';
  assert.equal(blockedNavigation('https://evil.example/', 'olive://settings', I), true);
  assert.equal(blockedNavigation('https://evil.example/', ubo, I), true);
  assert.equal(blockedNavigation('', 'olive://settings', I), true, 'no origin: blocked (main loads olive:// directly)');
  assert.equal(blockedNavigation('olive://settings/', 'olive://settings/shortcuts', I), false);
  assert.equal(blockedNavigation('olive://extensions/ublock', ubo, I), false);
  assert.equal(blockedNavigation('https://a.example/', 'https://b.example/', I), false);
  assert.equal(I.displayUrl(ubo + '#settings'), 'olive://extensions/ublock/options#settings');
  assert.equal(I.displayUrl('olive://settings/'), 'olive://settings');
  assert.equal(I.displayUrl('olive://settings/?section=x'), 'olive://settings?section=x');
  assert.equal(I.resolveLoad('olive://extensions/ublock/options'), ubo);
  assert.equal(I.resolveLoad('olive://unloading'), 'olive://settings/general?section=unloading');
  assert.equal(I.resolveLoad('olive:ledger'), 'olive://ledger');
  assert.equal(I.resolveLoad('https://x.example/'), 'https://x.example/');
});
