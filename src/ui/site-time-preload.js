const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oliveSiteTime', {
  get: range => ipcRenderer.invoke('olive:site-time', 'get', { range }),
  reset: range => ipcRenderer.invoke('olive:site-time', 'reset', { range }),
  open: site => ipcRenderer.invoke('olive:site-time', 'open', { site }),
  close: () => ipcRenderer.invoke('olive:site-time', 'close'),
});
