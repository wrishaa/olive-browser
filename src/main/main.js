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

const wantCdp = Number(process.env.OLIVE_CDP_PORT || 9222);
const cdpPortArg = wantCdp && portFree(wantCdp) ? wantCdp : 0; // 0 = let chromium pick, read DevToolsActivePort
app.commandLine.appendSwitch('remote-debugging-port', String(cdpPortArg));
// plain chrome user agent: some sites (google sign-in) block "Electron" in the UA
const chromeMajor = process.versions.chrome.split('.')[0];
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
app.userAgentFallback = UA;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { OliveWindow } = require('./window');
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
    ses.setUserAgent(UA);
    ses.setSpellCheckerLanguages(['en-US']);
    const prompting = new Set(['media', 'geolocation', 'notifications', 'midiSysex', 'clipboard-read', 'display-capture', 'openExternal', 'idle-detection', 'hid', 'serial', 'usb', 'storage-access', 'top-level-storage-access', 'speaker-selection', 'keyboardLock', 'window-management']);
    const label = {
      media: 'camera / microphone', geolocation: 'location', notifications: 'notifications', midiSysex: 'MIDI devices',
      'clipboard-read': 'clipboard', 'display-capture': 'screen sharing', openExternal: 'an external app', 'idle-detection': 'idle detection',
      'storage-access': 'cookies (storage access)', 'top-level-storage-access': 'cookies (storage access)', 'window-management': 'window management',
    };
    const key = (origin, perm, details) => `${origin}|${perm}${perm === 'media' ? ':' + (details?.mediaTypes || []).sort().join(',') : ''}`;
    const persist = !ses.isPersistent || ses.isPersistent();
    ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      if (!prompting.has(permission)) return callback(true);
      let origin;
      try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { origin = 'this site'; }
      const k = key(origin, permission, details);
      const known = this.perms.data[k];
      if (persist && known != null) return callback(known);
      if (permission === 'openExternal') {
        const ext = details.externalURL || '';
        if (/^(mailto|tel|facetime|sms):/i.test(ext)) return callback(true);
      }
      const what = permission === 'openExternal' ? `open ${String(details.externalURL || '').split(':')[0]}: links in another app` : `use your ${label[permission] || permission}`;
      const win = this.windows.find((w) => [...w.tabs.values()].some((t) => t.wc === wc)) || this.focused;
      const r = await dialog.showMessageBox(win?.win, {
        type: 'question',
        message: `${origin.replace(/^https?:\/\//, '')} wants to ${what}`,
        buttons: ['Allow', 'Block'],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: persist ? 'Remember for this site' : undefined,
        checkboxChecked: true,
      });
      const ok = r.response === 0;
      if (persist && r.checkboxChecked) {
        this.perms.data[k] = ok;
        this.perms.save();
      }
      callback(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, origin, details) => {
      if (!prompting.has(permission)) return true;
      const k = key(origin, permission, { mediaTypes: details?.mediaType ? [details.mediaType] : [] });
      if (this.perms.data[k] != null) return this.perms.data[k];
      // media checks come per type; allow if any granted media entry exists for origin
      if (permission === 'media') return Object.entries(this.perms.data).some(([kk, v]) => v && kk.startsWith(`${origin}|media`));
      return false;
    });

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
      cdp: this.cdpPort ? `http://127.0.0.1:${this.cdpPort}` : null,
      api: this.apiPort ? `http://127.0.0.1:${this.apiPort}` : null,
      cdpPort: this.cdpPort,
      apiPort: this.apiPort,
    };
  }

  async discoverCdpPort() {
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
    fs.writeFileSync(path.join(app.getPath('userData'), 'agent.json'), JSON.stringify(info, null, 2));
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
  mgr.restore();
  mgr.ready = true;
  const argvUrls = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => /^(https?|file):/i.test(a));
  for (const u of [...mgr.pendingUrls, ...argvUrls]) mgr.openUrl(u);
  mgr.pendingUrls = [];

  mgr.cdpPort = await mgr.discoverCdpPort();
  const server = await startAgentApi(mgr, Number(process.env.OLIVE_API_PORT || 9333));
  mgr.apiPort = server ? server.address().port : null;
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
