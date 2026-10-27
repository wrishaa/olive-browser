const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capturePicker', { get: () => ipcRenderer.invoke('olive:capture-picker','get'), choose: id => ipcRenderer.invoke('olive:capture-picker','choose',id), cancel: () => ipcRenderer.invoke('olive:capture-picker','cancel') });
