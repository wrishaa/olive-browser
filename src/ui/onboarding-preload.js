const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oliveSetup', {
  command: (action, payload = {}) => ipcRenderer.invoke('olive:onboarding', action, payload),
  onState: callback => ipcRenderer.on('olive:onboarding-state', (_event, state) => callback(state)),
});
