// runs in every web page frame of olive's sessions (session.registerPreloadScript).
// electron has no webauthn ui: when no authenticator answers (no touch id set up, no security
// key, a phone/qr request), navigator.credentials.create/get never settles, not even after the
// site's own publicKey.timeout, and every later request on the page then fails with
// "A request is already pending". chrome would show its dialog and fail the call at the timeout.
// here the page's call gets the same NotAllowedError chrome gives once the timeout runs out
// (chromium's clamp: 10 s .. 10 min, 5 min when unset), which also frees the request slot.
// conditional (autofill) requests are left alone: they are meant to wait.
const { contextBridge } = require('electron');

try {
  contextBridge.executeInMainWorld({
    func: () => {
      const C = globalThis.CredentialsContainer;
      if (!C || !C.prototype || typeof AbortController !== 'function') return;
      const LOW = 10000, HIGH = 600000, DEFAULT = 300000, GRACE = 1000;
      const MESSAGE = 'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
      const wrap = (name) => {
        const native = C.prototype[name];
        if (typeof native !== 'function') return;
        const wrapped = { [name](options) {
          let pk, mediation, signal;
          try { pk = options && options.publicKey; mediation = options && options.mediation; signal = options && options.signal; } catch {}
          if (!pk || mediation === 'conditional' || typeof AbortSignal.any !== 'function') return native.apply(this, arguments);
          let ms = DEFAULT; try { const t = Number(pk.timeout); if (Number.isFinite(t) && t > 0) ms = Math.min(HIGH, Math.max(LOW, t)); } catch {}
          const ours = new AbortController();
          const timer = setTimeout(() => ours.abort(new DOMException(MESSAGE, 'NotAllowedError')), ms + GRACE);
          let next; try { next = Object.assign({}, options, { signal: signal ? AbortSignal.any([signal, ours.signal]) : ours.signal }); } catch { clearTimeout(timer); return native.apply(this, arguments); }
          const done = () => clearTimeout(timer);
          const p = native.call(this, next); p.then(done, done); return p;
        } }[name];
        Object.defineProperty(C.prototype, name, { value: wrapped, writable: true, configurable: true, enumerable: true });
      };
      wrap('create'); wrap('get');
    },
    args: [],
  });
} catch {}
