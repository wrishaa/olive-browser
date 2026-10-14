const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('olive', {
  cmd: (type, args) => ipcRenderer.send('olive:cmd', type, args || {}),
  invoke: (type, args) => ipcRenderer.invoke('olive:invoke', type, args || {}),
  on: (channel, fn) => {
    ipcRenderer.on('olive:' + channel, (_e, data) => fn(data));
  },
});
