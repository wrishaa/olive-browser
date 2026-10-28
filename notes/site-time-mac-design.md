# Site Time (Activities) — mac design spec v2

v4 (screenshot verdict, 2026-10-27): the first full-window shot `notes/test-shots/site-time-light-populated7day-full-window.png` PASSES as built by #423 — h1 24/-.6px, total 38/600, rows 62 with a per-row share bar, chart 144 (bars 112), column 840, padding 32 40. those shipped numbers supersede the px below (20/28/36/96/760): the spec px were a starting point, the screenshot is the verdict. #422 restored `src/ui/site-time.css` to #423's version unchanged; no restyle, no reload needed. only nit (cosmetic, not blocking): ~40px empty band between the last row and the footer hairline. still to review: dark, empty, confirm sheet, sidebar-hidden shots.
v3 corrections (from parent review): footer `Activity` opens site time, ledger via menu/omnibar only; menu + command keep `Activities — Site Time`; native visibility / hover architecture is #424's, only the visual outcome is specified.
v2 corrections (from parent review): hover peek stays (fix the deadzone, don't remove the feature); hidden sidebar hides native lights or reserves pane space, never an overlay strip over the page; split view counts one active page only; durations keep seconds (`3m 40s`); reset confirm is a native attached sheet (`dialog.showMessageBox` with the window), not a separate popup window; avg uses the selected range's day count with an explicit label; the `siteTime` api contract is #423's as already wired — this doc only describes the look.

owner: #422 (design). builders: #423 (src/core/site-time.js, src/main/site-time.js, src/ui/site-time.*), #424 (sidebar / traffic lights chrome: window.js, ui.js, ui.css, index.html), parent (menu + omnibar wiring).

reference: olive-browser-ios `Sources/Views/TimeView.swift` + `Sources/Core/TimeTracker.swift`. same model, same numbers, native mac look per `notes/onboarding-mac-design.md` (inline pane page, no card, no scrim, no popup).

## 1. model (core, #423)

- port `TimeTracker` 1:1: per-site seconds per local day key `yyyy-MM-dd`, json file `site-time.json` in userData (per profile dir, like ledger). write-through debounced ≤ 5 s, flush on quit/hide.
- site key = `hostname` lowercased, strip leading `www.`. no path, no scheme.
- count only when ALL true: app is foreground (`app.isFocused` / window focused), the tab is the active tab in its pane, the page's `document.visibilityState === 'visible'` (webContents not hidden/occluded). split view: only ONE page counts per window — the active (focused) pane's tab — so the sum of all sites never exceeds wall time (parent contract). private windows/sessions: never recorded (same rule as ledger).
- tick every 1 s in main; attribute the second to the current site(s). no tracking of `about:`, `data:`, `file:`, `olive://` app pages, blank.
- api: whatever #423 already wired (`olive.call('siteTime', ...)` style) is the contract; this spec does not mandate shapes. the ui needs: total for the range, per-site rows (desc) with share of range total, the last 7 days' totals, number of days covered by the range, and reset.
- avg / day = range total / number of days in the selected range (Today → 1, 7 Days → 7, All Time → days since first record, min 1). the label says which: `Avg / day · 7 days`, `Avg / day · 1 day`, `Avg / day · 23 days`. (ios divides by 7 always; we follow the selected range unless the user says otherwise.)
- duration format keeps seconds like the ios screenshot: `<1m` → `40s`, `<1h` → `3m 40s`, `≥1h` → `2h 05m` (seconds dropped at hour scale), `≥24h` → `1d 3h`. zero → `0s`. tabular-nums everywhere a duration shows.

## 2. page (ui, #423) — `src/ui/site-time.html/.css/.js`

opens as an `AppPanel` inline page in the pane (same as ledger / shortcuts / profiles). sidebar `#settings-row` title: `Site Time`. page title / h1: `Site Time`. no wordmark, no serif, no card, no scrim. Escape closes (InlinePage default).

### layout column

- `body` uses settings-base.css (13px SF, `--text`, `--text-dim`, `--line`, `--pill`, `--accent`). page padding 28px 32px; column `max-width: 760px`, left aligned (not centered). > 960 pane: still 760.
- vertical rhythm, top to bottom (gaps are margin-top of the block):
  1. header row (h1 `Site Time` 20px/600, -.3px) + segmented control, right-aligned on the same row. row height 32.
  2. summary block — gap 24.
  3. chart — gap 20.
  4. list — gap 24.
  5. footer (reset + note) — gap 28.

### segmented control (range)

- native-looking macOS segmented: 3 segments `Today` · `7 Days` · `All Time`. container bg `--pill`, radius 7, padding 2; segment 12px/500 text, padding 3px 10px, radius 5; selected segment bg `--card` (light: #fff, dark: #1f2021) + `--row-active-shadow`, text `--text`; unselected text `--text-dim`. transition 120ms. keyboard: ←/→ when focused; ids `seg-today`, `seg-week`, `seg-all`.
- default `7 Days` (ios default). remember last choice in `localStorage.siteTimeRange`.

### summary block

- two stats side by side, baseline aligned, gap 40:
  - **Total** — value 28px/600 tabular-nums (`font-variant-numeric: tabular-nums`), -.5px; label `Total` 12px `--text-dim` above the value (label above, value below, 4px gap).
  - **Avg / day** — same style, label `Avg / day · N days` (N from the selected range, see §1). always shown, even for Today (label `Avg / day · 1 day`, value = total).
- empty state: value `0s`, and the list shows one muted line `No time recorded yet.`

### 7-day chart

- always the last 7 days (today rightmost), regardless of range (ios). height 96. bars: flex row, gap 8, bars `width: 100%` of their slot, min-height 2px (so zero days show a hairline), radius 3 top only. bar color `--accent` at 0.9; today's bar full `--accent`; other days `--accent` at 0.55. hover bar → tooltip via `title` attribute `Mon · 1h 12m`.
- x labels under each bar: weekday initial (`M T W T F S S` order from oldest) 11px `--text-dim`, centered, gap 6 above labels. no y axis, no grid lines. a single hairline `--line` baseline under bars.
- scale: max of the 7 values; if all 0, bars are all min-height.

### rows list

- plain rows, no card. row: height 36, grid `favicon 16 | site 1fr | share 56px right | time 72px right`, column gap 12, padding 0 8, radius 6, hover bg `--row-hover`. hairline `--line` between rows (`border-top` on rows after the first, inset to content). 
- favicon: 16px, from `https://<site>/favicon.ico` via the existing favicon cache if available, else a 16px circle `--pill` with the site's first letter 10px/600.
- site text 13px `--text`, ellipsis. share `42%` 12px `--text-dim` tabular. time `1h 12m` 13px/500 `--text` tabular.
- ranked top 50 of the range; `Show all` text button (12px, `--accent`, no bg) below if more.
- click row → opens `https://<site>` in a new tab (ios tap behavior) and keeps the panel open. ids `row-<site>`.

### footer

- `Reset Site Time…` secondary button (settings-base `button`, pill, 13px). click → native confirm attached to the window: `dialog.showMessageBox(win, { type: 'warning', message: 'Reset site time?', detail: 'This deletes all recorded time on this Mac. It cannot be undone.', buttons: ['Reset', 'Cancel'], defaultId: 1, cancelId: 1 })` — a sheet on the Olive window, never a separate popup window and never an in-page card/scrim. on Reset → `reset()` then re-render (empty state). id `btn-reset`. (#423 implements; this is just the look.)
- note, 12px `--text-dim`, 12px below: `Counts only while Olive is in front and the page is visible. Stored on this Mac, never sent anywhere. Private windows are not counted.`

### test ids

`site-time-page`, `time-total`, `time-avg`, `time-chart`, `time-row-<site>`, `seg-today|week|all`, `btn-reset*` as above.

## 3. sidebar + traffic lights (#424)

- traffic lights live only in the sidebar: `trafficLightPosition` fixed at `{x: 14, y: 14}` while the sidebar shows. sidebar header reserve: top padding `44px` on `#sidebar` (lights 12px + 14 top + ~18 clearance), tab rows start below; the header strip is `-webkit-app-region: drag` (only inside the sidebar).
- sidebar hidden: the native lights are hidden (`win.setWindowButtonVisibility(false)`, #424's native-visibility approach) and the page gets the full window — nothing is drawn over the page, no 44×80 strip, no drag region over content. when the sidebar comes back, lights come back (`setWindowButtonVisibility(true)`). if hiding the buttons isn't possible in some state, the fallback is to reserve pane space (shift the page down/right so lights sit on chrome, not on page) — never an overlay on top of the page.
- hover peek stays: with the sidebar hidden, moving the mouse to the left edge still peeks the sidebar as an overlay (existing `setOverlay('peek')` path); the peeked sidebar shows the lights again at 14,14 inside it. the fix is the top hover deadzone, not removing peek: hovering the pane's top strip must reach the page (hover menus, tooltips, drag). how the ui view / native visibility is arranged is #424's call (the ui view still draws split handles, dividers etc., so don't assume it shrinks to a 4px strip) — the authoritative, testable outcome is: one app window, lights absent while hidden, no deadzone anywhere over the page. sidebar toggle `⌘S` + menu unchanged.
- sidebar row for the page: `#settings-row` already exists; title `Site Time`. the footer `Activity` button (`#btn-ledger`) now opens **Site Time** (parent decision: that is what the user expects "Activity" to mean) — same look, same spot, hidden in private. the event ledger keeps its menu item and omnibar command (`ledger`) and loses the footer button; no new footer button, no keyboard shortcut yet (`⌘⇧T` conflicts with reopen tab).

## 4. menu + omnibar (parent)

- menu: `Olive ▸ Activities — Site Time…` already at menu.js:22 → `w('activities')` → `mgr.siteTime.show(win)` (window.js:952). keep the label as is (`Activities — Site Time…`) so both keywords stay discoverable; `Activity Ledger…` stays as the separate event-log entry.
- omnibar: `APP_COMMANDS.activities` title `Activities — Site Time`, sub `Time spent per site, today / 7 days / all time`, terms `site time, time, activities, usage, screen time, sites`. icon: `clock` glyph (ICON set in ui.js). executing opens the page; the command row shows like other commands (kind `command`).

## 5. dark / light

tokens only; no hard-coded colors except reset red above. review shots (light + dark, 7-day with data, empty, confirm state, sidebar hidden) → `notes/test-shots/site-time-*.png`, reviewed by #422.

## 6. open questions (decided for now, change if cheap)

- split view counts the active pane only (parent contract) — sum never exceeds wall time.
- idle detection (no input for N min) — not in v1, ios doesn't have it.
- per-profile vs global — per profile (follows userData dir), matches ledger.

## v5 — final design verdict (2026-10-27, #422)

all reviewed shots PASS, no blockers, css frozen (src/ui/site-time.css = #423's build):

- site-time-light-populated7day-full-window.png — PASS (v4)
- site-time-dark-populated7day-full-window.png — PASS (lights in sidebar, accent bars, today bold)
- site-time-light-empty-full-window.png, site-time-dark-empty-full-window.png — PASS (0s, stub bars, "Nothing yet…", reset dimmed)
- site-time-light-sidebar-hidden-full-window.png, site-time-dark-sidebar-hidden-full-window.png — PASS (no lights, pane fills, no overlay strip)
- site-time-light-reset-sheet-full-window.png — PASS (native alert 520x634 only: "Reset all site time?", Reset Site Time / Cancel)
- sidebar-peek-{light,dark}.png — PASS (peek overlays page, lights live inside the peek, nothing at window corner)
- sidebar-hidden-{light,dark}.png — PASS (page only, no lights, no deadzone strip)

nits (not blocking, later): lights render grey/inactive in peek shots (capture focus, not design); ~40px empty band above reset footer in populated state.
