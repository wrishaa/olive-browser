# visual regression review — 2026-10-27

## what went wrong

- **popup over the page:** the first redesign embedded a floating dialog in the existing native window. A one-window assertion passed, but the result still violated “no popup.” AppPanel now uses InlinePage and replaces the whole browser content pane, beside the live sidebar. There is no shell, scrim, detached window or floating card.
- **unreadable uBO Lite pill:** a fixed light fallback background remained in dark mode while the label used the dark-theme accent. It now uses the app's text/pill pair. Full rendered-pixel tests include alpha and require at least 4.5:1 contrast; observed main label range was 7.44–8.12:1.
- **debug footer:** the normal user interface exposed agent API/CDP ports (including fixture :19333/:19222). Those labels are removed; endpoints remain available through the explicit developer menu command. Tests reject visible debug/API/CDP/port text.
- **clipped `<>` control:** flexible footer children overflowed a narrow sidebar. The footer now has a flexible Activity column and fixed icon tracks; tests assert bounds and overlap at 180px and 252px sidebar widths.
- **setup disappearing on fresh startup:** the chrome did-finish-load handler opened the empty-window new-tab palette after inline setup had opened, closing it. It now opens the palette only when no tabs and no inline page exist. A real first-run native fixture covers this race.
- **dark settings almost invisible:** independent page CSS used fixed light-mode ink. Settings now inherit a shared copy of the app's light/dark tokens. Pages use compact rows, not form/dialog footers.

The earlier checks exercised component behaviour and counted native windows. They did not establish that the whole window looked coherent, that actual pixels were readable, or that an in-window floating dialog satisfied the user's requested interaction. Cropped renderer screenshots were insufficient visual acceptance.

## evidence

All tracked after-images contain synthetic fixture data, not the user's Gmail or DJ sessions. The actual installed-app before-image is private at `/tmp/olive-private-review/actual-installed-before-full-window.png`, not committed.

- before: `test-shots/before-onboarding-full-window.png`, `test-shots/main-app-full-window.png`
- main after: `test-shots/main-{light,dark}-after.png`
- inline settings after: `test-shots/settings-{profiles,ledger,shortcuts}-{light,dark}-full-window.png`
- setup after: `test-shots/onboarding-visual/1280x800-{light,dark}-{welcome,calls,import,done}-full-window.jpg`
- design/ref sources: `onboarding-mac-design.md`, `test-shots/references/SOURCES.md`

These full-window after-images were captured using CUA. The default chrome visual-contract run is metrics-only and never requests screen-recording access. `--cua-shots` explicitly refreshes whole-window images; renderer captures are diagnostic only, never a substitute.

## verification

- `npm test`: 15 node tests plus onboarding, media-permission, 45 synthetic importer and shortcut/MRU checks passed.
- `npm run test:native`: fresh setup/two-profile isolation; 15 blocker checks; actual shortcut remap/reset/MRU/input-release checks; 31 inline profile/activity checks passed.
- `node scripts/chrome-visual-contract.mjs`: 48/48 passed, zero failures, light/dark at 1280×800 and 1360×880 with normal/narrow sidebar. Fails on debug text, clipping, contrast below 4.5:1, extra settings windows or wrong pane geometry.
- setup visual contract: 193 checks, zero failures, all five steps, both window sizes and light/dark; no OS permission, Keychain, import or relaunch calls.
- blind fable review passed main/settings hard checks; separate fable design review and blind setup review are recorded in the final task report.

The installed app on :9333 and DJ profile were not restarted, imported into or migrated during this review. DJ's pre-onboarding backup is `~/Library/Application Support/Olive Backups/before-onboarding-20261027-195220`. No signing, install or push was performed. Actual OS permission grants and signed-package installation are not claimed by these fixture tests.
