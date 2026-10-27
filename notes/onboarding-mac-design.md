# olive setup: mac-native design spec (v2)

author: fable design advisor (task #408, model id `claude-fable-5-1`). date: 2026-10-27.
spec and visual critique only, no app code. replaces the opus stand-in v1.

evidence used so far: the five `notes/test-shots/before-onboarding-*.png` and the
parent's real CUA capture `before-onboarding-full-window.png` (all viewed),
`src/ui/ui.css` (the app's real tokens), `src/main/window.js` layout
(`M = 8`, `GAP = 8`, `RADIUS = 10`, `vibrancy: 'under-window'`,
`titleBarStyle: 'hiddenInset'`), `src/main/app-panel.js`, `src/ui/app-panel.css`,
`src/ui/onboarding.{html,css}`. main-window/onboarding side-by-side pair and the
dia/arc/raycast/linear/Setup Assistant reference reads (#409) are still coming;
sections marked **(revisit)** may move after them. everything else is decided.

user, verbatim: "the onboarding of olive looks very ugly and webby - and not maccy
- like rest of the app"; "the onboarding still like a webpage :( figure out the
right model"; "anyone looking at it visually ... would be able to tell that it
sucks and doesnt blend at all with rest of the app".

---

## 0. the model, in one paragraph

setup is **a page in olive, not a dialog about olive.** it renders in the exact
rect a tab's page gets (`x = sidebarWidth, y = 8, radius 10`, same `--card`
fill and `--card-shadow`), and it has **a row in the sidebar** ("Set Up Olive",
olive glyph, active style) like any tab. the sidebar stays live; ⌘T opens a tab
next to it; closing the row = Set Up Later; clicking the row later resumes.
inside the card the content is laid out like a **macOS Setup Assistant pane**:
a 420pt column, 22pt bold SF title, 13pt body, symbol rows, and two capsule
buttons pinned bottom-right ("Set Up Later" / "Continue"). no wordmark, no
eyebrow, no serif, no stepper, no boxed cards, no sticky footer, no cream, no
forced light mode. every other popup (profiles, shortcuts, activity, site
permissions, capture picker) becomes an **in-window panel styled exactly like
the command palette** (`--palette-bg`, radius 16, hairline, palette shadow) that
dims only the content area, never the sidebar.

---

## 1. why the current one reads as a web page (from the before shots)

| what i see | why it's foreign | fix |
|---|---|---|
| system-dark title bar ("Welcome to Olive") over a forced cream body `#f7f6f1` | the mac is in Dark; the body ignores it. two appearances in one window is the single loudest tell | follow `prefers-color-scheme`; use `--card` / `--text` from `ui.css` |
| "olive" Georgia 28px wordmark + "Default" + "Set up later" link in a bordered header | marketing site masthead | no header. the sidebar already says which profile you're in |
| numbered stepper "1 Welcome · 2 Calls · 3 Screen sharing · 4 Import · 5 Ready" | checkout wizard | 5 dots, 6px, bottom-centre |
| 10px uppercase tracked eyebrow ("A LITTLE SETUP. THEN MAKE YOURSELF AT HOME.") | web editorial device; macOS never does this | delete |
| Georgia 43px two-line hero headline | landing page | SF 22/600, one line |
| 15px/1.55 body, 2-sentence paragraphs | blog measure | 13px/1.4, one sentence |
| rounded bordered "cards" with h2 + paragraph, 24px padding | bootstrap panels | symbol rows (icon + bold label + grey line), no box |
| two filled green buttons per screen ("Yes, set up calls" + footer "Continue"), plus "Not now" text links | two primaries, three ways to leave | one default button, one secondary, both capsules, bottom-right |
| sticky footer with border-top, "2 of 5", Back text link | web form footer | back chevron icon button top-left (28px, same as sidebar `button.icon`) |
| import step is a tall scrolling page (1420×3050 shot) with "Find browser profiles" button, fieldsets, disabled checkboxes, a keychain checkbox | form | auto-scan on entry, inset list, one footnote, no consent checkbox |
| content width ~1250px at 1420 shot | fills the window edge to edge like a document | 420pt column, centred |

---

## 2. container: setup is a tab-shaped page

### 2.1 geometry (exact)

- the setup `WebContentsView` gets the pane rect from `layout()` exactly as a
  single tab would: `{ x: sidebarWidth, y: M (+FIND_H if find open), width: w - sidebarWidth - M, height: h - 2M }`,
  `setBorderRadius(RADIUS = 10)`. the ui view draws its normal `.card` div under
  it so the shadow is identical to a page card. **not** `AppPanel`, not centred,
  no scrim, no 38px header, no ×.
- sidebar hidden → `x = M` like pages.
- if tabs exist, the setup page is one of the visible panes (never split with a
  page; splitting it is a no-op).
- never scrolls at 1280×800 and above. below ~560pt card height the column top
  padding shrinks (see 3.1); below 460 the footnote hides. no scrollbars ever.

### 2.2 the sidebar row (the same row pattern every page uses, see 5.3)

- a row in `#tablist` above pinned/normal tabs, same `.row` metrics (36px, radius 9):
  fav = the olive glyph (16px version of `.logo`'s radial gradient), title
  "Set Up Olive", trailing "2 left" in 11px `--text-dim` once steps are
  skipped. active style while the setup page is showing.
- hover × on the row = Set Up Later (same as the button).
- it is not a tab: no url, not in session restore as a tab, not pinnable,
  not draggable. it's gone after Start Browsing; it comes back only from
  Olive ▸ Set Up Olive… (menu item under the app menu, above Settings).
- legacy profiles (`isLegacy`) never get the row or the page. unchanged `dj`.

### 2.3 surface

- fill: `--card` (`#fff` light / `#1f2021` dark). text: `--text`, `--text-dim`.
  accent: `--accent` (`#5d7d3c` / `#a8cf7b`). lines: `--line`. list fill:
  `--pill`. selected: `--palette-sel`. **import these from `ui.css`**; do not
  redeclare colours in `onboarding.css`. private windows never show setup.
- `color-scheme: light dark`. no `color-scheme: light`.
- it's an opaque page surface on purpose: pages are opaque in olive. the
  vibrancy lives in the sidebar (`#bg` 0.86–0.9 alpha over `under-window`), and
  that stays visible beside it. that contrast *is* the app's look.

---

## 3. the pane: layout and type

### 3.1 column

- width 420, horizontally centred in the card. top of column at
  `max(48px, calc(18% - 20px))` of the card height; the same for all five steps
  so the title never jumps between steps.
- vertical rhythm (top to bottom): glyph 40 → 16 → title → 6 → intro → 22 →
  rows (row = 28 tall text block + 10 gap) → 18 → footnote.
- back chevron: `button.icon` 28×28 at card inset 14/14 (top-left), only on
  steps 2–4. ⌘[ also goes back.
- buttons: pinned bottom-right, inset 20 bottom / 24 right, gap 8. order:
  secondary then default (macOS order, default rightmost).
- dots: bottom-centre, 6px, gap 7, bottom inset 26; active `--accent`, others
  `--line`; `aria-label="Step 2 of 5"`.

### 3.2 type (SF only, `-apple-system`)

| role | size/weight/line | colour | tracking |
|---|---|---|---|
| title | 22/600/28 | `--text` | -0.3px |
| intro | 13/400/18 | `--text` | 0 |
| row label | 13/600/17 | `--text` | 0 |
| row description | 12/400/16 | `--text-dim` | 0 |
| footnote / disclosure | 11/400/15 | `--text-dim` | 0 |
| status value (trailing) | 12/500 | `--text-dim`; `--accent` when granted/done | 0 |
| button | 13/600 | see 3.4 | 0 |
| kbd (done screen) | existing `kbd` rule from ui.css | | |

nothing larger than 22. nothing lighter than 400. no uppercase, no letter-spacing
above 0, no serif anywhere (grep for `Georgia`/`serif` must be empty).

### 3.3 glyph and rows

- step glyph: 40×40, radius 12, fill `--palette-sel`, 20px line icon in
  `--accent` (same stroke style as the sidebar svg icons: 1.6–1.8 stroke, round
  caps). welcome uses the olive `.logo` gradient at 40×40 radius 12 instead.
- symbol row: 24px icon column (icon 16, `--accent`), gap 12, then label on
  line 1 and description on line 2. optional trailing status text or a small
  secondary button, right-aligned, vertically centred on the label line.
- rows are not boxed. the import list is the one exception (3.5).

### 3.4 controls (html drawn to macOS metrics; honest about it)

electron can't host `NSButton`/`NSSwitch` inside a `WebContentsView`. so: draw
them to macOS Tahoe metrics and use real native pieces where they exist
(`dialog.showMessageBox(win)` = real attached sheet, `systemPreferences.askForMediaAccess`
= real alerts, `Menu.popup` = real menus, `shell.openExternal('x-apple.systempreferences:…')`).

- capsule button: height 28, padding 0 16, radius 14, min-width 88, 13/600.
  default: fill `--accent`, text `#fff` light / `#1d2a1f` dark. secondary: fill
  `--pill`, hover `--pill-hover`, text `--text`. disabled: opacity .4.
  pressed: `filter: brightness(.92)`. focus ring: `outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px`.
  return key = default; esc = Set Up Later (steps 1–4), Start Browsing (done).
- small inline button (row trailing, e.g. "Open System Settings…"): height 22,
  padding 0 10, radius 11, 12/500, secondary style.
- checkbox (import rows): 14×14, radius 3.5, 1px `--line` border, checked =
  `--accent` fill with white 10px check. no html default checkbox.
- switch: only if a step gets one (none planned). if ever: 26×15 track,
  13px knob, `--accent` on, `--line` off, as in System Settings rows.
- spinner: the existing sidebar `.row .spinner` (14px) reused as-is.
- no links styled as buttons, no text-only "Not now". every action is a capsule
  or the back chevron.

### 3.5 inset list (import only)

- container: fill `--pill`, radius 10, no border. rows 36px, padding 0 10,
  hairline `--line` between rows (inset 10 from the left of the text).
- row: 16px browser icon → "Chrome" 13/500 + "Default · 2 sign-ins" 12 `--text-dim`
  → trailing checkbox (or spinner / "14 sites" / "Needs sign-in" while and after
  import).
- max 5 rows visible; more scroll inside the list only.

### 3.6 motion (restrained)

- step change: outgoing column fades out 90ms; incoming fades in 140ms with a
  6px translateY from the direction of travel. buttons and dots don't move.
- the setup page itself has no entrance animation; it's a page.
- status changes (Not requested → Allowed) crossfade 120ms; no bounce.
- `prefers-reduced-motion`: all of the above become instant.

---

## 4. the five steps (final copy, final controls)

button titles are Title Case like macOS; everything else sentence case.
"Continue" always means "do the thing this step is about, then go on". "Skip"
goes on without doing it. "Set Up Later" closes the page, keeps the row.

### 4.1 welcome

- glyph: olive logo.
- title: **Welcome to Olive**
- intro: Olive keeps your browsing on this Mac. A few optional steps and you're set.
- rows:
  1. house icon — **Stays on this Mac** — Tabs, history, imports and site choices are stored locally. No Olive account or cloud.
  2. shield icon — **Ads are blocked by default** — uBO Lite basic network blocking is on. Cosmetic filtering and per-site modes aren't supported yet; turn blocking off from the shield button.
  3. hand icon — **Permissions only when you need them** — Olive asks macOS for the microphone, camera or screen only when you choose to set them up.
- footnote: Sites and your search engine still see what you send them.
- buttons: [Set Up Later] [Continue]. no back chevron.
- the uBO row's description is driven by the real status: if the ruleset failed
  to load, label becomes "Ad blocking isn't on" with description "uBO Lite
  couldn't load its rules. Try again from the shield button." never claim more
  than basic network blocking.

### 4.2 calls

- glyph: video camera icon.
- title: **Calls**
- intro: Sites like Meet and Zoom can use your microphone and camera once macOS allows Olive to.
- rows (status rows, trailing value):
  1. mic icon — **Microphone** — Not requested / Allowed / Not allowed
  2. camera icon — **Camera** — Not requested / Allowed / Not allowed
  when "Not allowed", a small trailing button "Open System Settings…" replaces the value.
- footnote (the consent sentence; this is the only disclosure): Next, macOS asks about your microphone, then your camera. Each site still asks you separately.
- buttons: [Skip] [Continue]. Continue calls `askForMediaAccess('microphone')`
  then `('camera')` straight away — no second confirmation box, no "Yes, set up
  calls". when both prompts are answered the rows update and the default button
  becomes [Continue] again (now meaning next step); its label never changes,
  so the user just presses return twice.
- if both already granted on entry: step is skipped (existing rule).

### 4.3 screen sharing

- glyph: screen with cursor icon.
- title: **Screen Sharing**
- intro: Share a window or your whole screen in calls. You choose what to share each time a site asks.
- row: display icon — **Screen & System Audio Recording** — Not allowed / Allowed / Waiting for System Settings…
- footnote before request: Next, macOS opens System Settings. Turn on Olive under Screen & System Audio Recording, then come back here. Olive has to quit and reopen once.
- buttons: [Skip] [Continue]. Continue triggers the request + opens System
  Settings (one click, as today's inner "Request access & open settings" did).
- after request: row value "Waiting for System Settings…"; footnote becomes
  "When Olive is turned on in System Settings, quit and reopen. Setup continues
  at Import."; buttons become [Skip] [Quit and Reopen Olive…].
- "Quit and Reopen Olive…" opens a **real native sheet** via
  `dialog.showMessageBox(win, { type: 'none', message: 'Quit and reopen Olive?', detail: 'Your tabs are saved. Setup continues at Import.', buttons: ['Quit and Reopen', 'Cancel'], defaultId: 0, cancelId: 1 })`.
  that's the one restart consent and it's the mac one.
- the `app-path` line ("/Applications/Olive.app") goes away; System Settings
  lists the app itself.

### 4.4 import

- glyph: arrow-into-tray icon.
- title: **Import from Another Browser**
- intro: Copy signed-in sessions so you can start where you left off.
- scan runs on entering the step (no "Find browser profiles" button); while
  scanning the list shows one row with a spinner "Looking for browsers…".
- inset list (3.5) of found profiles, each with a checkbox, all unchecked.
- empty state (no list): row with a grey browser icon — "No Chrome, Brave, Edge
  or Arc profiles found." — buttons [Skip] [Continue].
- footnote (one paragraph, this replaces the warning box and the checkbox):
  Copies cookies and signed-in sessions only, not passwords, history or
  bookmarks. macOS may ask for your login password to unlock the browser's
  Keychain item; Olive uses it on this Mac only. Your other browser isn't
  changed. Some sites will still ask you to sign in again.
- buttons: [Skip] [Import]. Import is the default, disabled until ≥1 row is
  checked. during import: checkboxes become spinners, button disabled; after:
  trailing values "14 sites" / "Needs sign-in" / "Skipped (Keychain)", and the
  default button reads [Continue].
- existing olive cookies are kept; session captured at step entry so a profile
  switch can't redirect (keep from `onboarding.js`).

### 4.5 done

- glyph: checkmark circle (`--accent`).
- title: **You're Ready**
- intro: none.
- rows (summary, trailing values):
  1. **Calls** — Allowed / Skipped / Not allowed
  2. **Screen sharing** — Allowed / Skipped / Waiting for System Settings
  3. **Import** — 2 profiles, 40 sites / Skipped
  4. **Ad blocking** — uBO Lite basic, on
- footnote: Change any of these later from the shield, the lock in the address
  bar, or Olive ▸ Set Up Olive…
- buttons: [Start Browsing] only. it removes the page and row and opens the
  new-tab palette (same as ⌘T) so the user lands in the real browser.

### 4.6 states that apply to every step

- "Set Up Later" / row × / Esc: page closes, row stays with "N left", state saved
  (`onboarding.json` as today). nothing auto-reopens on next launch except after
  the screen-recording relaunch, which reopens at Import.
- error (ipc failure, scan failure): a single 12px `--text-dim` line under the
  footnote with a leading ⚠ in `#c0392b` (the sidebar's crash colour), never an
  alert box, never red fills.
- profile switched mid-setup: page closes; existing toast "Setup paused."
- the setup page never shows more than one default button, never shows
  Back + Skip + Continue + Set Up Later together (back is the chevron, Set Up
  Later is the row × / Esc on steps 2–5).

---

## 5. every other surface: an inline page in the pane (v3, 2026-10-27 21:xx)

**the user rejected the floating card, even embedded.** quote: "browser still
completely broken... no popup ffs... native feeling". so v2's palette-shaped
panel (scrim, shadow, radius 16, centred) is dead. this section replaces it.
nothing floats. nothing dims. nothing is "over" a page.

### 5.1 the one rule

settings, profiles, keyboard shortcuts, activity, site permissions, setup
(section 2) and the uBO summary are **pages**. a page lives in the pane rect
exactly where a web page lives, and shows in the sidebar as a row exactly
like a tab. that's what chrome/arc/dia do with `chrome://settings`,
`arc://settings`; it's the one model a browser user already knows and it
never looks like a dialog. keep `AppPanel` as the class name if you like, but
its geometry is `layout()`'s pane rect and it has no shell html at all.

### 5.2 geometry (exact)

- bounds = the pane rect of a single tab from `layout()`:
  `{ x: sidebarWidth, y: M (+FIND_H if find open), w: w - sidebarWidth - M, h: h - 2M }`,
  `setBorderRadius(RADIUS)`. with the sidebar hidden, `x = M`.
- the ui view draws its normal `.card` under it (same `--card-shadow`), so a
  page and a web page are pixel-identical from the outside.
- **no** scrim, no shell view, no second shadow, no border, no header bar,
  no ×, no "done" button. closing is ⌘W, the row's hover ×, or the back
  arrow if the page was opened from a tab (see 5.4). Esc does nothing (it's a
  page, not a dialog).
- it never splits. "split with new tab" on a page is a no-op.
- transition: none. pages switch like tabs switch (instant). the only motion
  allowed is the sidebar row's selection moving, which it already does.

### 5.3 the sidebar rows

- each open page is a row in `#tablist`, same `.row` metrics (36px, radius 9),
  fav = a 16px SF-style glyph drawn in `--text-dim` (gear for Settings, olive
  mark for Set Up Olive, clock for Activity), title in `--text`. hover × closes.
- one instance per kind (opening Settings again selects the existing row).
- not persisted in session restore, not pinnable, not draggable, no url text
  in the url bar: the url bar shows the title ("Settings") as a plain label,
  `--text-dim`, not editable, no lock glyph. reload/back/forward disabled
  while a page is active except back when opened from a tab (5.4).
- the row sits under pinned tabs, above normal tabs, in open order. that's
  the arc behaviour and it keeps pages near the top without a new section.

### 5.4 settings is one page with a source list, not five pages

the mac model is System Settings: one window, a source list on the left,
one group of settings on the right. do that inside the pane:

- `olive://settings` (internal id; never shown). pane splits into a
  **source list** 200px wide, fill `--bg2` at 0.5 alpha over `--card` (reads as
  a slightly tinted strip, no vibrancy needed), 1px `--line` on its right; and
  **content** filling the rest, fill `--card`.
- source list rows: 28px, radius 6, 13px `--text`, 16px glyph before, 10px
  inset, selected = `--palette-sel` fill. items, in this order:
  General · Profiles · Site Permissions · Keyboard Shortcuts · Activity · Blocking.
  no search field for now (6 items).
- content: title 20/600 `--text` at 28/32 (top/left), then groups. a **group**
  is an inset rounded list like System Settings: radius 10, fill `--pill`,
  rows 40px (44 with a subtitle), 1px `--line` separators inset 12px, label
  13 `--text` left, control right, optional 12 `--text-dim` subtitle under the
  label. group header 13/600 `--text` 8px above the group, 20px between groups.
  content column max 640px, left aligned to the title, no centring.
- the first open lands on General; ⌘, opens Settings; the app menu's
  Profiles…, Keyboard Shortcuts…, Activity… items open Settings on that
  section (one row, not three). the sidebar profile badge keeps its
  `Menu.popup` quick switch and adds "Manage Profiles…" → Settings ▸ Profiles.
- things that open Settings from a tab (shield pill → Blocking, site
  permission card → Site Permissions) push the page in the **same** pane
  with the back arrow enabled, so the user returns to the site with one
  click, like arc does for its site settings.

### 5.5 controls (html, drawn to macOS metrics; same as 3.4)

| control | spec |
|---|---|
| switch | 38×22 capsule, `--pill-hover` off / `--accent` on, 18px white knob, `transition .15s`. use for every on/off ("Record activity", "Block ads"). no checkboxes. |
| pop-up button | `<select>` with `appearance: none`, h26, radius 6, fill `--pill`, 13px `--text`, chevron.up.chevron.down glyph right at 8px. no native dropdown chrome. |
| text field | h26, radius 6, 1px `--line`, fill `--card`, 13px, focus ring `0 0 0 3px color-mix(--accent 35%)`. |
| push button | capsule h26 (secondary `--pill` fill, 13/500 `--text`); primary `--accent` fill, white text. **max one primary visible per page section.** never a row of four capsules. |
| segmented | capsule track `--pill`, h26, selected segment `--card` fill + `--card-shadow`, 12/500. |
| table | `--card` fill, header row 28px 12/600 `--text-dim` with a 1px `--line` under it (**not** a white bar), rows 32px, zebra `--pill` at 50%, monospace only for ids. |
| destructive | plain capsule, text `--danger` (`#c2452d` light / `#f08a7a` dark; add the token to `ui.css`). confirm via `dialog.showMessageBox` **attached to the window** (that's a native sheet, and it's the only sheet we have). |
| kbd | `kbd` from ui.css: glyphs ⌘ ⇧ ⌥ ⌃ ⇥ ⌫ ↑ ↓ ← →, 12px `--pill` fill radius 4. **never** the strings "Cmd+Shift+T". |

### 5.6 per section (what's on the right)

- **General**: group "Appearance": Sidebar width (pop-up: Narrow/Default/Wide);
  group "On launch": Set Up Olive… (secondary button, only if setup has
  pending steps; otherwise "Set up complete" `--text-dim`); group "About":
  version, Check for Updates… .
- **Profiles**: one inset list of profiles: colour dot 10px, name, trailing
  "Current" 11px `--text-dim` on the active one. double-click = inline rename
  (field in place, Enter commits, Esc cancels). under the list a 26px bar with
  **+ −** icon buttons left (System Settings style, inside the group's
  bottom edge) and a secondary "Switch to" button right, enabled when a
  non-current row is selected. footnote 12 `--text-dim`:
  "Switching saves your tabs. Private windows close when you switch."
  no "Create profile" form, no "rename" button, no "done".
- **Site Permissions**: search field top-right of the title row; inset list,
  one row per origin (favicon, origin), trailing three pop-ups Camera /
  Microphone / Screen (Ask · Allow · Block) in 12px; group "Defaults" above
  with the same three pop-ups; "Reset All…" secondary bottom-left of the list.
- **Keyboard Shortcuts**: one group per area (Tabs · Navigation · View ·
  Find · Window · Developer), rows 32px: action left, a **recorder** right:
  a 26px capsule showing the `kbd` glyphs; click it → it shows "Type
  shortcut…" and records on key release; ⌫ clears; conflict shows 12px
  `--danger` text under the row ("Used by Next Recently Used Tab") and keeps
  the old binding. **no per-row save button** (34 of them is what the
  shortcuts shot shows; it's the single most web thing on that page). one
  "Reset All to Defaults…" secondary button under the last group.
  the intro copy shrinks to one 12px `--text-dim` line:
  "Click a shortcut to change it. Press ⌫ to clear."
  the recently-used-tabs paragraph becomes a subtitle under those two rows.
- **Activity**: title row with a search field (240px) right; under it a
  26px toolbar: segmented Today · 7 Days · 30 Days · All, pop-up "All
  Events", nothing else (no From/Through date inputs, no Refresh). group
  "Recording" above the table: switch "Record activity" + pop-up "Keep for"
  (30/90/365 days) in one row. table fills the remaining height, scrolls
  inside, columns Time (140) · Event (100) · Details (rest). under the table
  a 26px bar: left "1 matching" 12px `--text-dim`; right one secondary
  pop-up button "Export…" (JSON / CSV) and one plain `--danger` "Delete…"
  (opens a native sheet with "Delete 1 matching event" / "Clear Ledger"
  choices). the privacy paragraph becomes a 12px subtitle under the group
  header, two lines max.
- **Blocking**: group with switch "Block ads and trackers (uBO Lite)",
  subtitle "Built in. Native rules, no extension process."; a row "Rules"
  with the count `--text-dim`; row "Open uBO Lite Dashboard" chevron →
  opens the dashboard **as a web tab**. the per-site basic-rules popup in
  `extensions.js` (`new BrowserWindow` 370×345) is removed; the shield pill's
  click goes to Settings ▸ Blocking in the same pane (5.4) with the current
  site preselected in a "This site" row (switch, per-origin).
- **capture picker** (screen share): stays as it is architecturally only if
  it's already a native `systemPreferences`/`desktopCapturer` prompt; if it's
  our html, it becomes a page too, pushed in the same pane as the requesting
  tab with back enabled, [Cancel] secondary / [Share] primary bottom-right.
  **revisit** only this one.

### 5.7 the main window chrome: three fixes seen in `main-app-full-window.png`

1. `uBO Lite · on` pill is unreadable: pale text on a pale `--pill`. it's also
   the wrong place (bottom of the sidebar is for the footer only). drop the
   pill; put a 16px shield glyph button in the topbar right of the url bar
   (`button.icon`, `--accent` when on, `--text-dim` when off) with a tooltip
   "Blocking on · 12 blocked". clicking opens Settings ▸ Blocking (5.4).
2. the footer line `Activity ● api :19333 · cdp :19222 ‹ ›` is debug output
   in the product and it clips. hide it unless `OLIVE_DEBUG` is set; in
   product the footer is `Activity` as a 12px `--text-dim` text button alone
   (opens Settings ▸ Activity) plus the profile badge. nothing that can wrap.
3. the `‹ ›` are clipped by `.footer {flex-wrap:wrap}` — with 2 fixed they
   go away; don't ship wrapping footers.

### 5.8 dark mode is broken on every embedded page (profiles/ledger/shortcuts shots)

in all three 20:54–21:00 shots the body text, headings and footnotes are
near-invisible: dark olive ink (`#26382f`-ish) on `#1f2021`. the page css is
still carrying onboarding's light-only ink colours. this is not a polish
item; it fails the first acceptance rule. fix: every page imports
`ui.css` tokens and uses `--text` / `--text-dim` / `--line` only; grep the
page css for any literal `#` colour and delete it. then a 1-line test: for
every visible text node, computed `color` vs the nearest opaque background
has contrast ≥ 4.5:1 in both appearances. put that in the screenshot script
so it can't regress silently (the user asked for cause/tests process: this
is the test).

---

## 6. acceptance (visual, not tests)

1. a screenshot of the main window with setup open looks like one app: dark
   sidebar vibrancy + dark card, or light + light. no cream, no two appearances.
2. computed `font-family` on every setup element starts with `-apple-system`;
   no element over 22px; no uppercase.
3. exactly one accent-filled button per state, bottom-right.
4. every step fits in a 1280×800 window with no scrollbar (check import with
   4 profiles and the done step).
5. the setup appears in the sidebar as a row and the window shows it where a
   page would be, with the page card shadow.
6. calls/screen: one click from the step to the macOS prompt / System Settings;
   the only extra consent is the native quit-and-reopen sheet.
7. import: no keychain checkbox; auto-scan; results per row.
8. settings/profiles/shortcuts/activity/permissions are one Settings page in
   the pane with a sidebar row; nothing floats, nothing dims, no done button,
   no header bar. a screenshot with Settings open is indistinguishable in
   chrome from one with a web page open.
8b. every text node on every page passes 4.5:1 contrast in light and dark
   (5.8); no literal `#` colours in page css; no "Cmd+" strings; no html date
   inputs; no unstyled `<select>`.
9. after shots: `notes/test-shots/after-onboarding-{welcome,calls,screen,import,done}-{light,dark}.png`
   as real CUA window captures at the same size as `before-onboarding-full-window.png`,
   plus `after-main-window-{light,dark}.png` for the side-by-side. i'll judge
   those, not test output.

---

## 7. open (revisit after the main pair and #409 refs)

1. column top offset (18%) vs Setup Assistant's exact centring — i'll tune
   after seeing the real card height in the pair.
2. whether the welcome glyph should be the olive logo or no glyph at all
   (Setup Assistant has one; Dia doesn't).
3. the sidebar footer overflow and the "uBO Lite · on" pill contrast in dark
   mode: not onboarding, but they'll be in every after shot. flag for the
   parent; i'd fix the pill to `--palette-sel` fill + `--accent` text.

---

## 8. reference read: dia (notes/test-shots/references/dia-home.png, 2026-10-27)

the one usable ref from #409. it's the marketing hero, but the embedded app
mockup is a real product shot (sidebar + new-tab page). what it confirms and
what it corrects in v2 — nothing structural changes:

1. **the page is the hero, not the chrome.** dia's new tab is a flat, slightly
   warm page with one glyph (small, ~60pt, centred, about 38% down), one
   control, nothing else. no headline on the page at all. keeps v2's "one
   column, one primary" rule; corrects open item 7.2: **keep a glyph** on
   welcome (olive mark, 56pt, `--accent`, no gradient halo), drop it on
   every other step.
2. **tone of the page vs sidebar.** sidebar and page are the same hue family,
   the page one step lighter; no border between them, only the page's rounded
   corner (dia r≈12, ours RADIUS 10 — keep ours). the before shot's cream on a
   dark sidebar is exactly the mismatch dia avoids. so: setup page fill is
   `--card` (light: ~#fbfbfa / dark: #1f2021), never a third colour.
3. **controls are capsules, grey-on-page, one dark primary.** dia's "ask
   anything" field is a white rounded rect r≈18 with a hairline shadow;
   "Add tabs or files" is a 36px-high grey capsule, mic is bare, the submit
   is a filled circle. the site CTA is a black capsule. so v2's capsule h28
   secondary + accent-filled primary stands; add: **secondary buttons get
   `--pill` fill, no border**, not outlined. outlined buttons read web.
4. **sidebar rows.** 13px SF, icon 16pt at left, 8pt gap, row h≈32, generous
   left inset (~12pt), bold for folders. "+ New Tab" is a plain row with a
   dimmed `+`. our "Set Up Olive" row should look exactly like this: a row,
   not a pill, not a card. progress ("2 of 5") as a dimmed trailing label,
   same colour as the `+`.
5. **top bar.** 46px, traffic lights, sidebar toggle, back/forward/reload as
   bare 16pt glyphs, no url field shown on new tab. ours already matches;
   nothing to do.
6. **what not to copy.** the serif headline, the saturated yellow backdrop,
   the blur texture — that's the website, not the app. same lesson as the
   before shot: marketing serif in an app pane reads webby.

changes to v2 from this read (small):

- 3.3: welcome glyph = olive mark 56pt, flat accent; no glyph on steps 2–5.
- 3.4: secondary buttons = `--pill` fill, 0 border; primary = `--accent` fill,
  white text; both capsule h28, 13px medium.
- 2.2: sidebar row trailing "n of 5" in `--muted`, 12px, right-aligned.
- 3.1: column top: welcome glyph top at 30% of pane height (dia ~38% but we
  have a heading below it); steps 2–5 heading top at 22%.

## 9. after review (fable, 27 oct 21:2x) — main + settings full-window captures

reviewed: main-{light,dark}-after.png, settings-{profiles,ledger,shortcuts}-{light,dark}-full-window.png (all 2720x1760).

verdict: PASS on the hard checks. no floating shell, no scrim, no Done/Save rows, no debug footer, no clipped < >, uBO pill readable in both modes, every page reads as the same app as the main window (same sidebar, same pane radius, --card fill, SF 13px body, light/dark both correct). ship-blocking issues: none.

polish (not blockers, do in one pass):
1. casing is inconsistent across pages and the sidebar rows: "Profiles" / "activity ledger" / "Keyboard Shortcuts"; rows "profiles" / "activity ledger" / "Keyboard Shortcuts" / "Set Up Olive". pick Title Case for page titles and sidebar rows (matches "Set Up Olive", "New Tab"); keep body copy sentence case.
2. settings sidebar rows use a tiny dot glyph while "Set Up Olive" has the olive mark; give each settings row a 16px SF-style glyph (person.2 / list.bullet.rectangle / keyboard) or no glyph at all, not a dot.
3. shortcuts: literal "Cmd+Shift+T" -> glyphs "⇧⌘T" (#400 doing); help copy still says "then save" though save is gone -> "click a shortcut, press the new keys. backspace clears it. changes apply immediately."
4. ledger: "delete matching" and "clear ledger" look identical to "export json/csv". keep the pill but set text color to the destructive red token; confirm via native dialog before clearing.
5. profiles: "current" reads like a button but is a state -> muted label without hover; "rename"/"switch" should get the --pill fill like "create profile" so plain text isn't an invisible button.
6. shortcuts body ("recently used tabs default to ...") is 3 lines of dense help at the top; move it under the two recent-tab rows or behind a "?" so the list starts higher.

onboarding after-shots still pending (#403); same checks apply (sec 6).
