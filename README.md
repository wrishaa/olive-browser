# olive (mac browser)

an arc-style browser for mac: vertical tabs in a sidebar, a command-bar new tab,
split view, docked chrome devtools, persistent sessions, and a first-class agent
interface (chrome devtools protocol + a small http api).

engine: chromium via electron 44 (no chromium fork, no chromium build).
why: see `~/Work/hive/notes/olive-browser-spec.md`.

## run it

```sh
open ~/Applications/Olive.app          # installed build (profile: ~/Library/Application Support/Olive)
cd ~/Work/olive-browser-mac && npm start   # from source (same profile)
npm run dev                            # from source, separate "dev" profile (Olive-dev)
npm run package                        # rebuild + reinstall ~/Applications/Olive.app
```

make it the default browser: menu **Olive → Set as Default Browser…** (use the
installed app, not `npm start`).

## what's in v0.1

- sidebar with vertical tabs: pinned section on top, today's tabs below, drag to
  reorder, drag into/out of pinned, middle-click or ⌘W to close, right-click menu
- pinned tabs unload on ⌘W instead of disappearing (like arc)
- ⌘T opens a command bar: search, urls, open tabs ("switch to tab"), history,
  inline host completion; ⇧↵ opens the result in split view
- ⌘L edits the current url in the same bar
- split view: ⌃⇧= (split with a new tab), ⌘-click a tab, drag a tab onto the page,
  or right-click → open in split view. drag the divider to resize. up to 4 panes.
- devtools docked inside the window next to the page (⌥⌘I, right-click → inspect).
  elements, console, network, sources, performance: it's the real chrome devtools.
- sessions persist: cookies/localStorage/indexeddb (partition `persist:olive`),
  open tabs, pinned tabs, splits, sidebar width, window bounds
- history (used by the command bar), downloads (sidebar, dock bounce), find in
  page (⌘F / ⌘G), zoom (⌘+/⌘-/⌘0, pinch), reopen closed tab (⌘⇧T)
- private windows (⌘⇧N): in-memory session, no history
- sidebar toggle ⌘S, hover the left edge to peek it
- permission prompts (camera, mic, location, notifications, …) remembered per site
- chrome UA generally; honest Electron UA for Google sign-in (measured through the password step, no passwords entered)

## for agents

see [AGENTS.md](AGENTS.md). short version: CDP at `http://127.0.0.1:9222`,
olive api at `http://127.0.0.1:9333`, both written to
`~/Library/Application Support/Olive/agent.json`; the api needs the bearer token
from `agent-token` in the same folder (0600), see AGENTS.md. `node bin/olive.mjs tabs`.

## layout

```
src/core/      engine-agnostic: url parsing, history, json store
src/main/      electron shell: app + windows + tabs (window.js), menu, agent api
src/ui/        the chrome ui (sidebar, command bar, find bar) - plain html/css/js
bin/olive.mjs  cli for the agent api
scripts/       package, dev restart, cdp smoke test, memory, icon
```

## not yet

passwords / autofill (chromium's password manager isn't in electron: plan is
keychain + our own fill), extensions (electron has partial chrome.* support),
bookmarks ui (pinned tabs cover it for now), Safari/Firefox import, auto-update,
and notarization. Local profiles, configurable shortcuts and Chromium cookie import
are implemented; the current inline setup/settings revision is not installed yet.

## import your Arc session

Olive → **Import from Arc…** opens the native profile picker (names come from
Arc’s `Local State`). Choose the profile you want, then **Quit Arc and Import**.
Only that profile’s cookie database is copied; Arc’s files are never edited.
macOS may ask to access the single **Arc Safe Storage** keychain item. Approve
that locally; never paste a keychain password into chat.

Cookie values are decrypted in memory and set through Chromium’s cookie API.
Domain/host-only, path, secure, HttpOnly, SameSite and expiry are preserved.
Expired and unsupported partitioned cookies are skipped. Matching Olive cookies
are replaced. This is a **merge**, not an undoable profile swap.

Passwords are skipped (Olive has no password manager). Local storage and IndexedDB
are skipped rather than copying incompatible/shared LevelDB stores. Sites using
those stores, bound sessions, or rejected cookies may need a fresh sign-in.
Temporary database copies are deleted on completion/cancellation. An aggregate,
credential-free `arc-import-report.json` is saved in Olive’s application support
directory (0600). It contains counts and failed domain names, never values/keys.

Tests: `node scripts/arc-import-test.cjs` (synthetic crypto/flags only), and
`node scripts/arc-login-check.mjs` (opens GitHub, Google and X in Olive; reports
only whether signed-in account UI is visible, never account names or secrets).

Page-input regression: `OLIVE_PROFILE=dev node scripts/ui-test.mjs` also scrolls
and clicks a real Wikipedia page, and checks UI drag rectangles never cover page
panes (CDP alone bypasses native window hit-testing). On macOS a full-window
`-webkit-app-region: drag` in the background can swallow native page input even
when a sibling WebContentsView is visibly above it. Keep dragging sidebar-only.

### site permissions

Mic/camera, notifications, location, clipboard and other permission requests use persistent, bottom-left stacked cards, not modal alerts. The rest of the page remains clickable and scrollable. Each card names the requesting origin and waits for **Allow**, **Allow once**, or **Block**. Allow once lasts for the current visit (until reload/navigation); other choices are remembered per origin (private choices stay in memory); pending requests are denied if their tab navigates or closes. Click the site-settings/lock button beside the address to see and change Microphone, Camera, Screen sharing, Notifications, Location, and other permissions. Choose Ask to clear a saved choice, then reload. **Olive → Reset Permissions for This Site** also clears the site choices. macOS's own first-use hardware/privacy dialogs are separate. Olive explicitly requests microphone/camera access after site consent. If macOS denies access, site settings shows the OS status and links to the right System Settings pane. The app bundle includes microphone/camera usage descriptions. Local ad-hoc rebuilds can trigger fresh macOS approval. Screen sharing always requires selecting a particular screen/window after site consent; no automatic whole-screen grant. Enable Olive in macOS Screen Recording first if blocked; macOS may require a relaunch. System audio sharing is not implemented.

Try `https://permission.site/` → Notifications and Microphone. `OLIVE_PROFILE=dev node scripts/ui-test.mjs` exercises these real APIs, stacking, input while pending, saved decisions and navigation/close cleanup. Passwords are deferred; basic uBO Lite network blocking is available (limits below).

### ublock origin lite spike

only uBO Lite is enabled; chatgpt/claude extensions are deferred.

- package: real CWS `ddkjiahejlhfcafbddmgiahcphecmpfh`, version `2026.1012.1545`.
- bundled, hash-pinned package: `vendor/ublock`. first run copies verified bytes into the active profile and enables native network rules automatically; no download or Keychain access is needed. existing profile blocker preferences remain respected. `scripts/download-ublock.py` is a developer refresh tool, not onboarding. extension code stays sandboxed in electron.
- sidebar **uBO Lite · on** opens olive's basic on/off popup. six original default static rulesets use chromium's native `declarativeNetRequest`; no homemade ad-filter engine, API shims, or modified extension source.
- **limits:** not full uBO Lite compatibility. the official background worker crashes on missing `chrome.permissions.onRemoved`. the official popup resource opens, but its full controls do not work; per-site modes, picker/cosmetic filtering and background-driven updates aren't available. olive's basic popup states this explicitly. no private-window extension loading and no automatic package updates.
- important: even an electron `webRequest.onBeforeSendHeaders` listener scoped only to google disabled native DNR matching. removed that listener; existing navigation-specific UA handling remains. google still reached the password page in the dev regression probe (no password typed).
- test: `OLIVE_PROFILE=dev node scripts/extension-test.mjs` (dev must run with `OLIVE_CDP=1`). actual CNN page: zero blocked requests off, fifteen native `ERR_BLOCKED_BY_CLIENT` requests on, including rubicon ad auctions, adsafeprotected, and google IMA SDK. this is network blocking, not a claim that every visual ad slot disappears.
- next gap: estimate 2–5 days to investigate electron's MV3 worker-preload/API compatibility, then re-test the unmodified official popup. not an implementation promise; may need an upstream electron fix. no password-manager work.

Permission regression tests: `node scripts/media-permissions-unit.cjs` and `OLIVE_PROFILE=dev node scripts/site-settings-test.mjs` (dev CDP enabled). Never run the UI suite against the real profile: it replaces its tab fixture.


### profiles, setup and local review

- **Profiles…** creates truly separate Chromium partitions and per-profile tabs, cookies, history, permissions, shortcut mappings, setup progress and activity. Existing default data remains in its original location/partition; it is never migrated or imported automatically. Switch saves normal tabs and closes private windows. Active downloads, imports and pending permission requests prevent switching.
- Fresh profiles get optional setup; existing profiles are excluded. Set up later preserves the current step. Calls, screen recording, Keychain-backed imports and relaunches have a disclosure and explicit confirmation before the system action. Merely opening setup makes no system request.
- Browser discovery is read-only and never quits the source browser. Import supports Chromium-family cookies only, keeping existing Olive cookies; not passwords, history/bookmarks, site storage or IndexedDB. Unsupported Safari/Firefox profiles are identified, not silently imported. Some sign-ins still need a fresh login.
- **Keyboard Shortcuts…** edits per-profile shortcuts, checks conflicts, and resets defaults. Ctrl+Tab / Ctrl+Shift+Tab use a frozen per-window most-recently-used order while held; releasing the mapped hold modifier commits the selection. Both are remappable. Cmd+1…9 and Cmd+Option+arrows remain available.
- **Activity…** is local-only, with pause, retention, filtering, JSON/CSV export and delete. Private events are discarded. It records limited operation metadata, not page/form/search contents, cookies or passwords; URL credentials, query and fragment are removed. `activity.json` is mode 0600. It does not send telemetry.
- Setup and settings use trusted child views inside the current browser window, not detached app windows. macOS-owned permission/authentication dialogs remain system UI.

Safe isolated tests (each native test launches its own temporary profile):
```
node --test tests/*.test.js
node scripts/onboarding-unit.cjs
node scripts/browser-import-test.cjs
node scripts/arc-import-test.cjs
node scripts/shortcuts-test.mjs
node scripts/profiles-native-test.mjs
node scripts/ledger-panel-native-test.mjs
```

The installed real profile must never be used for these fixtures. Development supports `OLIVE_USER_DATA_DIR` for a disposable directory and separate `OLIVE_API_PORT`/`OLIVE_CDP_PORT`; installed `:9333` need not be interrupted.

### visual acceptance, not just behavior

`npm test` runs isolated units/synthetic checks. `npm run test:native` launches its
own disposable Electron processes and never attaches to installed Olive. Main
chrome has a whole-window contract at 1280×800/1360×880, light/dark and a 180px
sidebar: no debug endpoint text, no clipped footer controls, readable uBO label,
no new native settings windows and exact inline pane bounds. Run
`npm run test:visual` for metrics only (no OS permission requests). Refresh actual
whole-window evidence separately with `node scripts/chrome-visual-contract.mjs
--cua-shots` and service the printed CUA cues. Missing full-window captures fail
that explicit capture run, rather than being substituted with renderer crops.

Onboarding's visual test checks every step and appearance without making OS
requests or importing anything. Its `*-page.png`/`*-chrome.png` files are separate
renderer diagnostics, **not** native-window screenshots. Actual CUA full-window
shots and a blind visual review are required before visual sign-off. Metrics
alone do not establish native feel. The private installed-app review capture is
kept outside the repo under `/tmp/olive-private-review`.
