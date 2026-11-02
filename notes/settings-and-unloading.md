# settings page + tab unloading

branch `overnight-settings-unload` (off `overnight-fixes` 2df4ed4). rollback tag `rb-before-settings-unload-20261102-0859`.

## before (2df4ed4)

tab unloading
- `src/main/main.js:25` `DEFAULT_SETTINGS = { cdp: false, agentApi: true, discardMinutes: 30, maxLoadedTabs: 16 }`, read at `main.js:24-31`, `setSetting` at `main.js:359` (no validation).
- `main.js:322-353` `startDiscardTimer` (60 s) + `discardIdleTabs`: one idle threshold (30 min) for every tab, pinned or not. exempt: visible, devtools, `isCurrentlyAudible`, debugger attached. cap 16 on by default, evicted oldest-`lastActive` first, pinned or not. `lastActive` of a tab opened in the background was 0, so it counted as idle for ~56 years: a cmd+click background tab could unload on the next tick.
- no settings UI for any of it. agent api `POST /discard {olderThanMinutes}` (`agent-api.js:106/283`).

settings pages
- five separate inline pages, each its own entry: `shortcuts.js:106 showSettings` (Keyboard Shortcuts, Cmd+, = command `settings` labelled "Keyboard Shortcuts", `shortcuts.js:21`), `extension-settings.js` (Extensions…), `site-time.js show` (Activities — Site Time…), `ledger-review.js` (Activity Event Log…), `permissions.js showSettings` (per-site settings for the current tab).
- routing `window.js:1420-1426`, menu `menu.js:22-26`. no `olive://` anything.

## what's built

### tab unloading (`src/core/tab-unload.js`, pure, unit tested)

| setting | default | 0 / empty |
|---|---|---|
| `unloadAfterMinutes` (not pinned) | 120 | never |
| `pinnedUnloadAfterMinutes` | 480 | never |
| `maxLoadedTabs` (all windows) | 0 = off | off |

- `plan(tabs, settings, {now, olderThanMinutes})` returns `[{id, reason: 'idle'|'max'}]`. main.js `unloadFacts()` gathers the facts per tab, `discardIdleTabs()` applies the plan (same 60 s timer).
- idle = now − max(`lastActive`, `lastVisible` (stamped every tick while on screen, so a split pane that was visible counts), `loadedAt` (set when the renderer is created), `lastAgentStep`). fixes the background-tab-at-0 case above.
- cap eviction (only when the cap is on): oldest-idle non-pinned first; pinned (oldest-idle first) only if still over the cap. idle unloads count first.
- `POST /discard {olderThanMinutes}` still works: one threshold for pinned and non-pinned, same exemptions. without it: the settings.
- `unload(tab, {reason})` now records the reason in the activity ledger event (`idle` / `max` / `user`).

why these defaults (decided by dj): time-based only. 2 h for normal tabs is long enough that anything you're still working through stays; pinned tabs are "apps" (mail, calendar, chat) you come back to, so 8 h, i.e. a workday. the cap is off because a count says nothing about memory (16 gmail tabs vs 16 text pages) and it surprised people by unloading tabs they had just opened in the background; whoever wants it turns it on, and the page then starts at 16 (the old default, ~16 renderers is a sane laptop ceiling).

legacy migration (`migrate()`, once, marked by `tabUnloadVersion: 1` in settings.json):
- `discardMinutes` absent or 30 (old default): ignored. any other value (incl. 0 = off) becomes `unloadAfterMinutes`. the key is dropped.
- `maxLoadedTabs: 16` (old default) = never chosen, so the cap goes off. any other stored value stays. after the migration an explicit 16 is the user's and stays (tested across a relaunch).
- junk values fall back to the defaults. settings.json writes are atomic (tmp + rename) now.

### exemptions (never unloaded, by idle time or by the cap)

| exemption | how | limits |
|---|---|---|
| on screen | `visibleIds()` of every window: the active tab and every pane of its split | a tab behind an open inline page (settings) still counts as on screen |
| still loading | `tab.loading` or `wc.isLoading()` | a page that never finishes loading never unloads |
| playing audio | `tab.audible` (audio-state-changed) or `wc.isCurrentlyAudible()` | a muted tab that plays is still audible to chromium, so it stays (fine) |
| camera / mic / screen | `permissions.js markCapturing(wc)`: set when a `media` permission request is answered allow (`finish`), and when a screen/window source is handed to `getDisplayMedia`. cleared on the next main-document navigation (`did-navigate`, includes reload), crash, unload | electron 44 has no "is capturing" signal (no capture-indicator api; `isCurrentlyAudible` is playback; `isBeingCaptured` is the opposite direction). so it's "was granted capture in this document": a call that ended without leaving the page keeps the tab loaded until it navigates. conservative on purpose. the native test sets the flag through `markCapturing` (no real camera / TCC prompt in a test) |
| agent | `wc.debugger.isAttached()`, or `agentWake.busy(tab)` (an agent step running or still awake in its linger), or the tab is in an agent group that is `working` | agent steps also refresh idle (`lastAgentStep`) |
| devtools open | `tab.devtools` | |
| unsaved form input | `window.js wireDirtyInput`: on a keyDown that edits text (printable key, Backspace/Delete/Enter, IME `Process`/`Dead`, cmd+v / cmd+x) the focused frame (`wc.focusedFrame`, so cross-origin iframes too) runs a tiny check: is `document.activeElement` (through open shadow roots) a contenteditable, textarea or text-like input (not button/checkbox/radio/range/color/file/hidden), not disabled/readonly. if so `tab.dirty = true`. the check runs once per document (not per key) until dirty. cleared on main-document navigation / reload / crash / unload | paste from the context menu, drag-and-drop, autofill, dictation and IME without a key event don't mark it. a submitted SPA form (no navigation) stays dirty until the page navigates, so such a tab may stay loaded longer than needed. the check runs in the page's main world, so a page could fake it (only to keep itself loaded, the same as playing silent audio). search boxes count too (typing a search then navigating clears it) |

### settings page (`src/main/settings-page.js`)

- one trusted inline page (InlinePage/AppPanel, kind `settings`, title "Settings"), one per window at a time, tabs **General | Keyboard Shortcuts | Activities | Extensions**. each tab is its own local document loaded into the same page (`settings-general.html`, `shortcuts.html`, `site-time.html`, `extensions.html`), sharing `settings-nav.js` (tab bar + url label) and `settings-shell.css` (one width, title). one preload `settings-preload.js` exposes the four bridges; old per-page preloads deleted.
- trust: the page controller binds the data controllers to this page's webContents (`shortcuts.bind(view)`, `extensionSettings.view`, `siteTime.adopt(view)`); every channel answers only this page's main frame. private windows never host it (it opens in the last normal window, or a new one).
- General:
  - Tab unloading: the two minute fields (units, help text, defaults), "Limit loaded tabs" switch + number field. cap off: field empty + disabled; switching on prefills 16 and focuses the field; empty / 0 turns it off. invalid input is refused in the page (red outline + message), nothing saved. Restore defaults. the exemption list is shown under the fields.
  - Site permissions: every site with saved choices in this profile (persistent profile only), the current tab's site first (expanded when opened from "Site Permissions"). per permission Ask / Allow / Block, "Forget all choices for this site". macOS access rows (mic / camera / screen recording status + open macOS settings).
  - Agent access: Olive agent API + CDP port toggles (existing settings, take effect after relaunch; the Developer menu CDP checkbox stays and stays in sync).
- Keyboard Shortcuts: the existing remapping UI, unchanged (overrides, conflicts, reserved list, reset). the recorder tab ignores menu shortcuts and handles Escape itself; other tabs keep menu shortcuts and Escape closes the page.
- Activities: the existing Site Time page + an "Activity Event Log" entry that opens the ledger page (it stays its own inline page: it's a full log viewer with export/delete, not a setting).
- Extensions: the existing extensions page.

entry points (all land in the same page, no other windows/pages):
- cmd+l palette: new **Settings** command (top for "settings", "preferences", "options", "unload"…). typed/pasted `olive://settings`, `olive://settings/general|shortcuts|activities|extensions`, aliases `olive://shortcuts|extensions|activities|preferences|permissions` open it (palette interception in `window.submit` + a Settings suggestion; no protocol handler, so web pages can't link to it). works from cmd+t (new) and cmd+l (edit) without navigating the tab.
- **Cmd+,** = Olive > Settings… (command id `settings` relabelled "Settings", still remappable). clash check: Cmd+, is not in `RESERVED`, no other command or menu item uses it (asserted in shortcuts-test and the native test).
- old entries redirect: Olive > Keyboard Shortcuts… (no accelerator now) → shortcuts tab; Extensions… → extensions; Activities — Site Time… → activities; palette `shortcuts` / `extensions` / `activities` → their tab; palette "Site Permissions" (was "Site Settings") → General, Site permissions section.
- no sidebar entry (dj). the existing app-page row ("Settings") shows in the sidebar only while the page is open, like every inline page.
- `src/core/settings-url.js` parses the urls (unit tested).

## tests

- `tests/tab-unload.test.js` (9): defaults, custom, 0 = never, idle sources, cap order, every exemption (timer + cap + api), api override, normalize, migration, settings.json persistence across a reload. `tests/settings-url.test.js` (3). `tests/app-commands.test.js` updated. `scripts/shortcuts-test.mjs`: Cmd+, on Settings…, hosted in the settings page, IPC guards.
- `scripts/settings-native-test.mjs` (in `test:native`, `--shots` = `npm run test:visual:settings`): 71 checks. disposable profile, ports 0, fake clock (`mgr.clock`), timer disabled (`OLIVE_UNLOAD_TICK_MS`).

## open questions

1. the per-site "Site settings" panel (`permissions.showSettings`) still exists for the two flows that need it right there: macOS blocked the camera/mic, and the screen-recording setup + relaunch. should those also land in General (would need the screen-setup steps there)?
2. Activity Event Log stays its own inline page (Activities links to it). fold it in as a fifth tab?
3. capture detection is "granted in this document". worth a page-side preload that watches live MediaStreamTracks so a finished call can unload?
4. dirty input: should a successful form submit (fetch/XHR after a submit event) clear it? today only navigation does.
5. tabs in other profiles/private windows are covered by the same rules; private windows can't open Settings (it opens in a normal window). ok?
6. the `tab-unload` ledger event now carries a reason; the ledger UI shows it as-is. fine?
