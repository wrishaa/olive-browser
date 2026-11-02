# olive's own pages are tabs (olive://)

branch `overnight-settings-unload` (after phase 1, merge-base c75856d). dj (voice): "the settings
page or all those internal pages should act just like a website... they should have a link, a
url, they can be split, they can be closed, and so on."

## inventory: before → after

before = 2df4ed4 (dj's list) plus the phase-1 settings page (c75856d). every one of these was an
`InlinePage`/`AppPanel` overlay over the pane (src/main/inline-page.js, app-panel.js): no tab, no
url, one per window, Esc closed it.

| page | before (file:line, kind) | after (file:line, kind, url) |
|---|---|---|
| Settings (General) | c75856d settings-page.js:88 AppPanel | tab `olive://settings` / `olive://settings/general` · settings-page.js (show → internal-pages.js openSettings) |
| Keyboard Shortcuts | 2df4ed4 shortcuts.js:110 AppPanel → c75856d settings-page tab | tab `olive://settings/shortcuts` · shortcuts.js:110 installIpc |
| Activities (site time) | 2df4ed4 site-time.js:182 AppPanel → c75856d settings-page tab | tab `olive://settings/activities` · site-time.js:151 trusted |
| Extensions | 2df4ed4 extension-settings.js:58 AppPanel → c75856d settings-page tab | tab `olive://settings/extensions` (`olive://extensions` redirects) · extension-settings.js:19 trusted |
| uBO Lite basic page (shield) | extensions.js:241 AppPanel | tab `olive://extensions/ublock` · extensions.js:234 open |
| uBO Lite options (dashboard) | extensions.js:277 AppPanel (chrome-extension page) | tab `olive://extensions/ublock/options` (also `/dashboard`); the tab loads chrome-extension://…/dashboard.html, the address bar shows the olive:// url · extensions.js:263 openOptions |
| uBO Lite official popup | extensions.js:290 AppPanel | tab `olive://extensions/ublock/popup` · extensions.js:268 openOriginal |
| Activity Event Log | ledger-review.js:41 AppPanel | tab `olive://ledger` · ledger-review.js:43 show |
| Profiles | profile-controls.js:26 AppPanel | tab `olive://profiles` · profile-controls.js:20 show |
| Set Up Olive (onboarding) | onboarding.js:90 InlinePage | tab `olive://onboarding/<step>` (welcome/calls/import/screen/done; the page keeps the address on the saved step with replaceState) · onboarding.js:93 open → internal-pages.js view (onboarding.js:105 `new this.Panel` is the unit-test path only) |
| Site settings (lock icon / permission prompt) | permissions.js:200 (c75856d :254) AppPanel | **stays an overlay** · permissions.js:254. `olive://site-settings?origin=<o>` is a real url: it redirects to `olive://settings/general?section=permissions&origin=<o>` (the global per-site list, that site first) |
| capture picker | permissions.js:227 (now :281) AppPanel | stays (transient, per request) |
| permission bar | permissions.js:250 (now :301) WebContentsView | stays (transient) |
| page dialogs (alert/confirm/prompt) | page-dialogs.js:114 (now :106) WebContentsView | stays (transient) |
| sidebar "Settings" row (#settings-row) | ui.js:236, shown for the settings AppPanel | only for the remaining AppPanels (site settings, capture picker) |
| sidebar setup row (#setup-row) | ui.js:238, opened/closed the InlinePage | shown only while no olive://onboarding tab is open in that window (window.js snapshot); click opens/focuses the tab |

why site settings stays an overlay: it is bound to one tab's webContents (one-time grants for that
tab, finishing that tab's pending prompts, private-window choices). a separate tab loses that
binding and can't exist in private windows. the global per-site view is already a tab (Settings >
General > Site permissions), and the url deep-links there. open q below.

## how it works

- **scheme** (main.js:26): `protocol.registerSchemesAsPrivileged([{ scheme: 'olive', privileges: { standard: true, secure: true } }])` before ready, so pages get real origins (olive://settings, olive://ledger), relative css/js, history, back/forward. no fetch/cors/service-worker privileges.
- **handler** (internal-pages.js `respond`, per profile session in main.js setupSession): pages and plain-named css/js only from src/ui (never a `*-preload.js`, never a path). every response: `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `no-store`, `nosniff`. old names (olive://shortcuts, olive://extensions, olive://unloading, olive://site-settings…) redirect; main also resolves them before loading so the address is canonical. private sessions don't serve olive://: typed there, it opens in a normal window.
- **urls**: src/core/olive-url.js (pure, tests/olive-url.test.js). the address bar shows `olive://settings` (chromium's trailing slash is dropped for display); the lock isn't "not secure" for olive://.
- **preload**: one frame preload on the profile session (ui/olive-preload.js) exposes bridges only in an olive:// main frame, and only that page's (settings: oliveSettings/shortcuts/extensionSettings/oliveSiteTime; ledger; profiles; onboarding; extensions: ublock). the old per-page preloads are gone.
- **ipc trust**: every handler goes through `InternalPages.sender(event, host, { tab })`: sender frame is the main frame, its url (as main sees it) is that olive:// page/section, and the webContents is a tab of a normal (non-private) window. a web page, a subframe, a popup window, another olive page or another Settings section gets nothing.
- **web pages can't get in** (window.js wireTab): will-navigate blocks main-frame navigations into olive:// (or the uBO extension pages) unless the current page is internal; will-frame-navigate blocks every olive:// subframe; will-redirect blocks server redirects into olive://; the window-open handler denies olive:// from web pages. typed urls, menus, palette and links between olive pages work.
- **agent api** (agent-api.js): POST /tabs with an olive:// url, and any /tabs/:id action on an olive:// tab (eval, text, screenshot, navigate, cdp…), or navigate to olive:// is 403 `olive:// pages are not available to the agent api`. GET /tabs still lists them.
- **tab behaviors**: they're plain tabs, so close (cmd+w), split (palette ⇧↵, drag, split clone of a pinned one), pin, rename, ctrl+tab mru, ⇧⌘T reopen, drag/move, session restore all just work. unloading: safe (the page reloads its state from main), no exemption.
- **Esc** no longer closes anything: shortcuts.js, site-time.js and onboarding.js dropped their Esc-close handlers (Esc still cancels a shortcut recording / the reset prompt).
- **shortcut recording**: while a shortcut field has focus, the page tells main (`recording`), which sets `setIgnoreMenuShortcuts(true)` on that tab and skips Olive's tab keys, so cmd+w / ctrl+tab can be recorded; blur or any navigation turns it back off.
- **cmd+,** (menu.js:25 `settings(undefined)`, window.js cmd 'settings', internal-pages.js openSettings): focuses an open Settings tab as it is (current window first, then the most recently used in other windows), else opens a new foreground tab at olive://settings. entries that name a section (Keyboard Shortcuts…, Extensions…, Activities…, site permissions) navigate that tab to the section.
- **onboarding** keeps its panel-shaped handle: `InternalPages.view()` returns a TabView (show/focus/close/'closed') backed by the olive://onboarding tab; an open setup tab (restored by the session after the screen-recording relaunch, reopened, typed) is adopted, never duplicated. closing the tab or navigating it away = closing the panel (pauses setup unless quitting). the 063444b resume path (onboarding.js:65 resumeAfterScreen in maybeRun) is unchanged.
- **history**: olive:// pages stay out of browsing history (the palette lists them as commands).

## tests

- unit: tests/olive-url.test.js, tests/internal-pages.test.js (sender check, open/reuse, views, handler headers/404/redirects, navigation guard), ledger-review / profile-controls / site-time-controller tests rewritten for tabs (tests/helpers/fake-browser.js), scripts/shortcuts-test.mjs settings part, onboarding-unit.cjs unchanged.
- native: scripts/internal-tabs-native-test.mjs (disposable profile, ports 0, local fixture server): cmd+, new/focus-existing (also from another window), address bar, section links, back/forward, reload, shortcut recording, Esc, typed urls and redirects, bridges per page, web pages blocked (link, location, window.open, iframe, 302), agent api 403, split, ⇧↵ split, pin + split clone, rename, mru, drag, unload + reload, close + reopen, private window hand-off, uBO page/options/dashboard/reload, onboarding tab (step in url, Esc, focus-existing, close pauses, resume, finish). `--shots` writes the 1440 shots below.
- scripts/onboarding-resume-native-test.mjs updated for the tab (SIGTERM relaunch resumes at olive://onboarding/done, one tab, no overlay).

shots (notes/test-shots/olive-tab-scenarios/fixed/, 1440 wide, light/dark): internal-settings-tab, internal-settings-split (Settings next to a web page), internal-settings-pinned, internal-ublock-options, internal-onboarding-tab.

## open questions (defaults taken, for dj)

1. cmd+, focuses the existing Settings tab (current window first, then any window) and leaves its section alone; with none it opens a new foreground tab. ok? (alternative: always jump to General.)
2. uBO is `olive://extensions/ublock` (Olive's on/off page), `/options` = `/dashboard` (uBO's dashboard), `/popup` (uBO's own popup). the tab loads the chrome-extension page; the address bar, session, sidebar and agent api only ever show olive://. ok to keep the shield opening a full tab instead of a small popover?
3. onboarding is a normal tab at `olive://onboarding/<step>`; the url follows the saved step (typing another step doesn't jump there: main owns progress). it resumes after the screen-recording relaunch (onboarding-resume native 34/0). closing a *pinned* setup tab only unloads it, so it doesn't pause setup. ok?
4. site settings (lock icon) stays a per-tab overlay; `olive://site-settings?origin=` goes to Settings > General > Site permissions. turn the lock panel into a tab too?
5. agent api can't open, read or drive olive:// tabs (403). right call, or should agents be allowed to read them?
6. olive:// pages aren't in browsing history. should they show up in history search?
