# overnight fixes: packaged-build test (2026-11-02)

build: `scripts/package.mjs` with `OLIVE_NO_INSTALL=1 OLIVE_SIGN_IDENTITY=-` (ad-hoc, never the Retune Developer ID, never installed), from overnight-fixes at ee55da6 + ecf0da1.
copied to `~/olive-backups/test-builds/OliveTest-20261102-0112.app`: CFBundleIdentifier `com.reframe.olive.overnighttest`, name OliveTest (helpers renamed to `OliveTest Helper*`, ids `com.reframe.olive.overnighttest.helper`), url/document handler claims removed, `app.setName('OliveTest')` patched into the copy's app.asar so the keychain service could only ever be "OliveTest Safe Storage" (none was created; cookie encryption fuse is off; launched with `--use-mock-keychain`), re-signed `codesign --force --deep -s -`.

run: temp `OLIVE_USER_DATA_DIR` (mktemp, deleted afterwards), `OLIVE_PROFILE=overnighttest`, cdp off, agent api on port 0 (random), playwright `_electron` attached for main-process state reads and shots. local http fixtures only (127.0.0.1 / localhost), no logins, no real sites.
input: real macOS input via Computer Use (cua) for keys, clicks, double-clicks and drags into the OliveTest app. cua can't post a bare modifier release (no flagsChanged), so a ctrl+tab walk was committed either by a real plain key (Escape, which arrives without the ctrl flag) or by a Control keyUp sent with `webContents.sendInputEvent`. (review: committing with Escape was wrong, esc must cancel; see a5 below. the a5 run commits only with the Control keyUp.)

| # | item | commit | result | how it was tested | shot |
|---|------|--------|--------|-------------------|------|
| 1 | ctrl+tab mru switch-back | 42e5989 | pass | 4 tabs, MRU [4,3,2,1]. real ctrl+tab tap + Escape → tab 3, order [3,4,2,1]; tap again → back to 4. hold: 3 real ctrl+tab presses walk 3→2→1 (walk stays open), Control keyUp commits → [1,4,3,2] | 01-ctrl-tab-mru.png (mid-walk) |
| 2 | pinned tab domain lock + reset | a86eb5c | pass | pinned 127.0.0.1/home. real click on same-site link → stays in pinned tab, reset icon shows; real click on reset → back to /home, icon gone; real click on cross-site link (localhost) → new normal active tab, pinned tab still /home | 02-pinned-domain-lock-reset.png |
| 3 | tab rename | d2c0f13 + fix ee55da6 | **fail → fixed → pass** | real double-click on a tab title opened the field, but real typing went to the page: the row click activates the tab and moves native focus into the page, and the field only had DOM focus. (the native test types over CDP, so it never noticed.) fix: the ui asks main for `focusUi` when a rename field opens (tab and group). after the fix: real double-click + real typing "Reading list" + Enter → custom title kept, still kept after the page set `document.title` | 03-tab-rename.png (field), 03-tab-rename-done.png |
| 4 | pinned tabs never split | e80a8e0 | pass | pinned tab active, real ⌃⇧= → split palette, typed url, Enter → split = [normal copy of pinned url, new tab], pinned tab not split. real drag of the pinned row onto the page → split = [current tab, normal copy]; no pinned tab in any split | 04-pinned-never-split.png |
| 5 | hide uBO Lite toolbar button | 839f04b | pass | fresh profile: uBO Lite installed + enabled, `showInToolbar` false, `#btn-ublock` hidden. a real click on "Show in sidebar toolbar" on the Extensions page shows it; clicking again hides it | 05-ublock-toolbar-hidden.png |
| 6 | extensions settings page + uBO Options… | 7dc9216, 4415549 | pass | real ⌘L, typed "extensions", Enter → "Extensions" command selected, Extensions page renders (Options…, Enabled, Show in sidebar toolbar). real click Options… → uBO Lite dashboard renders (title "uBO Lite — Dashboard", Settings / Filter lists / Custom filters / About, 13 inputs) | 06-extensions-page.png, 06-ublock-options.png |
| 7 | meet first screen-share click | 6e95ff8 | pass | local fixture: the Present button sits in an iframe (allow=display-capture); the click does `parent.history.pushState` then `getDisplayMedia`, and the page reloads a side iframe + pushState again while the prompt is up. first real click → prompt shown, survives 2 rounds of subframe load + pushState; real click Allow once → picker opens despite 2 more rounds during the slow (1.5 s) first getSources, and stays open over another round; real click Cancel → picker closed, page rejected once. second click → no prompt (allow once still valid), picker directly; Cancel. only the macOS capture layer was stubbed in main (`getMediaAccessStatus('screen')` = granted, `desktopCapturer.getSources` = 2 fake sources), the same as display-media-native-test, so there was no TCC prompt and nothing was captured | 07-meet-share-prompt.png, 07-meet-share-picker.png |
| 8 | cmd+l palette cmd+enter → new foreground tab | 7c3da43 | pass | on tab 10 (fixture), real ⌘L, typed `127.0.0.1:63967/eight`, hints show "⌘↵ new tab", real ⌘↵ → new tab 11 active on /eight, tab 10 url unchanged, palette closed | 08-palette-cmd-enter.png, 08-palette-cmd-enter-after.png |
| a5 | esc cancels a held ctrl+tab walk | 6f066d8 | **fail → fixed → pass** | dev fixture `scripts/tab-mru-cua-fixture.mjs` (temp profile, 1440x900, 4 tabs). before: esc during a held walk committed the previewed tab (and with ctrl held it reached the page). after, real keys via cua: real ctrl+tab x3 → tab 1, Control keyUp (sendInputEvent, never esc) commits [1,4,3,2]; real ctrl+tab x2 previews tab 3, real ctrl+Escape (ctrl held) → back on tab 1, mru [1,4,3,2] unchanged, walk closed, Escape seen by no page; the Control keyUp after it changes nothing. native `tab-mru-native-test.mjs` a5 13/13 (ctrl+tab, cmd+alt+k remap, palette open) | a5-esc-cancel-1440.png |

## notes

- cancel in the share picker gives the page `AbortError: Invalid capture constraints`. notes/media-permissions.md links that message to the old double answer, but this isn't that: a throwaway in-memory session whose handler calls `callback(null)` exactly once gets the same error in Electron 44. olive answers once.
- `npm test` was red at 7b05bd3: onboarding-unit verified the prepared uBO copy without olive's worker-shim overlay (stale since 4415549). fixed the test in ecf0da1; `npm test` green. pinned-tabs-native-test 32/32 with the new focus check.
- a10 (two windows, checked with the a5 fix, not changed): each window keeps its own mru. tabs opened interleaved A1 B1 A2 B2 A3 B3 across two windows; ctrl+tab in window 2 toggled B3 → B2 and a hold walk covered only [B2, B3, B1], window 1 stayed [A3, A2, A1] untouched; a tap in window 1 toggled A3 → A2 without touching window 2; `cmd('mruNext')` per window likewise.

## rename triggers (2026-11-02, branch overnight-rename-triggers)

fixture: `scripts/tab-rename-native-test.mjs` (temp profile, ports 0, 1440x900, local http). input via `webContents.sendInputEvent` (mouse down/up with clickCount 2, keyDown/char/keyUp), not DOM events. the fixture window is in the background, so keyboard focus is tracked as "the webcontents olive last focused" (electron's isFocused follows the os key window). spec + gaps: notes/tab-rename-spec.md. shots are the ui view (sidebar + chrome; page cards are separate views), screencapture -l had no permission.

| # | check | result | shot |
|---|-------|--------|------|
| r1 | dblclick unpinned title → field, keyboard to ui; enter commits, esc cancels | pass | rename-dblclick-1440.png |
| r2 | dblclick pinned title → field; dblclick title in a split → field | pass | |
| r3 | dblclick favicon, dblclick close x → no rename | pass | |
| r4 | dblclick group head → group field (esc keeps the name) | pass | |
| r5 | ⌘-click one row, enter → field; enter commits (no reopen), esc cancels; shift/cmd+enter, two selected → nothing | pass (new) | rename-enter-1440.png |
| r6 | clash: one row selected, keyboard in the page, enter → no rename (also a stray enter into the unfocused ui) | pass | |
| r7 | clash: enter in a page textarea → newline, no rename | pass | |
| r8 | clash: cmd+l enter navigates, shift+enter splits, cmd+enter new foreground tab, no rename | pass | |
| r9 | clash: enter in the find bar → no rename | pass | |
