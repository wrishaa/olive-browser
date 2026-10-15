const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('ublock', {command: c=>ipcRenderer.invoke('olive:ublock',c), onState: fn=>ipcRenderer.on('olive:ublock-state',(_e,s)=>fn(s))});
