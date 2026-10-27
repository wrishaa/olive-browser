// Local, per-profile activity metadata only. Never pass page contents or form data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TYPES = ['visit', 'navigation', 'tab-open', 'tab-close', 'tab-activate', 'tab-unload', 'search', 'download', 'permission'];
const DAY = 86400000;
const MAX_EVENTS = 50000;
const RETENTION = [1, 7, 30, 90, 365];

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    u.username = ''; u.password = ''; u.hash = '';
    // Query values can contain auth, email, search or form text. Keep no values,
    // including unknown keys (signed URLs use an ever-changing vocabulary).
    u.search = '';
    const segments = u.pathname.split('/');
    let redactNext = false;
    u.pathname = segments.map(s => {
      const decoded = decodeURIComponent(s);
      const secret = redactNext || /(?:token|secret|password|session|auth|oauth|callback|reset|verify|magic|invite)/i.test(decoded) || /@|[\w-]{32,}/.test(decoded);
      redactNext = /^(?:token|secret|password|session|auth|oauth|callback|reset|verify|magic|invite)$/i.test(decoded);
      return secret ? '[redacted]' : s;
    }).join('/');
    return u.href.slice(0, 2048);
  } catch { return ''; }
}

function sanitize(type, details = {}) {
  if (!TYPES.includes(type) || !details || typeof details !== 'object' || details.private || details.isPrivate) return null;
  const out = {};
  for (const key of ['url', 'fromUrl', 'origin']) {
    const value = redactUrl(details[key]);
    if (value) out[key] = key === 'origin' ? new URL(value).origin : value;
  }
  for (const key of ['windowId', 'tabId', 'bytes', 'receivedBytes', 'totalBytes']) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) out[key] = details[key];
  }
  // Deliberate allowlists: no filenames, paths, titles, queries, cookies, headers,
  // arbitrary reason/error strings, request bodies or external-protocol payloads.
  const enums = {
    action: ['back', 'forward', 'reload', 'navigate', 'start', 'complete', 'cancel', 'interrupt', 'request', 'decision', 'reset', 'set'],
    state: ['progressing', 'completed', 'cancelled', 'interrupted'],
    decision: ['allow', 'deny', 'block', 'ask'],
    permission: ['media', 'media:audio', 'media:video', 'microphone', 'camera', 'geolocation', 'notifications', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'speaker-selection', 'local-network-access', 'openExternal', 'midiSysex', 'idle-detection', 'hid', 'serial', 'usb', 'storage-access', 'top-level-storage-access', 'keyboardLock', 'window-management'],
    engine: ['google', 'bing', 'duckduckgo', 'other'],
  };
  for (const [key, values] of Object.entries(enums)) if (values.includes(details[key])) out[key] = details[key];
  for (const key of ['allowed', 'remember', 'sameDocument']) if (typeof details[key] === 'boolean') out[key] = details[key];
  return out;
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

class Ledger {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file; this.now = now; this.events = []; this.settings = { enabled: true, retentionDays: 90 };
    this.timer = null; this.error = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.settings?.enabled === 'boolean') this.settings.enabled = data.settings.enabled;
      if (RETENTION.includes(data.settings?.retentionDays)) this.settings.retentionDays = data.settings.retentionDays;
      for (const e of Array.isArray(data.events) ? data.events : []) {
        const details = sanitize(e.type, e.details);
        if (details && typeof e.id === 'string' && /^[\w-]{1,64}$/.test(e.id) && Number.isFinite(e.time)) this.events.push({ id: e.id, time: e.time, type: e.type, details });
      }
      fs.chmodSync(file, 0o600);
    } catch (e) { if (e.code !== 'ENOENT') this.error = 'Could not read activity file'; }
    this.prune();
    // Rewrites loaded data too: retention and newer redaction rules apply on disk.
    if (fs.existsSync(file) && !this.error) this.flush();
  }
  prune() {
    const cutoff = this.now() - this.settings.retentionDays * DAY;
    this.events = this.events.filter(e => e.time >= cutoff && e.time <= this.now()).sort((a, b) => a.time - b.time).slice(-MAX_EVENTS);
  }
  record(type, details = {}) {
    if (!this.settings.enabled) return null;
    const clean = sanitize(type, details); if (!clean) return null;
    const event = { id: crypto.randomUUID(), time: this.now(), type, details: clean };
    this.events.push(event); this.prune();
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 250); this.timer.unref?.(); }
    return event.id;
  }
  configure({ enabled, retentionDays } = {}) {
    if (typeof enabled === 'boolean') this.settings.enabled = enabled;
    if (RETENTION.includes(retentionDays)) this.settings.retentionDays = retentionDays;
    this.prune(); return this.flush();
  }
  matching(filter = {}) {
    this.prune();
    const q = String(filter.query || '').toLowerCase().slice(0, 200);
    const from = Number.isFinite(filter.from) ? filter.from : -Infinity;
    const to = Number.isFinite(filter.to) ? filter.to : Infinity;
    return this.events.filter(e => (!filter.type || e.type === filter.type) && e.time >= from && e.time <= to && (!q || JSON.stringify(e).toLowerCase().includes(q)));
  }
  list(filter = {}) { return this.matching(filter).slice().reverse().slice(0, Math.min(2000, Math.max(1, Number(filter.limit) || 500))); }
  remove(filter = {}) {
    const ids = new Set(this.matching(filter).map(e => e.id));
    this.events = this.events.filter(e => !ids.has(e.id)); this.flush(); return ids.size;
  }
  flush() {
    clearTimeout(this.timer); this.timer = null; this.prune();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: this.settings, events: this.events }), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
      this.error = null; return true;
    } catch {
      this.error = 'Could not save activity file';
      try { fs.unlinkSync(tmp); } catch {} return false;
    }
  }
  export(format = 'json', filter = {}) {
    const rows = this.matching(filter);
    if (format === 'json') return JSON.stringify({ version: 1, events: rows }, null, 2) + '\n';
    if (format !== 'csv') throw new Error('Unsupported export format');
    const columns = ['id', 'time', 'type', 'url', 'fromUrl', 'origin', 'windowId', 'tabId', 'action', 'state', 'decision', 'permission', 'allowed', 'remember', 'sameDocument', 'engine', 'bytes', 'receivedBytes', 'totalBytes'];
    return [columns.join(','), ...rows.map(e => columns.map(k => csvCell(k === 'time' ? new Date(e.time).toISOString() : (e[k] ?? e.details[k]))).join(','))].join('\n') + '\n';
  }
  close() { return this.flush(); }
}
module.exports = { Ledger, redactUrl, sanitize, TYPES, RETENTION, MAX_EVENTS };
