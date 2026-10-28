// runs in every web page frame of olive's sessions (session.registerPreloadScript, plus
// nodeIntegrationInSubFrames on tabs so iframes get it too). it swaps the page's
// alert / confirm / prompt for olive's popup: a synchronous ipc to main, which answers when
// the user does, so the page blocks exactly like it does in chrome.
const { contextBridge, ipcRenderer } = require('electron');

const ask = (kind, message, value) => ipcRenderer.sendSync('olive:page-dialog', kind, message, value);

try {
  contextBridge.executeInMainWorld({
    func: (ask) => {
      // string conversion happens here, in the page's world, like the native ones do it
      const str = (v) => (v === undefined ? '' : String(v));
      const put = (name, fn) => {
        Object.defineProperty(fn, 'name', { value: name });
        Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true });
      };
      put('alert', function alert(message) { ask('alert', str(message), ''); });
      put('confirm', function confirm(message) { return ask('confirm', str(message), '') === true; });
      put('prompt', function prompt(message, defaultValue) {
        const r = ask('prompt', str(message), str(defaultValue));
        return typeof r === 'string' ? r : null;
      });
    },
    args: [ask],
  });
} catch {
  // a frame without a main world to reach (should not happen): keep chromium's own
}
