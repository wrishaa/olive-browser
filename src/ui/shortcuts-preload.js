const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shortcuts', {
  get: () => ipcRenderer.invoke('olive:shortcuts', 'get'),
  set: (id, value) => ipcRenderer.invoke('olive:shortcuts', 'set', { id, value }),
  reset: () => ipcRenderer.invoke('olive:shortcuts', 'reset'),
  close: () => ipcRenderer.invoke('olive:shortcuts', 'close'),
});
