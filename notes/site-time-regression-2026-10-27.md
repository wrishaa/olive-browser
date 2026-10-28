# site time, sidebar chrome and command discoverability

## fixes

- activities is now a per-profile Site Time page, not the event ledger. Today / 7 Days / All Time include totals, explicit calendar-day average, a seven-day chart, ranked hostname/share/time rows, local-only copy, and a native attached reset confirmation (Cancel default). The event log remains a separate destination.
- Only a focused, visible normal window's selected loaded HTTP(S) page counts. Private/background/minimized windows, settings/setup/activity pages, overlays, sleep and lock are excluded. Split view counts the selected page once. No historical time is inferred from visits.
- Persistent data is only local day → normalized hostname → seconds (`site-time.json`, mode 0600, atomic replacement). Monotonic elapsed time, local-midnight/DST splitting, long-gap rejection and lifecycle checkpoints prevent invented or duplicated time. No network requests are made for site icons.
- Native macOS window buttons previously stayed visible even when the sidebar was hidden. Peek CSS also shrank the traffic-light reserve to 4px while the native controls remained in their original position. The controls now follow actual sidebar visibility; full reserve exists from first paint and wraps navigation at minimum width.
- The peek sidebar used an 8px top/left inset, native drag regions swallowed pointer transitions, and any DOM mouseleave at x>20 collapsed it immediately—including moving into native titlebar controls. Peek is now aligned to the native header, accepts pointer transitions, treats its full top/header envelope as inside, and has a short cancellable crossing grace. Deliberately leaving to the page or pressing Escape still closes it.
- The omnibar previously knew only URLs/search/tabs/history. It now ranks allowlisted app commands first for words such as activities, site time, shortcuts, settings, profiles, permissions and setup. App commands cannot be converted into history host autocompletions, and execution does not navigate/create a web tab.

## evidence and verification

All automated browser tests use disposable profiles and never attach to the installed profile. Full-window evidence is captured through CUA, not a renderer crop. Design ownership: fable; final design and independent blind visual verdicts are recorded when complete.

- `npm test`: node unit tests plus existing onboarding/media/import/shortcut tests.
- `npm run test:native`: existing profiles/extensions/shortcut/ledger coverage plus site-time lifecycle/UI and omnibar command coverage.
- `npm run test:visual`: 48 chrome contracts across light/dark, two sizes and two sidebar widths.
- new site-time core/controller tests cover privacy gates, native focus/visibility, navigation, sleep/lock, midnight/DST, monotonic clocks, reset races, profile isolation, trusted IPC and local storage.
- sidebar regression covers real pointer paths into the top/header, minimum width, brief versus deliberate page crossings, native button visibility calls and fullscreen transitions.
- artifacts: `notes/test-shots/site-time-*-full-window.png` and `notes/test-shots/sidebar-*-full-window.png`.

Release backup, installed hash, rollback and installed full-window evidence are recorded separately in the private dated backup directory. No profile/cookie/permission reset and no push are part of this change.

## release verification progress

- current app quit cleanly for release; no live dj agent-api probes used.
- verified snapshot: `~/Library/Application Support/Olive Backups/before-site-time-20261027-224312/user-data` (66,050 files, 2,546,220,252 bytes), source and copy SHA-256 manifests equal, both cookie databases `PRAGMA quick_check = ok`.
- native site-time test later exposed a double-navigation race in the fixture itself (`createTab()` + `loadURL()`); fixed navigation must pass final combined suite before signing.
- four real full-window sidebar shots: `sidebar-{hidden,peek}-{light,dark}.png`, parent captured through cua.
- reset evidence is a focused native sheet, **not** a full-window shot despite the existing filename; parent/default-Cancel verified in native test.

## installed release — 22:56

- full `npm run test:native` passed, including profiles, extensions, shortcuts, activity, site-time 23/23, omnibar 13/13 and sidebar 72/72. profile blocker assertion now waits for extension-ready; test-only, no production workaround.
- `npm test`: 44 node checks, onboarding/media, 33 browser import and 12 arc import checks passed. chrome visual contract: 48/48. fable and independent visual review passed all final captures; reset-sheet shot is cropped and attachment is covered by native test.
- built and Developer ID signed once with GLUU6G59Y3, strict signature verified. signed packaged smoke passed against a throwaway profile: one inline activities pane, shortcuts, hidden native lights, bundled blocker enabled.
- olive had reopened during tests. quit it cleanly again and made a newer verified snapshot before swapping: 66,186 files, 2,550,201,461 bytes; source/copy sha256 maps equal, both cookie quick_checks ok.
- installed `/Users/risha/Applications/Olive.app`; native UI verified existing tabs and gmail login, uBO Lite on, footer opens inline Site Time, lights absent with hidden sidebar. original page and visible sidebar restored afterward. no requests to the installed :9333 api.
- local time tracking starts now; no invented history/backfill. no telemetry.
- no new commit or push. reviewed source remains uncommitted; source hash manifest records 1,003 release inputs.
- backup/rollback/report: `/Users/risha/Library/Application Support/Olive Backups/before-site-time-20261027-225535` (`user-data`, `rollback/Olive.app`, `installed-release.json`).
- app.asar sha256: `18ea3c264ed4525314bb0892195b27853c44baeed228f56f31544800db9b7ecc`.
- installed full-window evidence: `notes/test-shots/site-time-installed-full-window.png`, `notes/test-shots/site-time-installed-sidebar-hidden-full-window.png`.
