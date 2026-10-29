// runs in every web page frame of olive's sessions (session.registerPreloadScript, plus
// nodeIntegrationInSubFrames on tabs so iframes get it too).
// electron's permission check handler is boolean, and "not decided yet" has to be false (so
// enumerateDevices keeps device labels and ids hidden), which chromium reports to the page as
// 'denied'. sites like google meet then say "allow it in your browser settings" and never call
// getUserMedia, so olive's own prompt never shows. here the page instead sees chrome's states:
// navigator.permissions.query(...).state and Notification.permission follow olive's per-origin
// choice ('granted' / 'denied' / 'prompt'), and change events fire when the user decides in the
// prompt or in site settings. the real requests still go through olive's request handler.
const { contextBridge, ipcRenderer } = require('electron');

let initial = null;
try { initial = ipcRenderer.sendSync('olive:site-permission-state'); } catch {}

if (initial && typeof initial === 'object') {
  try {
    const update = contextBridge.executeInMainWorld({
      func: (first) => {
        let state = first;
        const P = globalThis.PermissionStatus, Perms = globalThis.Permissions, N = globalThis.Notification;
        const getter = (name, fn) => Object.getOwnPropertyDescriptor({ get [name]() { return fn(this); } }, name).get;
        const tracked = new WeakMap(); // PermissionStatus -> query name
        const seen = new WeakMap(); // PermissionStatus -> state the page last saw
        const live = new Set(); // WeakRef<PermissionStatus>
        if (P && Perms) {
          const desc = Object.getOwnPropertyDescriptor(P.prototype, 'state');
          const nativeState = desc && desc.get;
          const query = Perms.prototype.query;
          if (nativeState && typeof query === 'function') {
            Object.defineProperty(P.prototype, 'state', { configurable: true, enumerable: desc.enumerable,
              get: getter('state', s => { const n = tracked.get(s); return n && state[n] ? state[n] : nativeState.call(s); }) });
            const wrapped = { query(descriptor) {
              let name; try { name = descriptor && descriptor.name; } catch {}
              return query.apply(this, arguments).then(status => {
                if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(state, name)) { tracked.set(status, name); seen.set(status, state[name]); live.add(new WeakRef(status)); }
                return status;
              });
            } }.query;
            Object.defineProperty(Perms.prototype, 'query', { value: wrapped, writable: true, configurable: true, enumerable: true });
          }
        }
        if (N) {
          const d = Object.getOwnPropertyDescriptor(N, 'permission');
          if (d && d.get) Object.defineProperty(N, 'permission', { configurable: true, enumerable: d.enumerable,
            get: getter('permission', () => (state.notifications === 'granted' ? 'granted' : state.notifications === 'denied' ? 'denied' : 'default')) });
        }
        return (next) => {
          if (!next || typeof next !== 'object') return;
          state = next;
          for (const ref of [...live]) {
            const status = ref.deref(); if (!status) { live.delete(ref); continue; }
            const now = state[tracked.get(status)];
            if (now && now !== seen.get(status)) { seen.set(status, now); try { status.dispatchEvent(new Event('change')); } catch {} }
          }
        };
      },
      args: [initial],
    });
    if (typeof update === 'function') ipcRenderer.on('olive:site-permission-state', (_e, next) => { try { update(next); } catch {} });
  } catch {
    // no main world to reach: chromium's own (stricter) states stay
  }
}
