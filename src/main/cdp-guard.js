// one filter for every cdp command olive sends or forwards (agent api /tabs/:id/cdp,
// agent-wake's emulation calls, the targetId probe, the raw-port proxy).
//
// why: a test sent Network.clearBrowserCookies through the agent api and signed the
// user out of every account. browser-wide cookie / storage clears are refused;
// per-site deletes still work, and so does anything scoped to a throwaway browser
// context that was created through the same guard session.
//
// method names are matched case-insensitively, and Target.sendMessageToTarget is
// unwrapped (any depth) so a blocked command can't hide inside one.
const BLOCK_MESSAGE = 'blocked by olive: browser-wide clear; use per-site delete';
const NESTED_MESSAGE = 'blocked by olive: could not inspect a nested cdp message';
const MAX_DEPTH = 8;

class CdpBlockedError extends Error {
  constructor(method, why, message = BLOCK_MESSAGE) {
    super(message);
    this.code = 'OLIVE_CDP_BLOCKED';
    this.method = method;
    this.why = why;
  }
}

// a real web origin: http(s) scheme, a host, no wildcard. "*", "", missing or junk
// are refused (chromium reads some of them as "everything").
function realOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('*')) return false;
  try {
    const u = new URL(value.trim());
    return /^(https?|wss?|file):$/.test(u.protocol) && (u.protocol === 'file:' || !!u.hostname);
  } catch { return false; }
}
// a storage key starts with its origin ("https://a.test/" plus optional ^ attributes)
function realStorageKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('*')) return false;
  return realOrigin(value.split('^')[0]);
}
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes('*');

class CdpGuard {
  constructor() {
    this.contexts = new Set(); // browserContextIds created through this guard session
  }

  ownContext(id) { return typeof id === 'string' && this.contexts.has(id); }

  // returns null when the command may go, else the reason it's refused
  reason(method, params, depth = 0) {
    const name = String(method ?? '').trim().toLowerCase();
    const p = params && typeof params === 'object' ? params : {};
    const inOwnContext = this.ownContext(p.browserContextId);
    switch (name) {
      case 'network.clearbrowsercookies':
        return 'clears every cookie in the profile';
      case 'storage.clearcookies':
        return inOwnContext ? null : 'clears every cookie in the profile (only allowed for a browserContextId made with Target.createBrowserContext in this session)';
      case 'storage.cleardatafororigin':
        return realOrigin(p.origin) ? null : 'origin must be one real origin, not "*", empty or missing';
      case 'storage.cleardataforstoragekey':
        return realStorageKey(p.storageKey) ? null : 'storageKey must be one real origin key, not "*", empty or missing';
      case 'network.deletecookies':
        // name alone would delete that cookie name on every site
        return nonEmpty(p.name) && (realOrigin(p.url) || nonEmpty(p.domain)) ? null : 'needs name plus url or domain';
      case 'storage.clearsharedstorageentries':
        return realOrigin(p.ownerOrigin) ? null : 'ownerOrigin must be one real origin';
      case 'storage.cleartrusttokens':
        return realOrigin(p.issuerOrigin) ? null : 'issuerOrigin must be one real origin';
      case 'storage.deletestoragebucket':
        return realStorageKey(p.bucket?.storageKey) ? null : 'bucket.storageKey must be one real origin key';
      case 'target.exposedevtoolsprotocol':
        // hands raw cdp to page javascript, past this guard
        return 'would expose unfiltered cdp to the page';
      case 'target.sendmessagetotarget': {
        let inner = p.message;
        if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return { nested: true, why: 'message is not json' }; } }
        if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return { nested: true, why: 'message is not a cdp command' };
        if (depth >= MAX_DEPTH) return { nested: true, why: 'nested too deep' };
        return this.reason(inner.method, inner.params, depth + 1);
      }
    }
    // a browser-wide data wipe by any other name (BrowsingData.*, Storage.clearAll..., future
    // clear-everything methods): refuse unknown clear/delete/reset in the data domains.
    // Network.clearBrowserCache stays allowed: it drops the http cache only, never cookies
    // or site storage, so it can't sign anyone out.
    const [domain, verb = ''] = name.split('.');
    if (domain === 'browsingdata') return 'clears browsing data';
    if ((domain === 'storage' || domain === 'network') && /^(clear|delete|reset|remove|wipe|purge)/.test(verb)
      && !['network.clearbrowsercache', 'network.clearacceptedencodingsoverride', 'storage.resetsharedstoragebudget'].includes(name)) {
      return 'unknown clear in a cookie/storage domain';
    }
    return null;
  }

  // throws CdpBlockedError when refused
  check(method, params) {
    const why = this.reason(method, params);
    if (!why) return;
    if (typeof why === 'object') throw new CdpBlockedError(method, why.why, NESTED_MESSAGE);
    throw new CdpBlockedError(method, why);
  }

  // learn from a result: contexts this session made (and disposed)
  note(method, params, result) {
    const name = String(method ?? '').trim().toLowerCase();
    if (name === 'target.createbrowsercontext' && typeof result?.browserContextId === 'string') this.contexts.add(result.browserContextId);
    if (name === 'target.disposebrowsercontext' && typeof params?.browserContextId === 'string') this.contexts.delete(params.browserContextId);
  }

  // check, send, note. dbg is a webContents.debugger (or anything with sendCommand)
  async send(dbg, method, params = {}, sessionId) {
    this.check(method, params);
    const result = await (sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params));
    this.note(method, params, result);
    return result;
  }
}

// one guard per webContents debugger session (contexts are per session)
const byTarget = new WeakMap();
function guardFor(target) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return new CdpGuard();
  let g = byTarget.get(target);
  if (!g) { g = new CdpGuard(); byTarget.set(target, g); }
  return g;
}
// the guarded way to talk to a webContents.debugger
const sendGuarded = (dbg, method, params, sessionId) => guardFor(dbg).send(dbg, method, params, sessionId);

module.exports = { CdpGuard, CdpBlockedError, BLOCK_MESSAGE, NESTED_MESSAGE, guardFor, sendGuarded, realOrigin, realStorageKey };
