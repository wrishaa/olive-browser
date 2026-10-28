const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pageDialog', {
  on: (fn) => ipcRenderer.on('olive:page-dialog', (_e, d) => fn(d)),
  answer: (id, ok, text, block) => ipcRenderer.send('olive:page-dialog-answer', id, ok, text, block),
});
