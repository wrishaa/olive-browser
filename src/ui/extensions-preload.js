const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('extensionSettings', {
  get: () => ipcRenderer.invoke('olive:extensions', 'get'),
  set: (id, key, value) => ipcRenderer.invoke('olive:extensions', 'set', { id, key, value }),
  options: id => ipcRenderer.invoke('olive:extensions', 'options', { id }),
  onState: fn => ipcRenderer.on('olive:extensions-state', (_e, rows) => fn(rows)),
});
