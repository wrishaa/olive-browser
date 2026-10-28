// Local foreground site time, separate from browsing history and the event ledger.
// Persist only civil day -> hostname -> seconds. No page URLs or event timestamps.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const RANGES = ['today', 'week', 'all'];
const MAX_GAP_MS = 30000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DAY_SECONDS = 90000; // a 25-hour daylight-saving day

function siteForURL(value) {
  if (typeof value !== 'string' || value.length > 65536) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch { return null; }
}
function validSite(site) {
  return typeof site === 'string' && site.length > 0 && site.length <= 253 &&
    siteForURL(`https://${site}/`) === site && !/[\s/@?#\\]/.test(site) &&
    !['__proto__', 'constructor', 'prototype'].includes(site);
}
function dayKey(value) {
  const date = new Date(value);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00`);
  return Number.isFinite(date.getTime()) && date.getFullYear() >= 1970 && dayKey(date) === day;
}
function localDaysAgo(now, back) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0); // local noon remains safe over DST transitions
  date.setDate(date.getDate() - back);
  return dayKey(date);
}
function civilDayNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function duration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

class SiteTime {
  constructor(file, { now = () => Date.now(), monotonicNow = () => performance.now(), maxGapMs = MAX_GAP_MS } = {}) {
    this.file = file;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.maxGapMs = Math.min(MAX_GAP_MS, Math.max(1, maxGapMs));
    this.days = Object.create(null);
    this.current = null;
    this.dirty = false;
    this.error = null;
    this.closed = false;
    this.load();
  }
  get currentSite() { return this.current?.site || null; }
  load() {
    if (!this.file) return;
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > MAX_FILE_BYTES) throw new Error('Invalid site time file');
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (data?.version !== 1 || !data.days || typeof data.days !== 'object' || Array.isArray(data.days)) throw new Error('Invalid site time data');
      const today = dayKey(this.now());
      for (const [day, sites] of Object.entries(data.days)) {
        if (!validDay(day) || day > today || !sites || typeof sites !== 'object' || Array.isArray(sites)) continue;
        for (const [site, seconds] of Object.entries(sites)) {
          if (!validSite(site) || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DAY_SECONDS) continue;
          (this.days[day] ||= Object.create(null))[site] = seconds;
        }
      }
      fs.fchmodSync(fd, 0o600);
      // Canonicalize even loaded data: strip unknown fields and rejected entries.
      this.dirty = true;
    } catch (err) {
      if (err.code !== 'ENOENT') this.error = 'Could not read site time. New time is still counted locally.';
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // A single running segment means split views/windows can never multiply time.
  update({ url = null, active = false, isPrivate = false } = {}) {
    if (this.closed) return;
    const wall = this.now(), mono = this.monotonicNow();
    this.checkpoint(wall, mono);
    const site = active && !isPrivate ? siteForURL(url) : null;
    this.current = validSite(site) && Number.isFinite(wall) && Number.isFinite(mono) ? { site, wall, mono } : null;
  }
  checkpoint(wall = this.now(), mono = this.monotonicNow()) {
    if (this.closed || !this.current) return;
    const previous = this.current;
    const elapsed = mono - previous.mono, wallElapsed = wall - previous.wall;
    // Suspend/occlusion events normally stop a segment. If the event loop was
    // suspended, never backfill an unobserved gap (or a changed system clock).
    if (Number.isFinite(elapsed) && Number.isFinite(wallElapsed) && elapsed > 0 && wallElapsed >= 0 &&
        elapsed <= this.maxGapMs && wallElapsed <= this.maxGapMs && Math.abs(elapsed - wallElapsed) <= 2000) {
      this.add(previous.site, previous.wall, previous.wall + elapsed);
    }
    this.current = Number.isFinite(wall) && Number.isFinite(mono) ? { site: previous.site, wall, mono } : null;
  }
  add(site, from, to) {
    while (from < to) {
      const next = new Date(from);
      next.setHours(24, 0, 0, 0);
      const end = Math.min(to, next.getTime());
      if (!Number.isFinite(end) || end <= from) break;
      const sites = this.days[dayKey(from)] ||= Object.create(null);
      sites[site] = Math.min(MAX_DAY_SECONDS, (sites[site] || 0) + (end - from) / 1000);
      this.dirty = true;
      from = end;
    }
  }
  snapshot(range = 'today') {
    if (!RANGES.includes(range)) range = 'today';
    this.checkpoint();
    const now = this.now(), today = dayKey(now);
    const seven = Array.from({ length: 7 }, (_, i) => localDaysAgo(now, 6 - i));
    const sum = new Map();
    const keys = Object.keys(this.days).filter(key => key <= today).sort();
    for (const key of keys) {
      if (range === 'today' && key !== today || range === 'week' && !seven.includes(key)) continue;
      for (const [site, seconds] of Object.entries(this.days[key])) sum.set(site, (sum.get(site) || 0) + seconds);
    }
    const entries = [...sum].filter(([, seconds]) => seconds > 0).map(([site, seconds]) => ({ site, seconds })).sort((a, b) => b.seconds - a.seconds || a.site.localeCompare(b.site));
    const totalSeconds = entries.reduce((sum, entry) => sum + entry.seconds, 0);
    const peak = entries[0]?.seconds || 1;
    const dayCount = range === 'week' ? 7 : range === 'all' && keys.length ? Math.max(1, civilDayNumber(today) - civilDayNumber(keys[0]) + 1) : 1;
    const daily = seven.map(day => ({ day, seconds: Object.values(this.days[day] || {}).reduce((a, b) => a + b, 0), isToday: day === today }));
    return { range, totalSeconds, siteCount: entries.length, averageSeconds: totalSeconds / dayCount, dayCount, daily,
      entries: entries.map(entry => ({ ...entry, share: totalSeconds ? entry.seconds / totalSeconds : 0, fraction: entry.seconds / peak })),
      currentSite: this.currentSite, error: this.error };
  }
  hasSite(site) { return validSite(site) && Object.values(this.days).some(sites => Object.hasOwn(sites, site)); }
  reset() {
    // Do not let the pre-reset segment reappear on the next heartbeat.
    this.current = null;
    this.days = Object.create(null);
    this.dirty = true;
    return this.flush();
  }
  flush() {
    if (this.closed) return !this.error;
    this.checkpoint();
    if (!this.file || !this.dirty) return !this.error;
    let tmp, fd;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      tmp = `${this.file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, days: this.days }) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.error = null;
      return true;
    } catch {
      this.error = 'Could not save site time on this device.';
      return false;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (tmp) try { fs.unlinkSync(tmp); } catch {}
    }
  }
  close() {
    if (this.closed) return !this.error;
    this.update({ active: false });
    const ok = this.flush();
    this.closed = true;
    return ok;
  }
}
module.exports = { SiteTime, siteForURL, validSite, dayKey, duration, RANGES, MAX_GAP_MS };
