// page dialogs (alert / confirm / prompt): the pure parts, no electron. electron stubs
// window.prompt with a throw and its native alert/confirm close by themselves in olive's
// WebContentsView tabs, so every page dialog goes through olive's own popup instead
// (src/main/page-dialogs.js, src/ui/page-dialogs-preload.js).
'use strict';

const KINDS = ['alert', 'confirm', 'prompt'];
const MAX_MESSAGE = 10000; // chars kept from a page message (chrome cuts long ones too)
const MAX_VALUE = 10000;
const SUPPRESS_AFTER = 2; // from the 3rd dialog of one page load on, offer "don't allow more"

// what the page gets back when the dialog is dismissed without an answer (tab closed,
// navigated away, crashed, suppressed, or nowhere to show it)
function fallback(kind) {
  if (kind === 'passkey') return 'cancel';
  if (kind === 'confirm') return false;
  if (kind === 'prompt') return null;
  return null; // alert: the preload returns undefined either way
}

// the answer sent back over sendSync: alert -> null, confirm -> boolean, prompt -> string | null
function result(kind, ok, text) {
  if (kind === 'confirm') return ok === true;
  if (kind === 'prompt') return ok === true ? clip(typeof text === 'string' ? text : '', MAX_VALUE) : null;
  return null;
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// a request from the preload, checked: kind is one of three, strings only, sizes capped
function normalize(kind, message, value) {
  if (!KINDS.includes(kind)) return null;
  return {
    kind,
    message: clip(typeof message === 'string' ? message : '', MAX_MESSAGE),
    value: kind === 'prompt' ? clip(typeof value === 'string' ? value : '', MAX_VALUE) : '',
  };
}

// a passkey prompt (not a page dialog: electron has no webauthn ui, see
// src/ui/webauthn-preload.js): what to say while a create/get waits for a security key
function passkey(op, rpId) {
  if (op !== 'create' && op !== 'get') return null;
  const rp = clip(typeof rpId === 'string' ? rpId.trim() : '', 253);
  const site = rp || 'this site';
  return {
    op,
    title: op === 'create' ? `Create a passkey for ${site}` : `Sign in to ${site} with a passkey`,
    message: 'Insert your security key and touch it.\n\nOlive can’t use passkeys saved in iCloud Keychain, on this Mac with Touch ID, or on a phone yet.',
  };
}

function originOf(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    if (u.protocol === 'chrome-extension:') return 'An extension';
    return null; // file:, data:, about:, blob: and the like: "This page says"
  } catch { return null; }
}

// the title line, chrome style: "example.com says", "An embedded page at ads.example says"
function title(topUrl, frameUrl, isMainFrame = true) {
  const top = originOf(topUrl);
  const frame = isMainFrame ? top : originOf(frameUrl);
  if (!isMainFrame && frame && frame !== top) return `An embedded page at ${frame} says`;
  const who = isMainFrame ? top : (frame || top);
  return who ? `${who} says` : 'This page says';
}

// per page load: count dialogs, and once the user ticks "don't allow more dialogs from this
// page" answer the rest at once. reset on a main-frame navigation.
class PageCounter {
  constructor() { this.map = new Map(); }
  entry(key) {
    let e = this.map.get(key);
    if (!e) { e = { count: 0, blocked: false }; this.map.set(key, e); }
    return e;
  }
  blocked(key) { return !!this.map.get(key)?.blocked; }
  // counts one dialog, returns whether the popup should offer the "don't allow more" box
  next(key) { const e = this.entry(key); e.count++; return e.count > SUPPRESS_AFTER; }
  block(key) { this.entry(key).blocked = true; }
  reset(key) { this.map.delete(key); }
}

module.exports = { KINDS, MAX_MESSAGE, MAX_VALUE, SUPPRESS_AFTER, fallback, result, normalize, passkey, title, originOf, PageCounter };
