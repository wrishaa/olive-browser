// keeps tabs the agent works in throttled like any background tab, except while
// an agent step runs. for a hidden tab (not on screen in its window) a step gets:
// - a size: chromium doesn't resize hidden views (setBounds on an invisible view
//   leaves innerWidth 0), so the step sets a CDP device-metrics override at the
//   size the tab would have on screen. enough for screenshots and layout, and
//   costs ~nothing on its own.
// - focus (default, not for screenshots/text): CDP focus emulation, which makes
//   rAF/timers run at full speed like a foreground page.
// - frames (opt-in only: frames:true on a step, or frames(tab, {ms}) for a
//   window of time): focus emulation alone runs timers at full speed, but a
//   hidden view's compositor still only draws ~1 frame/s, so rAF stays ~1/s.
//   for watching an animation or video the step also subscribes to the view's
//   frames, which makes the compositor draw at the display rate (~60/s).
//   costs gpu+cpu, so it's off by default and ends with the step/window.
// all of it stays for a short linger (back-to-back calls don't flap), then gets
// turned off again and the debugger detached if we attached it, so chromium
// re-throttles the page to background levels. nothing here focuses a window,
// activates the app or changes the selected tab.
//
// a size override the agent set itself (Emulation.setDeviceMetricsOverride via
// /cdp, see noteCdp) wins over ours and is kept between steps: clearing it
// would relayout the page to 0x0 under the agent (and hang the next capture).

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
    this.maxFramesMs = 10 * 60 * 1000;
    this.state = new WeakMap(); // tab -> {steps, frameSteps, framesUntil, awake, focused, frames, attachedByUs, timer, wc}
  }

  st(tab) {
    let s = this.state.get(tab);
    if (!s) this.state.set(tab, (s = { steps: 0, frameSteps: 0, framesUntil: 0, awake: false, focused: false, frames: false, attachedByUs: false, timer: null, wc: null }));
    return s;
  }

  isHidden(win, tab) {
    return !win.visibleIds().includes(tab.id);
  }

  // run fn as one agent step on tab. focus: also emulate focus (full-speed
  // timers) while hidden. frames: also draw at full frame rate (rAF ~60/s).
  async step(win, tab, fn, { focus = true, frames = false } = {}) {
    win.ensureView(tab);
    if (!this.isHidden(win, tab)) return fn();
    const s = this.st(tab);
    s.steps++;
    tab.lastAgentStep = Date.now(); // tab unloading counts agent use as activity
    if (frames) s.frameSteps++;
    if (s.timer) { this.clearTimer(s.timer); s.timer = null; }
    try {
      await this.wake(win, tab, s, focus || frames || this.framesWindow(s), frames || this.framesWindow(s)).catch(() => {}); // best effort: the step still runs, throttled
      return await fn();
    } finally {
      s.steps--;
      if (frames) s.frameSteps--;
      if (s.steps === 0) this.sleepSoon(tab, s);
    }
  }

  framesWindow(s) { return s.framesUntil > Date.now(); }

  // full frame rate for a window of time (ms, default 30s, capped at 10min), or
  // off now with on:false. returns the state. no-op for a tab that's on screen.
  async frames(win, tab, { on = true, ms = 30000 } = {}) {
    win.ensureView(tab);
    const s = this.st(tab);
    if (!on) {
      s.framesUntil = 0;
      if (s.steps === 0) await this.sleep(tab, s); else await this.framesOff(s);
      return this.describe(win, tab);
    }
    if (!this.isHidden(win, tab)) return this.describe(win, tab);
    ms = Math.min(Math.max(Number(ms) || 30000, 1), this.maxFramesMs);
    s.framesUntil = Date.now() + ms;
    if (s.timer) { this.clearTimer(s.timer); s.timer = null; }
    await this.wake(win, tab, s, true, true).catch(() => {});
    if (s.steps === 0) this.sleepSoon(tab, s);
    return this.describe(win, tab);
  }

  describe(win, tab) {
    const s = this.state.get(tab);
    const hidden = this.isHidden(win, tab);
    return { frames: hidden ? !!s?.frames : true, framesUntil: hidden && s && this.framesWindow(s) ? new Date(s.framesUntil).toISOString() : null };
  }

  // the agent's own /cdp traffic: remember a size override it set, so steps
  // reuse it instead of ours and sleep() leaves it alone.
  noteCdp(tab, method, params) {
    if (method === 'Emulation.setDeviceMetricsOverride') tab.agentMetrics = { ...(params || {}) };
    else if (method === 'Emulation.clearDeviceMetricsOverride') tab.agentMetrics = null;
  }

  async framesOff(s) {
    if (!s.frames) return;
    s.frames = false;
    try { if (s.wc && !s.wc.isDestroyed?.()) s.wc.endFrameSubscription(); } catch {}
  }

  async wake(win, tab, s, focus, frames = false) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed?.()) return;
    if (s.awake && s.wc !== wc) { s.awake = s.focused = false; } // view was recreated
    const dbg = wc.debugger;
    if (!s.awake) {
      let fresh = false;
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        s.attachedByUs = !tab.agentCdp;
        fresh = true;
      }
      s.wc = wc;
      s.awake = true;
      if (!tab.agentMetrics) {
        const r = win.hiddenPaneRect?.() || { width: 1200, height: 800 };
        await withTimeout(dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: r.width, height: r.height, deviceScaleFactor: 0, mobile: false }), this.cmdTimeoutMs, 'size override');
      } else if (fresh) {
        // a fresh session lost the agent's override (detach drops it): put it back
        await withTimeout(dbg.sendCommand('Emulation.setDeviceMetricsOverride', tab.agentMetrics), this.cmdTimeoutMs, 'size override');
      }
    }
    if (focus && !s.focused) {
      s.focused = true;
      await withTimeout(dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), this.cmdTimeoutMs, 'focus emulation');
    }
    if (frames && !s.frames) {
      s.frames = true;
      // the callback gets each dirty frame; we only need the compositor drawing
      wc.beginFrameSubscription(true, () => {});
    }
  }

  sleepSoon(tab, s = this.st(tab)) {
    if (!s.awake) return;
    if (s.timer) this.clearTimer(s.timer);
    const left = s.framesUntil - Date.now();
    if (left > 0) {
      // inside a frames window: stay awake with frames until it ends
      s.timer = this.setTimer(() => { s.timer = null; if (s.steps === 0) this.sleepSoon(tab, s); }, left);
    } else {
      if (s.frames && s.frameSteps === 0) this.framesOff(s); // frames end with the step, not the linger
      s.timer = this.setTimer(() => { s.timer = null; if (s.steps === 0) this.sleep(tab, s); }, this.lingerMs);
    }
    s.timer?.unref?.();
  }

  // drop the overrides now (also when the tab gets selected and shown for real)
  async sleep(tab, s = this.state.get(tab)) {
    if (!s?.awake) return;
    if (s.timer) { this.clearTimer(s.timer); s.timer = null; }
    await this.framesOff(s);
    s.framesUntil = 0;
    const { wc, focused } = s;
    const attachedByUs = s.attachedByUs && !tab.agentCdp;
    s.awake = s.focused = s.attachedByUs = false;
    s.wc = null;
    if (!wc || wc.isDestroyed?.()) return;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) return;
    if (attachedByUs) { try { dbg.detach(); } catch {} return; } // detaching drops every override, and idle discarding sees the tab again
    if (focused) { try { await withTimeout(dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }), this.cmdTimeoutMs, 'focus emulation off'); } catch {} }
    if (!tab.agentMetrics) { try { await withTimeout(dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {}), this.cmdTimeoutMs, 'clear size override'); } catch {} }
  }

  // an agent step is running on tab or it is still awake from one (tab unloading exempts it)
  busy(tab) {
    const s = this.state.get(tab);
    return !!(s && (s.steps > 0 || s.awake));
  }

  isAwake(tab) {
    return !!this.state.get(tab)?.awake;
  }
}

module.exports = { AgentWake, withTimeout };
