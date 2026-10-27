// Profile-local shortcuts. Electron is required only when opening the settings window.
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('../core/store');
const COMMANDS = [
  ['newTab','New Tab','Cmd+T'], ['newWindow','New Window','Cmd+N'],
  ['newPrivateWindow','New Private Window','Cmd+Shift+N'], ['openLocation','Open Location','Cmd+L'],
  ['reopenClosed','Reopen Closed Tab','Cmd+Shift+T'], ['closeTab','Close Tab','Cmd+W'],
  ['closeWindow','Close Window','Cmd+Shift+W'], ['copyUrl','Copy URL','Cmd+Shift+C'],
  ['find','Find','Cmd+F'], ['findNext','Find Next','Cmd+G'], ['findPrev','Find Previous','Cmd+Shift+G'],
  ['toggleSidebar','Toggle Sidebar','Cmd+S'], ['reload','Reload','Cmd+R'],
  ['hardReload','Hard Reload','Cmd+Shift+R'], ['stop','Stop','Cmd+.'],
  ['zoomReset','Actual Size','Cmd+0'], ['zoomIn','Zoom In','Cmd+='], ['zoomOut','Zoom Out','Cmd+-'],
  ['mruNext','Next Recently Used Tab','Ctrl+Tab'], ['mruPrev','Previous Recently Used Tab','Ctrl+Shift+Tab'],
  ['nextTab','Next Tab (Sidebar Order)','Cmd+Alt+Down'], ['prevTab','Previous Tab (Sidebar Order)','Cmd+Alt+Up'],
  ['togglePin','Pin / Unpin Tab','Cmd+D'], ['duplicate','Duplicate Tab','Cmd+Shift+D'],
  ['splitNew','Split View with New Tab','Ctrl+Shift+='], ['unsplit','Separate Split View','Ctrl+Shift+-'],
  ['back','Back','Cmd+['], ['forward','Forward','Cmd+]'],
  ['devtools','Developer Tools','Cmd+Alt+I'], ['console','JavaScript Console','Cmd+Alt+J'],
  ['settings','Keyboard Shortcuts','Cmd+,'],
].map(([id,label,accelerator]) => ({ id, label, accelerator }));
const RESERVED = [
  'Cmd+Shift+]','Cmd+Shift+[','Cmd+Plus','Ctrl+Shift+Plus','F12',
  'Cmd+Q','Cmd+H','Cmd+Alt+H','Cmd+M','Cmd+Ctrl+F',
  'Cmd+Z','Cmd+Shift+Z','Cmd+X','Cmd+C','Cmd+V','Cmd+Alt+Shift+V','Cmd+A',
  ...Array.from({length:9}, (_,i) => `Cmd+${i+1}`),
];
function normalize(raw) {
  if (raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 100) throw new Error('Enter a shortcut such as Cmd+Shift+K.');
  const parts = raw.trim().split('+').map(x => x.trim());
  const aliases = {cmd:'Cmd',command:'Cmd',commandorcontrol:'Cmd',cmdorctrl:'Cmd',ctrl:'Ctrl',control:'Ctrl',alt:'Alt',option:'Alt',shift:'Shift',super:'Cmd',meta:'Cmd'};
  const modifiers = new Set();
  let key = null;
  for (const part of parts) {
    const mod = aliases[part.toLowerCase()];
    if (mod) { if (modifiers.has(mod)) throw new Error('Duplicate modifier.'); modifiers.add(mod); }
    else { if (key !== null || !part) throw new Error('Use one key with its modifiers.'); key = part; }
  }
  if (!key) throw new Error('Choose a key, not just modifiers.');
  const named = {tab:'Tab',space:'Space',escape:'Escape',esc:'Escape',enter:'Enter',return:'Enter',backspace:'Backspace',delete:'Delete',insert:'Insert',home:'Home',end:'End',pageup:'PageUp',pagedown:'PageDown',up:'Up',down:'Down',left:'Left',right:'Right',plus:'Plus'};
  key = named[key.toLowerCase()] || key.toUpperCase();
  if (!/^[A-Z0-9.,;\/'\[\]\\=\-`]$/.test(key) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && !Object.values(named).includes(key)) throw new Error('Unsupported shortcut key.');
  if (!modifiers.has('Cmd') && !modifiers.has('Ctrl') && !/^F\d+$/.test(key)) throw new Error('Use Command or Control with this key.');
  return [...['Cmd','Ctrl','Alt','Shift'].filter(x => modifiers.has(x)), key].join('+');
}
class Shortcuts {
  constructor(mgr, options = {}) {
    this.mgr = mgr;
    this.onChange = options.onChange || (() => require('./menu').buildMenu(mgr));
    this.view = null;
    this.load(options.store);
  }
  load(store) {
    this.store = store || new JsonStore(path.join(this.mgr.dataPath, 'shortcuts.json'), () => ({}));
    this.overrides = {};
    const data = this.store.data;
    // Treat corrupt/old files as defaults; reject conflicts rather than silently stealing a command.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const c of COMMANDS) if (Object.hasOwn(data, c.id)) {
        try { this.overrides[c.id] = normalize(data[c.id]); } catch {}
      }
      let changed;
      do {
        changed = false;
        for (const id of Object.keys(this.overrides)) {
          try { this.validate(id, this.overrides[id]); }
          catch { delete this.overrides[id]; changed = true; }
        }
      } while (changed);
    }
    return this;
  }
  reload() {
    // Writes are immediate; never flush an old profile after the manager switched directories.
    this.load();
    if (this.view && !this.view.isDestroyed()) this.view.webContents.reload();
    this.onChange();
    return this;
  }
  accelerator(id) { return this.overrides[id] ?? COMMANDS.find(c => c.id === id)?.accelerator; }
  state() { return COMMANDS.map(c => ({ ...c, value: this.accelerator(c.id), changed: Object.hasOwn(this.overrides, c.id) })); }
  validate(id, raw) {
    if (!COMMANDS.some(c => c.id === id)) throw new Error('Unknown command.');
    const value = normalize(raw);
    if (!value) return value;
    if (RESERVED.some(x => normalize(x) === value)) throw new Error('This shortcut is reserved for navigation or standard editing.');
    const conflict = COMMANDS.find(c => c.id !== id && normalize(this.accelerator(c.id)) === value);
    if (conflict) throw new Error(`Already used by ${conflict.label}.`);
    return value;
  }
  set(id, raw) {
    const value = this.validate(id, raw);
    if (value === COMMANDS.find(c => c.id === id).accelerator) delete this.overrides[id];
    else this.overrides[id] = value;
    this.save();
  }
  reset() { this.overrides = {}; this.save(); }
  save() {
    this.store.data = { ...this.overrides };
    if (this.store.file) fs.mkdirSync(path.dirname(this.store.file), { recursive: true });
    this.store.flush();
    this.onChange();
  }
  showSettings(win) {
    if (this.view && !this.view.isDestroyed()) { this.view.show(); this.view.focus(); return this.view; }
    const { ipcMain } = require('electron');
    const { AppPanel } = require('./app-panel');
    const view = new AppPanel(win || this.mgr.focusedWindow(), { width: 660, height: 760, title: 'Keyboard Shortcuts', captureEscape:true,
      webPreferences: { preload: path.join(__dirname,'../ui/shortcuts-preload.js'), sandbox:true, contextIsolation:true, nodeIntegration:false } });
    this.view = view;
    // Let the recorder receive combinations instead of firing the app menu while editing.
    view.webContents.setIgnoreMenuShortcuts(true);
    const channel = 'olive:shortcuts';
    // Only this local, main-frame settings document is allowed to update profile settings.
    const handle = (e, action, payload = {}) => {
      if (e.sender !== view.webContents || e.senderFrame !== view.webContents.mainFrame) return null;
      try {
        if (action === 'close') { view.close(); return null; }
        if (action === 'set') this.set(payload.id, payload.value);
        else if (action === 'reset') this.reset();
        else if (action !== 'get') return null;
        return { commands: this.state() };
      } catch (error) { return { commands: this.state(), error: error.message }; }
    };
    ipcMain.handle(channel, handle);
    view.on('closed', () => { ipcMain.removeHandler(channel); this.view = null; });
    view.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    view.webContents.on('will-navigate', e => e.preventDefault());
    view.loadFile(path.join(__dirname,'../ui/shortcuts.html')).then(() => {
      if (!view.isDestroyed()) { view.show(); view.focus(); }
    });
    return view;
  }
  flush() { this.store.flush(); }
}
module.exports = { Shortcuts, COMMANDS, RESERVED, normalize };
