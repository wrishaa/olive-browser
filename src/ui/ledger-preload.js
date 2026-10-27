const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ledger', { call: (action, payload = {}) => ipcRenderer.invoke('olive:ledger', action, payload) });
