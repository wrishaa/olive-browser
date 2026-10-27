# settings visual review — 2026-10-27

for fable #408 / parent #258. this is a review request, not visual sign-off.

## latest actual native captures

all captured through cua from a private cloned electron fixture, 1360×880 logical window, synthetic profile only. no installed app/profile attached, restarted or signed. images are real full-window captures (not renderer crops or composed mockups):

- `notes/test-shots/settings-profiles-light-full-window.png`
- `notes/test-shots/settings-profiles-dark-full-window.png`
- `notes/test-shots/settings-ledger-light-full-window.png`
- `notes/test-shots/settings-ledger-dark-full-window.png`
- `notes/test-shots/settings-shortcuts-light-full-window.png`
- `notes/test-shots/settings-shortcuts-dark-full-window.png`

## applied by #401

- shared `settings-base.css`: solid app text/dim tokens, opaque card page, 960px max column, compact fields and styled select chevrons, SF 13px. token blocks match `ui.css` exactly.
- profiles/activity: no done footer, no floating panel treatment. profiles is a compact list with quiet row actions.
- activity: period menu replaces html date inputs, timeline details use readable SF text rather than raw internal key/value metadata. exports still preserve full sanitized events. native date boundaries have unit coverage.
- shortcuts css: compact key list. saves are quiet text row actions, revealed only while the row has focus, not 31+ always-visible capsules. no shortcut renderer/behavior changes made here.
- removed the remaining hardcoded error ink in site-settings css; all six per-page stylesheets now use app color tokens only.

## coordination still needed with #400

#400 retains shortcuts renderer/html/behavior ownership. fable's latest spec also calls for mac modifier glyphs instead of `Cmd+` strings, less header prose and no done footer. those remain in the shortcut renderer/html in these captures and are not claimed fixed by this css pass. once #400 applies them, recapture shortcuts only with:

`OLIVE_SETTINGS_SHOT_PAGES=shortcuts node scripts/ledger-panel-native-test.mjs --cua-shots`

cua cue file: `/tmp/olive-settings-shot-request.json`; bind `com.reframe.olive.settings-visual` and save `getScreenshot()` to the cue's file. the script waits for each real window capture and normalizes the artifact to png.

## checks

- ledger/profile unit suite 12/12, including period bounds, no html date/done controls, token sync and no literal ink in per-page css.
- own fixture native 31/31: exact inline pane bounds, one window, light/dark contrast ≥4.5, no clipping/debug strings, sidebar shown/hidden, filtering, redaction, pause, native dialog parent, rename, escape/reopen and profile isolation.
- all six settings surfaces light/dark css fixture 12/12 after shared css changes.

fable should judge the full-window images, especially the dark text and compact list feel. automated metrics do not constitute visual approval.
