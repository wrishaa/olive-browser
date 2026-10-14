// browsing history: url -> {url, title, favicon, visits, last}
const { JsonStore } = require('./store');

const MAX = 20000;

function recordable(url) {
  return /^https?:\/\//i.test(url || '');
}

class History {
  constructor(file) {
    this.store = new JsonStore(file, () => ({ entries: [] }));
    this.map = new Map();
    for (const e of this.store.data.entries || []) this.map.set(e.url, e);
  }

  add(url, title) {
    if (!recordable(url)) return;
    const e = this.map.get(url) || { url, title: '', favicon: '', visits: 0, last: 0 };
    e.visits += 1;
    e.last = Date.now();
    if (title) e.title = title;
    this.map.delete(url);
    this.map.set(url, e); // keep insertion order = recency
    this.trim();
    this.persist();
  }

  update(url, patch) {
    const e = this.map.get(url);
    if (!e) return;
    Object.assign(e, patch);
    this.persist();
  }

  trim() {
    while (this.map.size > MAX) this.map.delete(this.map.keys().next().value);
  }

  persist() {
    this.store.data.entries = [...this.map.values()];
    this.store.save(1500);
  }

  flush() {
    this.store.data.entries = [...this.map.values()];
    this.store.flush();
  }

  clear() {
    this.map.clear();
    this.persist();
  }

  recent(limit = 8) {
    return [...this.map.values()].reverse().slice(0, limit);
  }

  list({ query = '', limit = 200 } = {}) {
    const all = [...this.map.values()].reverse();
    if (!query) return all.slice(0, limit);
    const q = query.toLowerCase();
    return all.filter((e) => e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)).slice(0, limit);
  }

  search(query, limit = 6) {
    const q = query.trim().toLowerCase();
    if (!q) return this.recent(limit);
    const words = q.split(/\s+/).filter(Boolean);
    const now = Date.now();
    const scored = [];
    for (const e of this.map.values()) {
      const url = e.url.toLowerCase();
      const host = url.replace(/^https?:\/\/(www\.)?/, '');
      const title = (e.title || '').toLowerCase();
      let score = 0;
      let ok = true;
      for (const w of words) {
        if (host.startsWith(w)) score += 12;
        else if (url.includes(w)) score += 5;
        else if (title.includes(w)) score += 4;
        else { ok = false; break; }
      }
      if (!ok) continue;
      const ageDays = (now - e.last) / 86400000;
      score += Math.min(10, Math.log2(1 + e.visits) * 2.5) + Math.max(0, 6 - ageDays);
      // shorter urls (homepages) first on ties
      score -= Math.min(4, host.length / 40);
      scored.push([score, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map((s) => s[1]);
  }
}

module.exports = { History };
