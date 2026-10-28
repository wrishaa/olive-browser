# site time implementation contract

owned by task #423. no edits to main.js/window.js/menu.js/ui.js.

## parent wiring

```js
// main.js, Manager constructor after dataPath/history are ready:
this.siteTime = new (require('./site-time').SiteTimeController)(this);

// Manager.newWindow after this.windows.push(w):
this.siteTime?.attachWindow(w);

// switchProfile, before old windows/profiles are changed:
this.siteTime?.pause();
// after the new this.history / dataPath are installed, before restore():
this.siteTime?.reload();
// finally after switchingProfile = false:
this.siteTime?.refresh();

// before-quit (after mgr.quitting = true, before window teardown):
mgr.siteTime?.dispose();

// OliveWindow.layout() at its end (after actual native visibility is set),
// OliveWindow.setOverlay() at its end, and OliveWindow.changed() at its start:
this.mgr.siteTime?.refresh();

// menu / browser action:
mgr.siteTime.show(); // optional owner; defaults to focusedWindow()
```

`SiteTimeController` owns `.tracker` (`SiteTime` from src/core/site-time.js), `.view` (the AppPanel inline page), one 1s heartbeat, and sleep/lock + native window listeners. `reload()` closes the old view, checkpoints/saves the old tracker, and constructs a tracker at `path.join(mgr.dataPath, 'site-time.json')`. `pause()` ends and saves a running segment but does not permanently disable tracking; switchingProfile/quitting guard ongoing heartbeats. `dispose()` is permanent. `attachWindow()` is idempotent and calls refresh().

`refresh()` trusts native `win.isFocused()/isVisible()/isMinimized()`, not the manager's last-focused fallback. It tracks ONLY that window's `activeId` page with a loaded visible native view and real HTTP(S) committed WebContents URL. Private windows, inline app/settings/setup pages, overlays, crashed/error pages, sleeping/locked sessions, quitting/switching profiles are excluded. Split views do not multiply time; activeId remains the selection authority.

## trusted UI / design coordination

- src/ui/site-time.html/css/js + site-time-preload.js; AppPanel in existing browser pane, not a detached window.
- heading / entrypoint: Activities; content: Site Time. ranges: Today / 7 Days / All Time; total, site count, selected-range avg/day (Today=1, 7 Days=7, All Time=calendar days since first tracked day, including zero days), seven-day bars, ranked site/favicon/share/time rows, empty state, reset confirmation (native owner-window sheet), local-only footer.
- no Done dialog footer. Escape / activating an existing tab leaves the inline page normally.
- favicon data uses already-present raster data URIs only. remote favicon URLs never reach the page and no network/cache-miss request is made. initials otherwise.
- IPC: `olive:site-time`, exact registered main-frame sender only. preload `window.oliveSiteTime.get(range)`, `.reset(range)`, `.open(site)`, `.close()`.
- reset is per current profile, never touches history, cookies, sessions, or activity ledger.
- expected design guidance: notes/site-time-mac-design.md, owned by task #422. implementation will follow it when available.

## storage

versioned local `site-time.json`: `{version:1, days:{'YYYY-MM-DD':{'example.com': seconds}}}`. no URLs, titles, favicon data, timestamps, page content, event rows, or window/tab identifiers. local civil-day splitting (DST-aware), monotonic elapsed time and conservative stale-heartbeat/clock-discontinuity rejection, 0600 atomic writes, isolated from activity.json.

## checks

- verified: 17 core tests + 9 controller tests; native fixture covers real focus, exclusions, inline title/close row, native Cancel-default reset, host-only data and 0600 persistence. visual checks include light/dark alpha-composited text contrast >=4.5 and header/control bounds at 1280x800; long ranked lists may scroll. full-window captures use CUA only.

- tests/site-time.test.js: hosts/privacy, range aggregation, local midnight/DST, monotonic clocks, stale gaps, reset, atomic 0600 persistence, corruption/bad inputs and profile file isolation.
- tests/site-time-controller.test.js: native visibility/focus gates, multiwindow/split single counting, sleep, profile teardown/reload, IPC sender/frame guards, confirmation races, cached-only favicons.
- scripts/site-time-native-test.mjs: own temporary isolated Electron fixture only; lifecycle/tracking and native inline view/UI behavior. no installed Olive attach/restart, user store access, installation or signing.
