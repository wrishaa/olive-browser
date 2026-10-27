const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('siteSettings', {
  relaunch: confirmed => ipcRenderer.invoke('olive:site-settings', 'relaunch', { confirmed }),
  close: () => ipcRenderer.invoke('olive:site-settings', 'close'),
  get: () => ipcRenderer.invoke('olive:site-settings', 'get'),
  set: (key, value) => ipcRenderer.invoke('olive:site-settings', 'set', { key, value }),
  system: (kind, confirmed = false) => ipcRenderer.invoke('olive:site-settings', 'system', { kind, confirmed }),
});
