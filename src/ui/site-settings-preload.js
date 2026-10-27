const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('siteSettings', {
  get: () => ipcRenderer.invoke('olive:site-settings', 'get'),
  set: (key, value) => ipcRenderer.invoke('olive:site-settings', 'set', { key, value }),
  system: kind => ipcRenderer.invoke('olive:site-settings', 'system', { kind }),
});
