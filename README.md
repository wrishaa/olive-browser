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
- plain chrome user agent so sites like google sign-in work

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
spaces/profiles, bookmarks ui (pinned tabs cover it for now), tab sleeping,
safari/chrome import, auto-update, a signed + notarized build.

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
