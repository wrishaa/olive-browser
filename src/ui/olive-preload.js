// The one preload for Olive's own pages (olive:// tabs, src/main/internal-pages.js).
// Registered as a frame preload on the profile session, so it runs in every frame of every
// tab; it exposes nothing unless this is the main frame of an olive:// page, and then only
// the bridges for that page. main checks every call again (InternalPages.sender), so a
// bridge alone grants nothing. sandboxed: no require() of local files, everything is here.
const { contextBridge, ipcRenderer } = require('electron');

(() => {
  if (location.protocol !== 'olive:' || window.top !== window) return;
  const host = location.hostname;
  const expose = (name, api) => contextBridge.exposeInMainWorld(name, api);
  const on = (channel, fn) => ipcRenderer.on(channel, (_e, value) => fn(value));

  if (host === 'settings') {
    const settings = (action, payload) => ipcRenderer.invoke('olive:settings', action, payload);
    expose('oliveSettings', {
      get: () => settings('get'),
      set: (key, value) => settings('set', { key, value }),
      permission: (origin, key, value) => settings('permission', { origin, key, value }),
      forgetSite: origin => settings('forgetSite', { origin }),
      macos: kind => settings('macos', { kind }),
      onState: fn => on('olive:settings-state', fn),
    });
    // Keyboard Shortcuts (src/main/shortcuts.js). recording(true) while a shortcut field has
    // focus: the tab then gets every key (menu shortcuts and tab keys pause), like before.
    expose('shortcuts', {
      get: () => ipcRenderer.invoke('olive:shortcuts', 'get'),
      set: (id, value) => ipcRenderer.invoke('olive:shortcuts', 'set', { id, value }),
      reset: () => ipcRenderer.invoke('olive:shortcuts', 'reset'),
      recording: on => ipcRenderer.invoke('olive:shortcuts', 'recording', { on: on === true }),
    });
    // Extensions (src/main/extension-settings.js)
    expose('extensionSettings', {
      get: () => ipcRenderer.invoke('olive:extensions', 'get'),
      set: (id, key, value) => ipcRenderer.invoke('olive:extensions', 'set', { id, key, value }),
      options: id => ipcRenderer.invoke('olive:extensions', 'options', { id }),
      onState: fn => on('olive:extensions-state', fn),
    });
    // Activities (src/main/site-time.js)
    expose('oliveSiteTime', {
      get: range => ipcRenderer.invoke('olive:site-time', 'get', { range }),
      reset: range => ipcRenderer.invoke('olive:site-time', 'reset', { range }),
      open: site => ipcRenderer.invoke('olive:site-time', 'open', { site }),
    });
  } else if (host === 'ledger') {
    expose('ledger', { call: (action, payload = {}) => ipcRenderer.invoke('olive:ledger', action, payload) });
  } else if (host === 'profiles') {
    expose('oliveProfiles', {
      get: () => ipcRenderer.invoke('olive:profiles', 'get'),
      create: name => ipcRenderer.invoke('olive:profiles', 'create', { name }),
      rename: (id, name) => ipcRenderer.invoke('olive:profiles', 'rename', { id, name }),
      switch: id => ipcRenderer.invoke('olive:profiles', 'switch', { id }),
    });
  } else if (host === 'onboarding') {
    expose('oliveSetup', {
      command: (action, payload = {}) => ipcRenderer.invoke('olive:onboarding', action, payload),
      onState: fn => on('olive:onboarding-state', fn),
    });
  } else if (host === 'extensions') {
    expose('ublock', { command: c => ipcRenderer.invoke('olive:ublock', c), onState: fn => on('olive:ublock-state', fn) });
  }
})();
