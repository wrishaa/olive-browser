// olive: app bootstrap + window manager
const { app, session, ipcMain, dialog, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// ---------- profile + switches (must run before ready) ----------

const profile = process.env.OLIVE_PROFILE || '';
app.setName('Olive');
app.setPath('userData', path.join(app.getPath('appData'), profile ? `Olive-${profile}` : 'Olive'));

function portFree(port) {
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'pipe' });
    return false; // lsof exits 0 when something listens
  } catch {
    return true;
  }
}

// settings that must be read before chromium starts
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = { cdp: false, agentApi: true, discardMinutes: 30, maxLoadedTabs: 16 };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// the chromium remote-debugging port is opt-in: it lets any local process drive the
// browser, and google sign-in treats debuggable chromium as automated. turn it on with
// the Developer menu toggle (persists, needs a relaunch), OLIVE_CDP=1, or --cdp.
const cdpEnabled = settings.cdp || process.env.OLIVE_CDP === '1' || process.argv.includes('--cdp');
const wantCdp = Number(process.env.OLIVE_CDP_PORT || 9222);
const cdpPortArg = wantCdp && portFree(wantCdp) ? wantCdp : 0; // 0 = let chromium pick, read DevToolsActivePort
if (cdpEnabled) app.commandLine.appendSwitch('remote-debugging-port', String(cdpPortArg));
// plain chrome user agent: some sites (google sign-in) block "Electron" in the UA
const chromeMajor = process.versions.chrome.split('.')[0];
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
// OLIVE_UA_MODE (testing): auto (default: chrome UA, firefox on google sign-in) | chrome | electron
const UA_MODE = process.env.OLIVE_UA_MODE || 'auto';
const ELECTRON_UA = app.userAgentFallback; // electron's default, captured before we override it
if (UA_MODE !== 'electron') app.userAgentFallback = UA;
// google sign-in (measured 2026-10-15, scripts/google-signin-test.sh): a clean chrome UA on
// unbranded chromium is rejected ("this browser or app may not be secure"), but electron's
// own honest UA (with "Electron/x") gets through to the password page, with or without the
// cdp port. so on accounts.google.com we send electron's default UA; everywhere else chrome's.
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com']);
function isGoogleAuth(url) {
  try { return GOOGLE_AUTH_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

// never let a main-process bug put up electron's modal "javascript error" alert: it blocks
// the whole browser until dismissed. log it and keep going.
process.on('uncaughtException', (err) => console.error('[olive] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[olive] unhandled rejection', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { OliveWindow } = require('./window');
module.exports.ua = { UA, ELECTRON_UA, isGoogleAuth };
const { JsonStore } = require('../core/store');
const { History } = require('../core/history');
const { buildMenu } = require('./menu');
const { startAgentApi } = require('./agent-api');
const { toUrl } = require('../core/url');

// ---------- manager ----------

class Manager {
  constructor() {
    this.windows = [];
    this.focused = null;
    this.downloads = [];
    this.cdpPort = null;
    this.apiPort = null;
    this.saveTimer = null;
    this.quitting = false;
    this.pendingUrls = [];
    const ud = app.getPath('userData');
    this.state = new JsonStore(path.join(ud, 'session.json'), () => ({ windows: [] }));
    this.perms = new JsonStore(path.join(ud, 'permissions.json'), () => ({}));
    this.permissions = new (require('./permissions').Permissions)(this);
    this.history = new History(path.join(ud, 'history.json'));
  }

  get session() {
    if (!this._session) {
      this._session = session.fromPartition('persist:olive');
      this.setupSession(this._session);
    }
    return this._session;
  }

  privateSession(id) {
    const s = session.fromPartition(`olive-private-${id}-${Date.now()}`);
    this.setupSession(s);
    return s;
  }

  setupSession(ses) {
    if (UA_MODE !== 'electron') ses.setUserAgent(UA);
    // Do not attach Electron webRequest listeners here: even a Google-only header
    // listener bypasses Chromium's native DNR matching (measured with uBO Lite).
    // Google keeps its honest Electron UA through applyUserAgent() on navigation.
    ses.setSpellCheckerLanguages(['en-US']);
    this.permissions.install(ses, !ses.isPersistent || ses.isPersistent());

    ses.on('will-download', (_e, item) => {
      const dir = app.getPath('downloads');
      const name = item.getFilename() || 'download';
      let p = path.join(dir, name);
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${base} (${i})${ext}`);
      item.setSavePath(p);
      const d = { id: Date.now() + Math.random(), filename: path.basename(p), path: p, url: item.getURL(), received: 0, total: item.getTotalBytes(), state: 'progressing', started: Date.now() };
      this.downloads.unshift(d);
      if (this.downloads.length > 30) this.downloads.length = 30;
      this.broadcast();
      let last = 0;
      item.on('updated', (_ev, state) => {
        d.received = item.getReceivedBytes();
        d.total = item.getTotalBytes();
        d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          this.broadcast();
        }
        const w = this.focusedWindow();
        if (w && d.total) w.win.setProgressBar(d.received / d.total);
      });
      item.once('done', (_ev, state) => {
        d.state = state;
        d.received = item.getReceivedBytes();
        this.focusedWindow()?.win.setProgressBar(-1);
        if (state === 'completed') app.dock?.downloadFinished(p);
        this.broadcast();
      });
    });
  }

  // ---------- windows ----------

  newWindow({ private: isPrivate = false, url = null, state = null } = {}) {
    const w = new OliveWindow(this, { private: isPrivate, state });
    this.windows.push(w);
    if (url) w.createTab({ url: toUrl(url) });
    this.saveSoon();
    return w;
  }

  focusedWindow() {
    if (this.focused && !this.focused.destroyed) return this.focused;
    return this.windows[this.windows.length - 1] || null;
  }

  onWindowClosing(w) {
    // remember tabs of the last normal window so reopening brings them back
    if (w.isPrivate || this.quitting) return;
    const normals = this.windows.filter((x) => !x.isPrivate && !x.destroyed);
    if (normals.length === 1 && normals[0] === w) {
      this.state.data.windows = [w.serialize()];
      this.state.flush();
      this.keepState = true;
    }
  }

  onWindowClosed(w) {
    this.windows = this.windows.filter((x) => x !== w);
    if (this.focused === w) this.focused = this.windows[this.windows.length - 1] || null;
    if (!this.keepState) this.saveSoon();
    this.keepState = false;
  }

  findTab(id) {
    for (const win of this.windows) {
      const tab = win.tabs.get(id);
      if (tab) return { tab, win };
    }
    return null;
  }

  allTabs() {
    const out = [];
    for (const win of this.windows) for (const id of win.allIds()) out.push({ win, tab: win.tabs.get(id) });
    return out;
  }

  broadcast() {
    for (const w of this.windows) w.sendState();
  }

  saveSoon() {
    if (this.quitting) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const normals = this.windows.filter((w) => !w.isPrivate && !w.destroyed);
    if (!normals.length) return; // keep the last saved session
    this.state.data.windows = normals.map((w) => w.serialize());
    this.state.flush();
  }

  restore() {
    const saved = this.state.data.windows || [];
    if (!saved.length) return this.newWindow({});
    for (const s of saved) this.newWindow({ state: s });
  }

  openUrl(url) {
    if (!app.isReady() || !this.windows.length && !this.ready) {
      this.pendingUrls.push(url);
      return;
    }
    let w = this.windows.filter((x) => !x.isPrivate).pop();
    if (!w) w = this.newWindow({});
    w.createTab({ url });
    if (w.overlay === 'palette') w.setOverlay(null);
    w.win.show();
    w.win.focus();
  }

  async makeDefault() {
    const okHttp = app.setAsDefaultProtocolClient('http');
    const okHttps = app.setAsDefaultProtocolClient('https');
    const packaged = app.isPackaged;
    await dialog.showMessageBox({
      message: okHttp && okHttps ? 'macOS will ask you to confirm Olive as your default browser.' : 'Could not register Olive as the default browser.',
      detail: packaged ? '' : 'Note: you are running the dev build (npm start). For a stable default browser, install the packaged app with `npm run package`.',
    });
  }

  agentInfo() {
    return {
      cdpEnabled,
      cdp: this.cdpPort ? `http://127.0.0.1:${this.cdpPort}` : null,
      api: this.apiPort ? `http://127.0.0.1:${this.apiPort}` : null,
      cdpPort: this.cdpPort,
      apiPort: this.apiPort,
      tokenFile: this.agentTokenFile || null,
    };
  }

  applyUserAgent(wc, url) {
    if (UA_MODE !== 'auto') return; // test modes: leave the session UA alone
    const want = isGoogleAuth(url) ? ELECTRON_UA : UA;
    if (wc.getUserAgent() !== want) wc.setUserAgent(want);
  }

  // tab discarding: background tabs that haven't been looked at for a while give
  // their renderer back. the sidebar entry stays (url/title/favicon) and reloads on click.
  startDiscardTimer() {
    clearInterval(this.discardTimer);
    this.discardTimer = setInterval(() => this.discardIdleTabs(), 60 * 1000);
  }

  discardIdleTabs({ olderThanMinutes = null } = {}) {
    const now = Date.now();
    const minutes = olderThanMinutes != null ? Number(olderThanMinutes) : Number(settings.discardMinutes) || 0;
    const max = Number(settings.maxLoadedTabs) || 0;
    const candidates = [];
    let loaded = 0;
    for (const w of this.windows) {
      const visible = new Set(w.visibleIds());
      for (const t of w.tabs.values()) {
        if (!t.wc) continue;
        loaded++;
        if (visible.has(t.id) || t.devtools || t.wc.isCurrentlyAudible() || t.wc.debugger.isAttached()) continue;
        candidates.push({ w, t });
      }
    }
    candidates.sort((a, b) => a.t.lastActive - b.t.lastActive); // oldest first
    let discarded = 0;
    for (const { w, t } of candidates) {
      const idle = (minutes > 0 || olderThanMinutes != null) && now - t.lastActive > minutes * 60 * 1000;
      const over = max > 0 && loaded - discarded > max;
      if (!idle && !over) continue;
      w.unload(t);
      w.changed();
      discarded++;
    }
    return discarded;
  }

  get settings() {
    return settings;
  }

  setSetting(key, value) {
    settings[key] = value;
    saveSettings();
    this.broadcast();
  }

  async toggleCdp() {
    const next = !settings.cdp;
    this.setSetting('cdp', next);
    const r = await dialog.showMessageBox({
      message: next ? 'Agent control (CDP) will be on after a relaunch.' : 'Agent control (CDP) will be off after a relaunch.',
      detail: next
        ? 'Chromium will listen on 127.0.0.1:9222 so tools like Playwright can drive Olive. Any local program can then control the browser, and Google may refuse sign-in while it is on.'
        : 'The Olive agent API (tabs, eval, per-tab CDP commands) keeps working without the port.',
      buttons: ['Relaunch Now', 'Later'],
      defaultId: 0,
    });
    if (r.response === 0) {
      app.relaunch();
      app.quit();
    }
  }

  async discoverCdpPort() {
    if (!cdpEnabled) return null;
    const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
    for (let i = 0; i < 50; i++) {
      try {
        const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
        if (port) return port;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return cdpPortArg || null;
  }

  writeAgentFile() {
    const info = { ...this.agentInfo(), pid: process.pid, profile: profile || 'default', userData: app.getPath('userData'), started: new Date().toISOString() };
    fs.writeFileSync(path.join(app.getPath('userData'), 'agent.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
    try { fs.chmodSync(path.join(app.getPath('userData'), 'agent.json'), 0o600); } catch {}
    console.log(`[olive] cdp ${info.cdp}  agent api ${info.api}  (${path.join(app.getPath('userData'), 'agent.json')})`);
  }
}

const mgr = new Manager();
global.olive = mgr; // handy from the main-process inspector

// ---------- ipc from the ui views ----------

function senderWindow(e) {
  return mgr.windows.find((w) => w.ui.webContents === e.sender);
}

ipcMain.on('olive:cmd', (e, type, args) => {
  const w = senderWindow(e);
  if (w) w.cmd(type, args || {});
});

ipcMain.handle('olive:invoke', (e, type, args) => {
  const w = senderWindow(e);
  if (!w) return null;
  if (type === 'suggest') return w.suggest(args?.query || '');
  if (type === 'state') return w.snapshot();
  return null;
});

// ---------- app lifecycle ----------

// popups (oauth "continue with google" windows) aren't tabs: give them the same
// per-site user agent switching as tabs
app.on('web-contents-created', (_e, wc) => {
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument && wc.getType() === 'window') mgr.applyUserAgent(wc, d.url);
  });
});

app.on('open-url', (e, url) => {
  e.preventDefault();
  mgr.openUrl(url);
});

app.on('open-file', (e, file) => {
  e.preventDefault();
  mgr.openUrl('file://' + file);
});

app.on('second-instance', (_e, argv) => {
  const urls = argv.filter((a) => /^(https?|file):/i.test(a));
  if (urls.length) urls.forEach((u) => mgr.openUrl(u));
  else {
    const w = mgr.focusedWindow() || mgr.newWindow({});
    w.win.show();
    w.win.focus();
  }
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'system';
  buildMenu(mgr);
  mgr.session; // init persistent session
  mgr.extensions = new (require('./extensions').Extensions)(mgr);
  await mgr.extensions.load(mgr.session);
  mgr.restore();
  mgr.ready = true;
  const argvUrls = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => /^(https?|file):/i.test(a));
  for (const u of [...mgr.pendingUrls, ...argvUrls]) mgr.openUrl(u);
  mgr.pendingUrls = [];

  mgr.cdpPort = await mgr.discoverCdpPort();
  const server = settings.agentApi ? await startAgentApi(mgr, Number(process.env.OLIVE_API_PORT || 9333), app.getPath('userData')) : null;
  mgr.apiPort = server ? server.address().port : null;
  mgr.startDiscardTimer();
  mgr.writeAgentFile();
  mgr.broadcast();
});

app.on('activate', () => {
  if (!mgr.windows.length) mgr.restore();
});

app.on('window-all-closed', () => {
  // mac: stay running like every other browser
});

app.on('before-quit', () => {
  mgr.saveNow();
  mgr.quitting = true;
  mgr.history.flush();
  mgr.perms.flush();
  try { mgr.session.cookies.flushStore(); } catch {}
});
