// runs in every web page frame of olive's sessions (session.registerPreloadScript).
// electron has no webauthn ui: chromium's "use your security key" dialog doesn't exist here, so
// navigator.credentials.create/get just waits for a key with nothing on screen, and it never
// settles on its own, not even after the site's publicKey.timeout; every later request on the
// page then fails with "A request is already pending". two fixes here:
//  1. while a request waits (after a short delay, so a fast authenticator doesn't flash it), olive
//     shows its own tab-modal prompt: "insert your security key and touch it", with Cancel
//     (src/main/page-dialogs.js, kind 'passkey'). cancel ends the call with NotAllowedError,
//     like chrome's dialog does.
//  2. the call gets the same NotAllowedError chrome gives once the timeout runs out (chromium's
//     clamp: 10 s .. 10 min, 5 min when unset), which also frees the request slot.
// conditional (autofill) requests are left alone: they are meant to wait, silently.
const { contextBridge, ipcRenderer } = require('electron');

const cancels = new Map(); // prompt id -> the page-world function that ends that request
let seq = 0;
ipcRenderer.on('olive:webauthn-cancel', (_e, id) => { const f = cancels.get(id); cancels.delete(id); try { f && f(); } catch {} });
const prompt = (op, rpId, onCancel) => {
  const id = ++seq;
  cancels.set(id, onCancel);
  ipcRenderer.send('olive:webauthn-prompt', id, op === 'get' ? 'get' : 'create', typeof rpId === 'string' ? rpId : '');
  return id;
};
const unprompt = (id) => { if (!cancels.delete(id)) return; ipcRenderer.send('olive:webauthn-prompt-end', id); };

try {
  contextBridge.executeInMainWorld({
    func: (prompt, unprompt) => {
      const C = globalThis.CredentialsContainer;
      if (!C || !C.prototype || typeof AbortController !== 'function') return;
      const LOW = 10000, HIGH = 600000, DEFAULT = 300000, GRACE = 1000, SHOW_AFTER = 600;
      const MESSAGE = 'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
      const wrap = (name) => {
        const native = C.prototype[name];
        if (typeof native !== 'function') return;
        const wrapped = { [name](options) {
          let pk, mediation, signal;
          try { pk = options && options.publicKey; mediation = options && options.mediation; signal = options && options.signal; } catch {}
          if (!pk || mediation === 'conditional' || typeof AbortSignal.any !== 'function') return native.apply(this, arguments);
          let ms = DEFAULT; try { const t = Number(pk.timeout); if (Number.isFinite(t) && t > 0) ms = Math.min(HIGH, Math.max(LOW, t)); } catch {}
          let rpId = ''; try { rpId = String((name === 'get' ? pk.rpId : pk.rp && pk.rp.id) || location.hostname || ''); } catch {}
          const ours = new AbortController();
          const fail = () => ours.abort(new DOMException(MESSAGE, 'NotAllowedError'));
          const timer = setTimeout(fail, ms + GRACE);
          let shown = null;
          const show = setTimeout(() => { try { shown = prompt(name, rpId, fail); } catch {} }, SHOW_AFTER);
          let next; try { next = Object.assign({}, options, { signal: signal ? AbortSignal.any([signal, ours.signal]) : ours.signal }); } catch { clearTimeout(timer); clearTimeout(show); return native.apply(this, arguments); }
          const done = () => { clearTimeout(timer); clearTimeout(show); if (shown != null) { try { unprompt(shown); } catch {} shown = null; } };
          let p; try { p = native.call(this, next); } catch (e) { done(); throw e; }
          p.then(done, done); return p;
        } }[name];
        Object.defineProperty(C.prototype, name, { value: wrapped, writable: true, configurable: true, enumerable: true });
      };
      wrap('create'); wrap('get');
    },
    args: [prompt, unprompt],
  });
} catch {}
