// page dialogs (alert / confirm / prompt): the pure model in src/core/page-dialogs.js and the
// main-process queue in src/main/page-dialogs.js with a fake electron. native check:
// scripts/page-dialogs-native-test.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const D = require('../src/core/page-dialogs');

test('titles: "<host> says", embedded frames, local pages', () => {
  assert.equal(D.title('https://gateway.example.com/agents', '', true), 'gateway.example.com says');
  assert.equal(D.title('http://127.0.0.1:8080/x', '', true), '127.0.0.1:8080 says');
  assert.equal(D.title('https://a.com/', 'https://ads.b.com/f', false), 'An embedded page at ads.b.com says');
  assert.equal(D.title('https://a.com/', 'https://a.com/f', false), 'a.com says');
  assert.equal(D.title('https://a.com/', 'about:blank', false), 'a.com says');
  assert.equal(D.title('file:///Users/x/a.html', '', true), 'This page says');
  assert.equal(D.title('data:text/html,hi', '', true), 'This page says');
  assert.equal(D.title('chrome-extension://abc/options.html', '', true), 'An extension says');
});

test('normalize: three kinds only, strings only, capped sizes', () => {
  assert.equal(D.normalize('print', 'x', ''), null);
  assert.equal(D.normalize('__proto__', 'x', ''), null);
  assert.deepEqual(D.normalize('prompt', 'Name?', 'olive'), { kind: 'prompt', message: 'Name?', value: 'olive' });
  assert.deepEqual(D.normalize('confirm', 'Sure?', 'ignored'), { kind: 'confirm', message: 'Sure?', value: '' });
  assert.deepEqual(D.normalize('alert', { evil: 1 }, 5), { kind: 'alert', message: '', value: '' });
  const big = D.normalize('prompt', 'x'.repeat(D.MAX_MESSAGE + 50), 'y'.repeat(D.MAX_VALUE + 1));
  assert.equal(big.message.length, D.MAX_MESSAGE + 1);
  assert.ok(big.message.endsWith('…'));
  assert.equal(big.value.length, D.MAX_VALUE + 1);
});

test('results: what each kind returns, ok and cancel', () => {
  assert.equal(D.result('prompt', true, 'typed'), 'typed');
  assert.equal(D.result('prompt', true, ''), '');
  assert.equal(D.result('prompt', true, 42), '');
  assert.equal(D.result('prompt', false, 'typed'), null);
  assert.equal(D.result('confirm', true), true);
  assert.equal(D.result('confirm', false), false);
  assert.equal(D.result('confirm', 'yes'), false);
  assert.equal(D.result('alert', true), null);
  assert.equal(D.fallback('prompt'), null);
  assert.equal(D.fallback('confirm'), false);
  assert.equal(D.fallback('alert'), null);
});

test('page counter: offers "don\'t allow more" from the 3rd dialog, blocks, resets per load', () => {
  const c = new D.PageCounter();
  assert.equal(c.next(1), false);
  assert.equal(c.next(1), false);
  assert.equal(c.next(1), true);
  assert.equal(c.next(2), false, 'per page');
  assert.equal(c.blocked(1), false);
  c.block(1);
  assert.equal(c.blocked(1), true);
  assert.equal(c.blocked(2), false);
  c.reset(1);
  assert.equal(c.blocked(1), false);
  assert.equal(c.next(1), false);
});

// ---------- the main-process queue with a fake electron ----------

function fakeElectron() {
  const listeners = {};
  class Emitter { constructor() { this.l = {}; } on(n, f) { (this.l[n] ||= []).push(f); return this; } once(n, f) { const g = (...a) => { this.l[n] = this.l[n].filter((x) => x !== g); f(...a); }; return this.on(n, g); } emit(n, ...a) { for (const f of [...(this.l[n] || [])]) f(...a); } }
  class WC extends Emitter { constructor(url) { super(); this.id = WC.n = (WC.n || 0) + 1; this.url = url; this.sent = []; this.focused = false; } getURL() { return this.url; } send(ch, d) { this.sent.push(d); } focus() { this.focused = true; } isFocused() { return this.focused; } isDestroyed() { return false; } loadFile() { setImmediate(() => this.emit('did-finish-load')); } setWindowOpenHandler() {} close() {} }
  class WebContentsView { constructor() { this.webContents = new WC('file:///page-dialog.html'); this.visible = false; } setBackgroundColor() {} setVisible(v) { this.visible = v; } setBounds(b) { this.bounds = b; } }
  class Host extends Emitter { constructor() { super(); this.contentView = { children: [], addChildView: (v) => { this.contentView.children = this.contentView.children.filter((x) => x !== v).concat(v); }, removeChildView: (v) => { this.contentView.children = this.contentView.children.filter((x) => x !== v); } }; } isDestroyed() { return false; } getContentBounds() { return { width: 800, height: 600 }; } }
  class BrowserWindow extends Host { static fromWebContents() { return null; } }
  const ipcMain = { on: (ch, f) => { listeners[ch] = f; } };
  return { electron: { WebContentsView, BrowserWindow, ipcMain }, listeners, WC, Host };
}

function load(fake) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake.electron : orig.call(this, req, ...rest); };
  try { delete require.cache[require.resolve('../src/main/page-dialogs')]; return require('../src/main/page-dialogs'); } finally { Module._load = orig; }
}

test('queue: shows the visible tab\'s dialog, background ones wait, answers reach the page', async () => {
  const fake = fakeElectron();
  const { PageDialogs } = load(fake);
  const wcA = new fake.WC('https://a.com/'), wcB = new fake.WC('https://b.com/');
  const host = new fake.Host();
  const w = { win: host, destroyed: false, tabs: new Map([[1, { id: 1, wc: wcA }], [2, { id: 2, wc: wcB }]]), activeId: 1, panes: [{ id: 1, page: { x: 260, y: 8, width: 500, height: 580 } }], overlay: null, ui: { webContents: new fake.WC('ui') } };
  const mgr = { windows: [w] };
  const pd = new PageDialogs(mgr);
  const ev = (wc) => ({ sender: wc, senderFrame: { url: wc.getURL(), parent: null }, returnValue: undefined });

  const eb = ev(wcB);
  fake.listeners['olive:page-dialog'](eb, 'confirm', 'from b', '');
  const ea = ev(wcA);
  fake.listeners['olive:page-dialog'](ea, 'prompt', 'name?', 'olive');
  await new Promise((r) => setImmediate(r));
  const entry = pd.views.get(host);
  const shown = entry.view.webContents.sent.at(-1);
  assert.equal(shown.kind, 'prompt', 'the visible tab goes first even though b asked earlier');
  assert.equal(shown.title, 'a.com says');
  assert.equal(shown.value, 'olive');
  assert.deepEqual(entry.view.bounds, { x: 260, y: 8, width: 500, height: 580 }, 'covers the tab\'s pane only');
  assert.ok(entry.view.webContents.focused);
  assert.ok(host.contentView.children.includes(entry.view));

  // a stranger can't answer
  fake.listeners['olive:page-dialog-answer']({ sender: wcA }, shown.id, true, 'hacked', false);
  assert.equal(ea.returnValue, undefined);
  fake.listeners['olive:page-dialog-answer']({ sender: entry.view.webContents }, shown.id, true, 'ops', false);
  assert.equal(ea.returnValue, 'ops');
  assert.ok(!host.contentView.children.includes(entry.view), 'nothing pending on screen: the view leaves');
  assert.equal(eb.returnValue, undefined, 'b is still waiting');

  // the user opens b
  w.activeId = 2; w.panes = [{ id: 2, page: { x: 260, y: 8, width: 500, height: 580 } }];
  pd.layout(w);
  const s2 = entry.view.webContents.sent.at(-1);
  assert.equal(s2.message, 'from b');
  fake.listeners['olive:page-dialog-answer']({ sender: entry.view.webContents }, s2.id, false, '', false);
  assert.equal(eb.returnValue, false);
  assert.equal(pd.list().length, 0);
});

test('queue: navigation / close answer with cancel; unknown senders get the fallback at once', async () => {
  const fake = fakeElectron();
  const { PageDialogs } = load(fake);
  const wcA = new fake.WC('https://a.com/');
  const host = new fake.Host();
  const w = { win: host, destroyed: false, tabs: new Map([[1, { id: 1, wc: wcA }]]), activeId: 1, panes: [{ id: 1, page: { x: 0, y: 0, width: 10, height: 10 } }], overlay: null, ui: { webContents: new fake.WC('ui') } };
  const pd = new PageDialogs({ windows: [w] });
  const e1 = { sender: wcA, senderFrame: { url: 'https://a.com/', parent: null } };
  fake.listeners['olive:page-dialog'](e1, 'prompt', 'x', 'y');
  wcA.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(e1.returnValue, null);
  const e2 = { sender: wcA, senderFrame: null };
  fake.listeners['olive:page-dialog'](e2, 'confirm', 'x', '');
  wcA.emit('destroyed');
  assert.equal(e2.returnValue, false);
  const stranger = new fake.WC('https://c.com/');
  const e3 = { sender: stranger, senderFrame: null };
  fake.listeners['olive:page-dialog'](e3, 'prompt', 'x', 'y');
  assert.equal(e3.returnValue, null, 'not a tab, not a window: cancel value, never hangs');
  const e4 = { sender: wcA, senderFrame: null };
  fake.listeners['olive:page-dialog'](e4, 'shell', 'x', '');
  assert.equal(e4.returnValue, null);
  assert.equal(pd.list().length, 0);
});

// ---------- passkey prompt (electron has no webauthn ui; src/ui/webauthn-preload.js asks) ----------

test('passkey prompt: shown over the tab with only Cancel; Cancel tells that frame, the page ending it is silent', async () => {
  assert.equal(D.passkey('shell', 'x'), null);
  assert.match(D.passkey('create', 'webauthn.io').title, /Create a passkey for webauthn\.io/);
  assert.match(D.passkey('get', '').title, /this site/);
  assert.match(D.passkey('get', 'a.com').message, /security key/);
  assert.equal(D.normalize('passkey', 'x', ''), null, 'not a page dialog kind: the sync alert path rejects it');

  const fake = fakeElectron();
  const { PageDialogs } = load(fake);
  const wcA = new fake.WC('https://webauthn.io/');
  const host = new fake.Host();
  const w = { win: host, destroyed: false, tabs: new Map([[1, { id: 1, wc: wcA }]]), activeId: 1, panes: [{ id: 1, page: { x: 260, y: 8, width: 500, height: 580 } }], overlay: null, ui: { webContents: new fake.WC('ui') } };
  const pd = new PageDialogs({ windows: [w] });
  const frame = { url: wcA.getURL(), parent: null, sent: [], send(ch, id) { this.sent.push([ch, id]); }, isDestroyed: () => false };
  const ev = { sender: wcA, senderFrame: frame };
  fake.listeners['olive:webauthn-prompt'](ev, 7, 'create', 'webauthn.io');
  fake.listeners['olive:webauthn-prompt'](ev, 'x', 'create', 'webauthn.io'); // bad id: ignored
  await new Promise((r) => setImmediate(r));
  const entry = pd.views.get(host);
  const shown = entry.view.webContents.sent.at(-1);
  assert.equal(shown.kind, 'passkey');
  assert.match(shown.title, /webauthn\.io/);
  assert.equal(pd.list().length, 1);
  assert.ok(host.contentView.children.includes(entry.view));
  // a stranger can't cancel it
  fake.listeners['olive:page-dialog-answer']({ sender: wcA }, shown.id, false, '', false);
  assert.equal(frame.sent.length, 0);
  fake.listeners['olive:page-dialog-answer']({ sender: entry.view.webContents }, shown.id, false, '', false);
  assert.deepEqual(frame.sent, [['olive:webauthn-cancel', 7]]);
  assert.equal(pd.list().length, 0);
  // the request settled by itself (key touched, timeout): the page ends the prompt, no cancel sent
  fake.listeners['olive:webauthn-prompt'](ev, 8, 'get', 'webauthn.io');
  assert.equal(pd.list().length, 1);
  fake.listeners['olive:webauthn-prompt-end']({ sender: wcA, senderFrame: { other: true } }, 8); // another frame: no
  assert.equal(pd.list().length, 1);
  fake.listeners['olive:webauthn-prompt-end'](ev, 8);
  assert.equal(pd.list().length, 0);
  assert.equal(frame.sent.length, 1);
  assert.ok(!host.contentView.children.includes(entry.view));
});
