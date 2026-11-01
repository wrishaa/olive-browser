const { AppPanel } = require('./app-panel');
// Only trusted chrome views can resolve permission requests or change site settings.
const { WebContentsView, ipcMain, systemPreferences, desktopCapturer, webContents, shell, app } = require('electron');
const path = require('path');
const labels = { media: 'camera / microphone', geolocation: 'your location', notifications: 'notifications', midiSysex: 'MIDI devices', 'clipboard-read': 'read your clipboard', 'clipboard-sanitized-write': 'write to your clipboard', 'display-capture': 'screen sharing', openExternal: 'open another app', 'idle-detection': 'idle detection', hid: 'HID devices', serial: 'serial devices', usb: 'USB devices', 'storage-access': 'cross-site storage', 'top-level-storage-access': 'cross-site storage', 'speaker-selection': 'audio output devices', keyboardLock: 'keyboard lock', 'window-management': 'window management', 'local-network-access': 'your local network' };
// navigator.permissions.query names a page can see -> olive's stored per-origin keys.
// Electron's check handler is boolean only, and false makes chromium report 'denied'
// (so Meet & co. say "allow it in your browser settings" and never ask). The check stays
// false until the user decides (no device labels / ids leak through enumerateDevices);
// src/ui/site-permissions-preload.js shows these names to the page as 'prompt' instead.
const queryKeys = { camera:'media:video', microphone:'media:audio', notifications:'notifications', push:'notifications', geolocation:'geolocation', 'clipboard-read':'clipboard-read', 'display-capture':'display-capture', 'speaker-selection':'speaker-selection', 'local-network-access':'local-network-access', 'window-management':'window-management', 'idle-detection':'idle-detection', 'storage-access':'storage-access', 'top-level-storage-access':'top-level-storage-access' };
const settingsPermissions = [['media:audio','Microphone'],['media:video','Camera'],['display-capture','Screen sharing'],['notifications','Notifications'],['geolocation','Location'],['speaker-selection','Audio output devices'],['clipboard-read','Clipboard'],['local-network-access','Local network']];
// did-start-navigation fires for every frame and for pushState; only a new main document
// (reload, link, close) means the page that asked is gone.
const leavesDocument = e => e?.isMainFrame !== false && !e?.isSameDocument;
class Permissions {
  constructor(mgr) {
    this.mgr = mgr; this.pending = new Map(); this.views = new Map(); this.seq = 0; this.privateChoices = {}; this.once = new WeakMap(); this.settings = new Map(); this.pickers = new Map(); this.osRequests = new Map(); this.screenSetupRequested = false; this.sessionChoices = new WeakMap();
    // Page frames (site-permissions preload) ask for their own origin's state; the origin comes
    // from the frame main knows, never from the renderer.
    ipcMain.on('olive:site-permission-state', e => {
      let state = null; try { const choices = this.sessionChoices.get(e.sender.session); if (choices) state = this.siteState(choices, e.sender, e.senderFrame?.origin); } catch {}
      e.returnValue = state;
    });
    ipcMain.on('olive:permission', (e, id, allow, remember = true) => {
      const p = this.pending.get(id);
      if (p && this.views.get(p.win)?.view.webContents === e.sender && typeof allow === 'boolean' && typeof remember === 'boolean') this.finish(p, allow, remember);
    });
    ipcMain.handle('olive:site-settings', async (e, action, payload = {}) => {
      const entry = this.settings.get(e.sender.id); if (!entry || e.sender !== entry.view.webContents) return null;
      if (action === 'close') {entry.view.close();return null;}
      if (action === 'set' && settingsPermissions.some(([key]) => key === payload.key) && ['ask','allow','block'].includes(payload.value)) {
        const key = `${entry.origin}|${payload.key}`;
        if (payload.value === 'ask') delete entry.choices[key]; else entry.choices[key] = payload.value === 'allow';
        this.once.get(entry.wc)?.delete(key);
        for (const p of [...this.pending.values()]) if (p.wc === entry.wc && p.keys.includes(key)) this.finish(p, false, false);
        if (!entry.win.isPrivate) this.mgr.perms.save();
        this.broadcast();
      }
      if (action === 'system' && ['microphone','camera','screen'].includes(payload.kind)) {
        if (payload.kind === 'screen') {
          if (payload.confirmed !== true) throw new Error('Confirm the macOS screen access warning first.');
          await this.registerScreenAccess();
        }
        const pane = { microphone: 'Microphone', camera: 'Camera', screen: 'ScreenCapture' }[payload.kind];
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
      }
      if (action === 'relaunch' && this.screenSetupRequested) {
        if (payload.confirmed !== true) throw new Error('Confirm relaunch first.');
        // Explicit user action only; before-quit saves tabs and flushes cookies.
        app.relaunch(); app.quit(); return null;
      }
      return this.settingsState(entry);
    });
    ipcMain.handle('olive:capture-picker', (e, action, id) => {
      const entry = this.pickers.get(e.sender.id); if (!entry || entry.view.webContents !== e.sender) return null;
      if (action === 'get') return { origin: entry.origin, sources: entry.sources.map(s => ({ id:s.id, name:s.name, thumbnail:s.thumbnail.toDataURL() })) };
      if (action === 'choose') entry.finish(entry.sources.find(s => s.id === id) || null);
      if (action === 'cancel') entry.finish(null);
      return null;
    });
  }
  origin(raw) { try { const u = new URL(raw); return ['https:','http:'].includes(u.protocol) ? u.origin : null; } catch { return null; } }
  windowFor(wc) { return this.mgr.windows.find(w => [...w.tabs.values()].some(t => t.wc === wc)); }
  keys(origin, permission, details = {}) {
    if (permission !== 'media') return [`${origin}|${permission}`];
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    return (types.length ? [...new Set(types)].sort() : ['unknown']).map(t => `${origin}|media:${t}`);
  }
  grants(wc) {
    if (!wc || wc.isDestroyed()) return new Set();
    if (!this.once.has(wc)) {
      this.once.set(wc, new Set());
      wc.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument) this.once.get(wc)?.clear(); });
    }
    return this.once.get(wc);
  }
  // What the page should see per query name: 'granted' (stored allow or allow once in this
  // document, same rule as the check handler), 'denied' (stored block) or 'prompt'.
  siteState(choices, wc, rawOrigin) {
    const origin = this.origin(rawOrigin); if (!origin) return null;
    const once = this.grants(wc), out = {};
    for (const [name, perm] of Object.entries(queryKeys)) { const k = `${origin}|${perm}`; out[name] = choices[k] === true || (choices[k] !== false && once.has(k)) ? 'granted' : choices[k] === false ? 'denied' : 'prompt'; }
    return out;
  }
  // Push fresh state to every page frame of olive's sessions (choices are per origin, so other
  // tabs on the same site update too). Fires PermissionStatus change events in the page.
  broadcast() {
    let all = []; try { all = webContents.getAllWebContents?.() || []; } catch {}
    for (const wc of all) {
      try {
        if (wc.isDestroyed()) continue; const choices = this.sessionChoices.get(wc.session); if (!choices) continue;
        for (const frame of wc.mainFrame?.framesInSubtree || []) { const state = this.siteState(choices, wc, frame.origin); if (state) frame.send('olive:site-permission-state', state); }
      } catch {}
    }
  }
  status(kind) { try { return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus(kind) : 'not-applicable'; } catch { return 'unknown'; } }
  async osMedia(types) {
    for (const type of types) {
      const kind = type === 'audio' ? 'microphone' : type === 'video' ? 'camera' : null; if (!kind || process.platform !== 'darwin') continue;
      let status = this.status(kind);
      if (status === 'not-determined') {
        if (!this.osRequests.has(kind)) this.osRequests.set(kind, systemPreferences.askForMediaAccess(kind).finally(() => this.osRequests.delete(kind)));
        if (!await this.osRequests.get(kind)) return false;
        status = this.status(kind);
      }
      if (status !== 'granted') return false;
    }
    return true;
  }
  install(ses, persist) {
    const choices = persist ? this.mgr.perms.data : this.privateChoices;
    this.sessionChoices.set(ses, choices);
    ses.setPermissionCheckHandler((wc, permission, rawOrigin, details = {}) => {
      const origin = this.origin(details.securityOrigin || rawOrigin); if (!origin) return false;
      if (permission === 'fullscreen' || permission === 'pointerLock') return true;
      return this.keys(origin, permission, details).every(k => choices[k] === true || (choices[k] !== false && this.grants(wc).has(k)));
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
      if (permission === 'fullscreen' || permission === 'pointerLock') return callback(true);
      // Electron labels desktop capture as media with an empty mediaTypes array.
      // Keep it separate from microphone/camera grants, and share the same site
      // decision with the subsequent display-media source-selection handler.
      const kind = permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0 ? 'display-capture' : permission;
      this.request(wc, kind, details.securityOrigin || details.requestingUrl || wc?.getURL(), details, choices, persist, callback);
    });
    ses.setDisplayMediaRequestHandler((request, rawCallback) => {
      // Answer chromium exactly once. Electron throws from the callback when it is
      // given no video for a video request, and a second answer used to follow from
      // the catch below, so a cancel surfaced as AbortError "Invalid capture constraints".
      let answered = false;
      const callback = streams => { if (answered) return; answered = true; try { rawCallback(streams); } catch {} };
      const wc = request.frame && webContents.fromFrame(request.frame);
      if (!wc || !request.videoRequested || !request.userGesture) return callback(null);
      this.request(wc, 'display-capture', request.securityOrigin, {}, choices, persist, async allowed => {
        if (!allowed || !request.frame || wc.isDestroyed()) return callback(null);
        try {
          const origin = this.origin(request.securityOrigin);
          const source = await this.pickSource(this.windowFor(wc), wc, origin);
          if (!source || !request.frame || wc.isDestroyed()) return callback(null);
          // Never select a screen automatically. No system-audio loopback on macOS.
          callback({ video: source });
        } catch { callback(null); }
      });
    }, { useSystemPicker: false });
  }
  request(wc, permission, rawOrigin, details, choices, persist, callback) {
    const win = this.windowFor(wc), origin = this.origin(rawOrigin);
    if (!win || !wc || wc.isDestroyed() || !origin) return callback(false);
    const keys = this.keys(origin, permission, details);
    if (keys.some(k => choices[k] === false)) return callback(false);
    const p = { id: ++this.seq, wc, win, origin, keys, callback, choices, persist, permission, details,
      label: permission === 'media' ? (details.mediaTypes || []).map(t => t === 'audio' ? 'microphone' : t === 'video' ? 'camera' : t).join(' and ') || labels.media : labels[permission] || permission };
    // Only a new main document ends the request. Subframe loads and pushState (meet does
    // both around its present button) must not cancel the prompt the user is answering.
    p.navigate = e => { if (leavesDocument(e)) this.finish(p, false, false); };
    p.destroy = () => this.finish(p, false, false);
    wc.on('did-start-navigation', p.navigate); wc.once('destroyed', p.destroy); this.pending.set(p.id, p);
    if (keys.every(k => choices[k] === true || this.grants(wc).has(k))) this.finish(p, true, false);
    else this.refresh(win);
  }
  async finish(p, allow, remember) {
    if (!this.pending.has(p.id)) return;
    if (allow && p.permission === 'media' && !p.askingOS) {
      p.askingOS = true;
      let granted = false; try { granted = await this.osMedia(p.details.mediaTypes || []); } catch {}
      if (!this.pending.has(p.id)) return;
      if (!granted) {
        // Site choice is still Allow; the OS denial is separate and resettable in macOS.
        if (remember) { for (const key of p.keys) p.choices[key] = true; if (p.persist) this.mgr.perms.save(); }
        // the site may already read 'granted' now (stored allow); the OS still says no.
        allow = false; remember = false;
        p.win.send('toast', 'macOS blocked microphone/camera. Open Site settings → macOS settings, allow Olive, then reload.');
        this.showSettings(p.win, p.wc);
      }
    } else if (allow && p.askingOS) return;
    if (!this.pending.delete(p.id)) return;
    p.wc.removeListener('did-start-navigation', p.navigate); p.wc.removeListener('destroyed', p.destroy);
    if (remember) { for (const key of p.keys) p.choices[key] = allow; if (p.persist) this.mgr.perms.save(); }
    else if (allow) for (const key of p.keys) this.grants(p.wc).add(key);
    this.mgr.ledger?.record('permission', { origin:p.origin, permission:p.permission, allowed:!!allow, remember:!!remember, private:p.win.isPrivate });
    try { p.callback(allow); } catch {}
    this.broadcast();
    this.refresh(p.win);
  }
  async registerScreenAccess() {
    this.screenSetupRequested = true;
    // Do not gate this on getMediaAccessStatus: macOS reports denied even when
    // this app has never requested capture and therefore is absent from TCC's UI.
    // A real request from the installed, signed bundle registers Olive with macOS.
    try { return await desktopCapturer.getSources({ types:['screen','window'], thumbnailSize:{width:240,height:135} }); }
    catch { return []; }
  }
  settingsState(e) {
    return { origin: e.origin, permissions: settingsPermissions.map(([key,label]) => ({ key,label,value: e.choices[`${e.origin}|${key}`] === true ? 'allow' : e.choices[`${e.origin}|${key}`] === false ? 'block' : 'ask' })), system: { microphone:this.status('microphone'),camera:this.status('camera'),screen:this.status('screen') }, screenSetup: { requested:this.screenSetupRequested, appPath:process.platform === 'darwin' && app.isPackaged ? path.dirname(path.dirname(app.getPath('exe'))) : null } };
  }
  showSettings(win, sourceWC = null) {
    const wc = sourceWC || win?.tabs.get(win.activeId)?.wc, origin = this.origin(wc?.getURL()); if (!origin) return win?.send('toast','Site permissions are available on web pages.');
    for (const e of this.settings.values()) if (e.wc === wc) { e.view.show(); e.view.focus(); return; }
    const view = new AppPanel(win, { width:480,height:520, title:'Site settings', resizable:false, minimizable:false, fullscreenable:false, webPreferences:{ preload:path.join(__dirname,'../ui/site-settings-preload.js'), sandbox:true,contextIsolation:true,nodeIntegration:false } });
    const entry = { view,win,wc,origin,choices:win.isPrivate ? this.privateChoices : this.mgr.perms.data };
    this.settings.set(view.webContents.id,entry);
    const close = e => { if (!e || leavesDocument(e)) { if (!view.isDestroyed()) view.close(); } };
    wc.on('did-start-navigation',close); wc.once('destroyed',close);
    const id = view.webContents.id;
    view.on('closed',()=>{ this.settings.delete(id); wc.removeListener('did-start-navigation',close); wc.removeListener('destroyed',close); });
    view.webContents.on('will-navigate',e=>e.preventDefault()); view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    view.loadFile(path.join(__dirname,'../ui/site-settings.html'));
  }
  async pickSource(win, wc, origin) {
    if (!win || wc.isDestroyed()) return null;
    // Cancel only when the requesting page goes away (new main document or tab closed).
    // A subframe load or a same-document URL change (pushState) during the slow first
    // getSources call used to cancel the share, so the first "present" click failed.
    let canceled = false; const abort = e => { if (!e || leavesDocument(e)) canceled = true; };
    wc.on('did-start-navigation',abort); wc.once('destroyed',abort);
    let sources;
    try { sources = await this.registerScreenAccess(); }
    catch { sources = []; }
    finally { wc.removeListener('did-start-navigation',abort); wc.removeListener('destroyed',abort); }
    if (canceled || wc.isDestroyed()) return null;
    if (['denied','restricted','not-determined'].includes(this.status('screen')) || !sources?.length) {
      win.send('toast','Enable Olive in macOS Screen & System Audio Recording, then relaunch Olive.');
      this.showSettings(win, wc); return null;
    }
    return new Promise(resolve => {
      const view = new AppPanel(win, {width:720,height:520,title:'Choose what to share',webPreferences:{preload:path.join(__dirname,'../ui/capture-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false} });
      const id = view.webContents.id; let done = false;
      const finish = source => { if (done) return; done=true; this.pickers.delete(id); wc.removeListener('did-start-navigation',cancel); wc.removeListener('destroyed',cancel); if (!view.isDestroyed()) view.close(); resolve(source); };
      const cancel = e => { if (!e || leavesDocument(e)) finish(null); };
      this.pickers.set(id,{view,origin,sources,finish}); wc.on('did-start-navigation',cancel); wc.once('destroyed',cancel); view.once('closed',()=>finish(null));
      view.webContents.on('will-navigate',e=>e.preventDefault()); view.webContents.setWindowOpenHandler(()=>({action:'deny'})); view.loadFile(path.join(__dirname,'../ui/capture.html'));
    });
  }
  reset(win) {
    const tab = win?.tabs.get(win.activeId); const origin = this.origin(tab?.wc?.getURL() || tab?.url); if (!origin) return;
    for (const p of [...this.pending.values()]) if (p.origin === origin) this.finish(p, false, false);
    const choices = win.isPrivate ? this.privateChoices : this.mgr.perms.data;
    for (const k of Object.keys(choices)) if (k.startsWith(origin + '|')) delete choices[k];
    this.once.get(tab?.wc)?.clear(); if (!win.isPrivate) this.mgr.perms.save(); this.broadcast(); win.send('toast', `Permissions reset for ${origin}. Reload the page to ask again.`);
  }
  refresh(win) {
    if (win.destroyed || win.win.isDestroyed()) return;
    const items = [...this.pending.values()].filter(p => p.win === win).map(({ id, origin, label }) => ({ id, origin, label }));
    let entry = this.views.get(win);
    if (!entry && items.length) {
      const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '../ui/permission-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      view.setBackgroundColor('#00000000'); entry = { view, items, ready: false }; this.views.set(win, entry);
      view.webContents.on('will-navigate', e => e.preventDefault()); view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.once('did-finish-load', () => { entry.ready = true; this.refresh(win); }); view.webContents.loadFile(path.join(__dirname, '../ui/permissions.html'));
      win.win.once('closed', () => { for (const p of [...this.pending.values()]) if (p.win === win) this.finish(p, false, false); clearTimeout(entry.timer); this.views.delete(win); if (!view.webContents.isDestroyed()) view.webContents.close(); });
    }
    if (!entry) return;
    clearTimeout(entry.timer); entry.items = items;
    if (entry.ready) entry.view.webContents.send('olive:permissions', items);
    if (items.length) this.layout(win);
    else entry.timer = setTimeout(() => { if (win.win.isDestroyed()) return; const focused = !entry.view.webContents.isDestroyed() && entry.view.webContents.isFocused(); win.win.contentView.removeChildView(entry.view); entry.view.setVisible(false); if (focused) win.tabs.get(win.activeId)?.wc?.focus(); }, 220);
  }
  layout(win) {
    const e = this.views.get(win); if (!e?.items.length || win.win.isDestroyed()) return;
    const { width, height } = win.win.getContentBounds(); const h = Math.min(e.items.length * 142 + 24, Math.max(142, Math.floor(height * .6)));
    e.view.setBounds({ x: 12, y: Math.max(0, height - h - 12), width: Math.min(390, width - 24), height: h }); e.view.setVisible(true); win.win.contentView.addChildView(e.view);
  }
}
module.exports = { Permissions, queryKeys };
