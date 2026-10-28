// keeps tabs the agent works in throttled like any background tab, except while
// an agent step runs. for a hidden tab (not on screen in its window) a step gets:
// - a size: chromium doesn't resize hidden views (setBounds on an invisible view
//   leaves innerWidth 0), so the step sets a CDP device-metrics override at the
//   size the tab would have on screen. enough for screenshots and layout, and
//   costs ~nothing on its own.
// - focus (default, not for screenshots/text): CDP focus emulation, which makes
//   rAF/timers run at full speed like a foreground page.
// both stay for a short linger (back-to-back calls don't flap), then get turned
// off again and the debugger detached if we attached it, so chromium
// re-throttles the page to background levels. nothing here focuses a window,
// activates the app or changes the selected tab.

function withTimeout(promise, ms, label = 'operation') {
  if (!(ms > 0) || !Number.isFinite(ms)) return Promise.resolve(promise);
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(t));
}

class AgentWake {
  constructor({ lingerMs = 1500, cmdTimeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.lingerMs = lingerMs;
    this.cmdTimeoutMs = cmdTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = new WeakMap(); // tab -> {steps, awake, focused, attachedByUs, timer, wc}
  }

  st(tab) {
    let s = this.state.get(tab);
    if (!s) this.state.set(tab, (s = { steps: 0, awake: false, focused: false, attachedByUs: false, timer: null, wc: null }));
    return s;
  }

  isHidden(win, tab) {
    return !win.visibleIds().includes(tab.id);
  }

  // run fn as one agent step on tab. focus: also emulate focus (full-speed
  // rAF/timers) while hidden.
  async step(win, tab, fn, { focus = true } = {}) {
    win.ensureView(tab);
    if (!this.isHidden(win, tab)) return fn();
    const s = this.st(tab);
    s.steps++;
    if (s.timer) { this.clearTimer(s.timer); s.timer = null; }
    try {
      await this.wake(win, tab, s, focus).catch(() => {}); // best effort: the step still runs, throttled
      return await fn();
    } finally {
      s.steps--;
      if (s.steps === 0) this.sleepSoon(tab, s);
    }
  }

  async wake(win, tab, s, focus) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed?.()) return;
    if (s.awake && s.wc !== wc) { s.awake = s.focused = false; } // view was recreated
    const dbg = wc.debugger;
    if (!s.awake) {
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        s.attachedByUs = !tab.agentCdp;
      }
      s.wc = wc;
      s.awake = true;
      const r = win.hiddenPaneRect?.() || { width: 1200, height: 800 };
      await withTimeout(dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: r.width, height: r.height, deviceScaleFactor: 0, mobile: false }), this.cmdTimeoutMs, 'size override');
    }
    if (focus && !s.focused) {
      s.focused = true;
      await withTimeout(dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), this.cmdTimeoutMs, 'focus emulation');
    }
  }

  sleepSoon(tab, s = this.st(tab)) {
    if (!s.awake) return;
    s.timer = this.setTimer(() => { s.timer = null; if (s.steps === 0) this.sleep(tab, s); }, this.lingerMs);
    s.timer?.unref?.();
  }

  // drop the overrides now (also when the tab gets selected and shown for real)
  async sleep(tab, s = this.state.get(tab)) {
    if (!s?.awake) return;
    if (s.timer) { this.clearTimer(s.timer); s.timer = null; }
    const { wc, focused } = s;
    const attachedByUs = s.attachedByUs && !tab.agentCdp;
    s.awake = s.focused = s.attachedByUs = false;
    s.wc = null;
    if (!wc || wc.isDestroyed?.()) return;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) return;
    if (attachedByUs) { try { dbg.detach(); } catch {} return; } // detaching drops every override, and idle discarding sees the tab again
    if (focused) { try { await withTimeout(dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }), this.cmdTimeoutMs, 'focus emulation off'); } catch {} }
    try { await withTimeout(dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {}), this.cmdTimeoutMs, 'clear size override'); } catch {}
  }

  isAwake(tab) {
    return !!this.state.get(tab)?.awake;
  }
}

module.exports = { AgentWake, withTimeout };
