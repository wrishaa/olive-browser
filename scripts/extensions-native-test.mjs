// Own disposable Electron process only: no installed app, real profiles or external requests.
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-extensions-native-'));
let adRequests = 0;
const server = http.createServer((req, res) => {
  if (req.headers.host.startsWith('doubleclick.net:')) adRequests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Local blocker fixture</title>local only');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const modulePath = path.resolve('src/main/extensions.js');
const fixture = path.join(root, 'fixture.cjs');
fs.writeFileSync(fixture, `
const { app, session, BrowserWindow } = require('electron');
const { EventEmitter } = require('node:events');
app.setPath('userData', ${JSON.stringify(root)});
app.commandLine.appendSwitch('host-resolver-rules', 'MAP doubleclick.net 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
global.start = app.whenReady().then(async () => {
  global.changes = new EventEmitter();
  const { Extensions } = require(${JSON.stringify(modulePath)});
  global.OliveWindow = require(${JSON.stringify(path.resolve('src/main/window.js'))}).OliveWindow;
  global.extensions = new Extensions({ dataPath: ${JSON.stringify(root)}, broadcast() { changes.emit('state'); } });
  global.events = [];
  for (const name of ['extension-loaded', 'extension-ready', 'extension-unloaded']) {
    session.defaultSession.extensions.on(name, (_event, ext) => events.push({ name, id: ext.id }));
  }
  await extensions.load(session.defaultSession);
});
app.on('window-all-closed', () => {});
`);
let app, checks = 0;
const check = (value, label) => { assert.ok(value, label); console.log('ok  ' + label); checks++; };
try {
  app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [fixture], timeout: 30000 });
  const fresh = await app.evaluate(async ({ BrowserWindow }) => {
    await global.start;
    const x = global.extensions;
    return { status: x.status, hidden: !x.helper.isVisible(), windows: BrowserWindow.getAllWindows().length,
      ready: await x.helper.webContents.executeJavaScript(`({ state:document.readyState, id:chrome.runtime.id, version:chrome.runtime.getManifest().version })`) };
  });
  check(fresh.status.installed && fresh.status.enabled && fresh.status.rulesets.length === 6, 'fresh default blocker enabled without fixture helper reload');
  check(fresh.hidden && fresh.windows === 1 && fresh.ready.state === 'complete' && fresh.ready.id === fresh.status.id, 'sole helper stays hidden and has a complete, live extension document');
  // The unmodified worker may restart once just after initial load. Toggle immediately
  // as well as forcing runtime.reload below, so a successful load is not enough.
  const toggles = await app.evaluate(async () => {
    const x = global.extensions;
    await x.setEnabled(false); const off = x.status.enabled === false && x.status.rulesets.length === 0;
    await x.setEnabled(true);
    return { off, on: x.status.enabled && x.status.rulesets.length === 6 };
  });
  check(toggles.off && toggles.on, 'immediate fresh-context off/on survives worker startup restart');
  const url = `http://doubleclick.net:${port}/pagead/ads?fixture=1`;
  await app.evaluate(async ({ BrowserWindow }, origin) => {
    global.testPage = new BrowserWindow({ show: false, webPreferences: { session: global.extensions.ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await global.testPage.loadURL(origin);
  }, `http://127.0.0.1:${port}/`);
  const request = () => app.evaluate(async (_, url) => global.testPage.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, {cache:'no-store'}).then(r=>r.url===${JSON.stringify(url)},()=>false)`), url);
  check(!(await request()) && adRequests === 0, 'real Chromium DNR blocks the ad URL before any local server request');
  await app.evaluate(() => global.extensions.setEnabled(false));
  check(await request() && adRequests === 1, 'off really disables DNR and lets the same request reach only the local fixture');
  await app.evaluate(() => global.extensions.setEnabled(true));
  // Deliberately restart the extension, not the helper. Production must notice the
  // readiness event, refresh its own invalid document and reactivate rules itself.
  const restart = async enabled => app.evaluate(async (_, enabled) => {
    const x = global.extensions;
    await x.setEnabled(enabled);
    const helper = x.helper;
    let timer, onState;
    const resumed = new Promise((resolve, reject) => {
      const before = global.events.filter(e => e.name === 'extension-ready').length;
      onState = () => {
        if (global.events.filter(e => e.name === 'extension-ready').length <= before || x.status.enabled !== enabled) return;
        resolve();
      };
      global.changes.on('state', onState);
      timer = setTimeout(() => reject(new Error('automatic blocker restart timed out')), 15000);
    });
    try {
      await helper.webContents.executeJavaScript('chrome.runtime.reload()').catch(error => {
        if (!/Extension context invalidated|frame was disposed/.test(error.message)) throw error;
      });
      await resumed;
      return { status: x.status, sameHelper: x.helper === helper,
        id: await helper.webContents.executeJavaScript('chrome.runtime.id') };
    } finally { clearTimeout(timer); global.changes.removeListener('state', onState); }
  }, enabled);
  let restarted = await restart(true);
  check(restarted.status.enabled && restarted.sameHelper && restarted.id === restarted.status.id, 'extension restart automatically restores live helper and enabled rules, with no manual helper reload');
  const beforeBlocked = adRequests;
  check(!(await request()) && adRequests === beforeBlocked, 'automatic recovery still blocks actual ad requests');
  restarted = await restart(false);
  check(!restarted.status.enabled && restarted.status.rulesets.length === 0, 'extension restart preserves an explicitly disabled preference');
  check(await request(), 'disabled preference remains effective after context recovery');
  // Exercise the bounded retry while DNR execution itself is invalidated.
  const raced = await app.evaluate(async () => {
    const x = global.extensions, wc = x.helper.webContents;
    const original = wc.executeJavaScript.bind(wc);
    let interrupted = false;
    wc.executeJavaScript = async script => {
      if (!interrupted && script.includes('updateEnabledRulesets')) {
        interrupted = true;
        await original('chrome.runtime.reload()').catch(() => {});
        throw new Error('Extension context invalidated.');
      }
      return original(script);
    };
    try { await x.setEnabled(true); return interrupted && x.status.enabled; }
    finally { wc.executeJavaScript = original; }
  });
  check(raced, 'single event-driven retry recovers an invalidation during the DNR command');
  const inline = await app.evaluate(async ({ BaseWindow }) => {
    const x = global.extensions;
    const owner = {
      win:new BaseWindow({ show:true, width:1000, height:800 }),
      sidebarHidden:false, sidebarWidth:240, tabs:new Map(),
      cmd:global.OliveWindow.prototype.cmd,
      setOverlay(value) { this.overlay = value; }, sendState() {},
      layout() { this.inlinePage?.layout(); }
    };
    const originalFocusedWindow = x.mgr.focusedWindow;
    x.mgr.focusedWindow = () => owner;
    const windowCount = BaseWindow.getAllWindows().length;
    const exactPane = panel => {
      const { width, height } = owner.win.getContentBounds();
      const sidebar = owner.sidebarHidden ? 8 : owner.sidebarWidth;
      const bounds = panel.content.getBounds();
      return bounds.x === sidebar && bounds.y === 8 && bounds.width === width - sidebar - 8 && bounds.height === height - 16;
    };
    const singleInlineView = panel => !panel.shell && owner.win.contentView.children.length === 1 && owner.win.contentView.children[0] === panel.content;
    const oneWindow = () => BaseWindow.getAllWindows().length === windowCount && BaseWindow.getAllWindows().filter(win => win.isVisible()).length === 1;
    try {
      x.open(owner);
      const panel = x.popup;
      await new Promise(resolve => panel.webContents.once('did-finish-load', resolve));
      const fullPane = exactPane(panel) && singleInlineView(panel) && oneWindow();
      owner.sidebarHidden = true;
      owner.layout();
      const hiddenSidebar = exactPane(panel);
      owner.win.setContentSize(1200, 900);
      owner.layout();
      const resized = exactPane(panel);
      const noDialogClose = await panel.webContents.executeJavaScript("!document.querySelector('#close')");
      const closed = new Promise(resolve => panel.once('closed', resolve));
      owner.cmd('closePanel');
      await closed;
      const sidebarClose = noDialogClose && panel.isDestroyed() && !owner.appPanel && !owner.inlinePage && !x.popup;
      x.open(owner);
      const basic = x.popup;
      x.openOriginal();
      const official = x.originalPopup;
      await new Promise(resolve => official.webContents.once('did-finish-load', resolve));
      const officialPane = basic.isDestroyed() && !x.popup && exactPane(official) && singleInlineView(official) && oneWindow() && official.webContents.session === x.ses;
      const escaped = new Promise(resolve => official.once('closed', resolve));
      official.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      await escaped;
      const escape = !owner.appPanel && !owner.inlinePage && !x.originalPopup && !owner.win.isDestroyed();
      return {fullPane, hiddenSidebar, resized, sidebarClose, officialPane, escape};
    } finally {
      x.mgr.focusedWindow = originalFocusedWindow;
      owner.appPanel?.close();
      owner.win.destroy();
    }
  });
  check(inline.fullPane, 'basic controls occupy the exact web-content pane: one visible window, one inline view, no shell/card');
  check(inline.hiddenSidebar && inline.resized, 'inline bounds track hidden sidebar and resized content pane exactly');
  check(inline.sidebarClose, 'basic page has no dialog close button; sidebar closePanel command closes it and clears references');
  check(inline.officialPane && inline.escape, 'official popup replaces basic page in the same exact pane/session/window; Escape closes only the page');
  const cleanup = await app.evaluate(async () => {
    const x = global.extensions, ses = x.ses, helper = x.helper;
    const before = ses.extensions.listenerCount('extension-ready');
    await x.dispose();
    global.testPage.destroy();
    return helper.isDestroyed() && !x.ext && !x.helper && ses.extensions.listenerCount('extension-ready') === before - 1;
  });
  check(cleanup, 'dispose destroys helper and removes readiness listeners');
  console.log(`${checks} native extension checks passed; own fresh profile, local network only`);
} finally {
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
