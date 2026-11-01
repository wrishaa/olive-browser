// A window-local MRU walk. Previewing never mutates recency; releasing the shortcut modifier commits.
class TabMRU {
  constructor() { this.order = []; this.walk = null; this.index = 0; this.start = null; }
  touch(id) {
    if (id == null) return;
    this.order = [id, ...this.order.filter(x => x !== id)];
  }
  step(ids, active, dir = 1) {
    const live = new Set(ids);
    this.order = this.order.filter(id => live.has(id));
    if (!this.walk) {
      this.touch(active);
      this.walk = [...new Set([...this.order, ...ids])].filter(id => live.has(id));
      this.index = Math.max(0, this.walk.indexOf(active));
      this.start = active;
    } else {
      const current = this.walk[this.index];
      const before = this.walk.slice(0, this.index).filter(id => live.has(id)).length;
      this.walk = this.walk.filter(id => live.has(id));
      const at = this.walk.indexOf(current);
      // previewed tab closed mid-walk: continue from its old slot, not from the top
      this.index = at >= 0 ? at : dir > 0 ? before - 1 : before;
    }
    if (!this.walk.length) return null;
    this.index = (((this.index + dir) % this.walk.length) + this.walk.length) % this.walk.length;
    return this.walk[this.index];
  }
  finish(active) { this.walk = null; this.index = 0; this.start = null; this.touch(active); }
  // Esc during a walk: drop it without touching recency. Returns the tab the walk
  // started on (null if no walk, or that tab is gone), for the caller to go back to.
  cancel() {
    if (!this.walk) return null;
    const start = this.start;
    this.walk = null; this.index = 0; this.start = null;
    return start != null && this.order.includes(start) ? start : null;
  }
  remove(id) { this.order = this.order.filter(x => x !== id); if (this.start === id) this.start = null; }
}
module.exports = { TabMRU };
