const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('permissions', {
  on: fn => ipcRenderer.on('olive:permissions', (_e, items) => fn(items)),
  answer: (id, allow, remember) => ipcRenderer.send('olive:permission', id, allow, remember),
});
