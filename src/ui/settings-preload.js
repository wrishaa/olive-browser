// Preload for the Settings page (src/main/settings-page.js). One page, four tab documents;
// each bridge is answered by main only for this page's main frame.
const { contextBridge, ipcRenderer } = require('electron');
const settings = (action, payload) => ipcRenderer.invoke('olive:settings', action, payload);
contextBridge.exposeInMainWorld('oliveSettings', {
  get: () => settings('get'),
  tab: tab => settings('tab', { tab }),
  close: () => settings('close'),
  set: (key, value) => settings('set', { key, value }),
  permission: (origin, key, value) => settings('permission', { origin, key, value }),
  forgetSite: origin => settings('forgetSite', { origin }),
  macos: kind => settings('macos', { kind }),
  ledger: () => settings('ledger'),
  onState: fn => ipcRenderer.on('olive:settings-state', (_e, state) => fn(state)),
});
// Keyboard Shortcuts tab (src/main/shortcuts.js)
contextBridge.exposeInMainWorld('shortcuts', {
  get: () => ipcRenderer.invoke('olive:shortcuts', 'get'),
  set: (id, value) => ipcRenderer.invoke('olive:shortcuts', 'set', { id, value }),
  reset: () => ipcRenderer.invoke('olive:shortcuts', 'reset'),
  close: () => ipcRenderer.invoke('olive:shortcuts', 'close'),
});
// Extensions tab (src/main/extension-settings.js)
contextBridge.exposeInMainWorld('extensionSettings', {
  get: () => ipcRenderer.invoke('olive:extensions', 'get'),
  set: (id, key, value) => ipcRenderer.invoke('olive:extensions', 'set', { id, key, value }),
  options: id => ipcRenderer.invoke('olive:extensions', 'options', { id }),
  onState: fn => ipcRenderer.on('olive:extensions-state', (_e, rows) => fn(rows)),
});
// Activities tab (src/main/site-time.js)
contextBridge.exposeInMainWorld('oliveSiteTime', {
  get: range => ipcRenderer.invoke('olive:site-time', 'get', { range }),
  reset: range => ipcRenderer.invoke('olive:site-time', 'reset', { range }),
  open: site => ipcRenderer.invoke('olive:site-time', 'open', { site }),
  close: () => ipcRenderer.invoke('olive:site-time', 'close'),
});
