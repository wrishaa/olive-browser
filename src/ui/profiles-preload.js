const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('oliveProfiles',{get:()=>ipcRenderer.invoke('olive:profiles','get'),create:name=>ipcRenderer.invoke('olive:profiles','create',{name}),rename:(id,name)=>ipcRenderer.invoke('olive:profiles','rename',{id,name}),switch:id=>ipcRenderer.invoke('olive:profiles','switch',{id})});
