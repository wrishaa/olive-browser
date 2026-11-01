# tab mru (ctrl+tab) spec

model: each window keeps an MRU list of its tab ids (most recent first). a "walk" is
a frozen snapshot of that list taken on the first ctrl+tab keyDown; previews during
the walk never change recency. releasing the hold modifier (ctrl) commits: the tab
you landed on becomes most recent. esc while the modifier is still held cancels the
walk instead (back to the tab it started on, mru untouched). ctrl+shift+tab walks the same snapshot backwards
(shift is not a commit modifier, so toggling shift mid-walk just reverses).

| id | scenario | expected |
|----|----------|----------|
| a | mru = [A, B, ...], A active. tap ctrl+tab (ctrl down, tab, ctrl up). tap again. | first tap -> B, mru [B, A, ...]. second tap -> A, mru [A, B, ...]. |
| a5 | mru = [A, B, C, D], A active. hold ctrl, tab twice (previews C), press esc with ctrl still held, then release ctrl. same for a remapped hold walk (e.g. cmd+alt+k). | esc cancels: back on A, mru still [A, B, C, D], no walk left. esc is swallowed (the page, palette or inline page never sees its keyDown/keyUp). the ctrl release afterwards does nothing; the next tap toggles A -> B as usual. esc with no walk open reaches the page normally. (olive rejects alt+tab as a shortcut, so there is no alt-tab walk.) |
| b | mru = [A, B, C, D], A active. hold ctrl, press tab N times (N=3), release ctrl. then one tap. | previews B, C, D; on release D active, mru [D, A, B, C]. next tap -> A. |
| c | 20 quick taps, ctrl released between each (including when the keyUp lands in a different webcontents than the keyDown, e.g. the previewed tab's view, or is lost entirely). | alternates A, B, A, B ... never walks to a third tab. |
| d1 | sidebar click on tab C (activate from ui), then tap. | goes back to the tab active before the click. |
| d2 | click into the other pane of a split, then tap. | goes to the previously focused pane's tab. |
| d3 | palette/cmd+l open + pick a tab / cmd+1-9 select, then tap. | goes back to the tab active before. |
| d4 | ctrl released while focus is in the ui webcontents (sidebar), a just-created/unloaded tab view, an inline page, or the keyUp never reaches any wired webcontents. | no stale walk survives: the next ctrl+tab tap starts a fresh walk from the current mru (toggles to previous tab), it does not continue the old walk. |
| d5 | ctrl+tab dispatched through the native menu accelerator (focus in a webcontents that does not run olive's before-input-event, e.g. no wc focused). | behaves like a tap: toggles to previous tab, mru committed. |
| e | 10 tabs, 200 random activations (sidebar/cmd+n/click), interleaved with random taps and holds (1-4 tabs, sometimes ctrl+shift). | after each step active tab and mru order equal a reference mru model. |
| f1 | hold ctrl+shift, tab N times. | walks the snapshot from the end (least recent first). |
| f2 | hold ctrl, tab twice, close a tab (the previewed one, or another) mid-walk, keep walking / release. | no exception; closed tab dropped from mru and walk; walk continues or commits on a live tab; next tap toggles correctly. |

## root causes (found with scripts/tab-mru-native-test.mjs)

1. **chromium swallows the ctrl keyUp.** when before-input-event `preventDefault()`s a
   keyDown, `RenderWidgetHostImpl` sets `suppress_events_until_keydown_` and drops every
   later keyUp/char to *that* webcontents until it sees its next keyDown, before
   electron emits before-input-event. the flag survives focus changes. tap 1 (A -> B):
   A's Tab keyDown is handled, focus moves to B (clean), ctrl keyUp reaches B, commit ok,
   but A keeps the flag. tap 2 (B -> A): focus moves back to A, ctrl keyUp is dropped
   in A, so the walk never commits; tap 3 continues the stale walk and lands on a third
   tab ("switching back doesn't work", drift). same in the ui webcontents (palette open,
   focus stays where the handled keyDown happened). fix: after each walk step,
   `primeTabWalkKeys` sends the keyboard owner a keyDown of the still-held modifier
   (clears the flag; the page sees a normal ctrl down/up pair).
2. **a missed release was never recovered.** if the keyUp still goes missing (released
   in an unwired surface, renderer not up yet), the walk stayed open until blur, and the
   next ctrl+tab continued it. the native-menu path (`cmd('mruNext')`) also continued a
   stale walk. fix: a fresh non-repeat keyDown of a hold modifier ends any open walk
   first (`holdRepressed`), and menu dispatch always finishes before stepping.
3. minor: `TabMRU.step` jumped back to the top of the walk when the previewed tab
   disappeared mid-walk; it now continues from the closed tab's slot.

before fix (native): a, b, c, c2, c3, d1, d4, e, f1, f2 fail; d2, d3, d5 pass. after: all pass.

## a5 esc cancel (follow-up)

before: esc during a held walk was not special. with a real keyboard (ctrl still held,
so esc arrives flagged ctrl) it fell through to the page/palette and the walk stayed
open until the ctrl release committed the previewed tab; with a synthetic esc that lacks
the ctrl flag, `holdReleased` read it as "released elsewhere" and committed at once.
either way the switch happened. fix: `TabMRU` remembers the walk's start tab and gets
`cancel()` (drops the walk, returns the start, no recency change); window.js
`wireTabKeys` checks `cancelsWalk(input)` before the release check, `preventDefault()`s
the esc keyDown and its keyUp, and `cancelTabWalk()` goes back to the start tab as a
preview (no touch) and re-primes it so the coming modifier keyUp lands cleanly.
if the start tab was closed mid-walk, esc commits where the walk is.
tests: unit `a5` cases, `scripts/shortcuts-test.mjs` (mocked window), native scenario
`a5` (ctrl+tab and a cmd+alt+k remap, plus palette open): 4/13 before, 13/13 after.
real keys (cua into `scripts/tab-mru-cua-fixture.mjs`): real ctrl+tab x2 then real
ctrl+esc -> start tab, mru unchanged, esc unseen by pages, release a no-op.
cua cannot post a bare modifier release (no flagsChanged; ctrl+tab arrives as a
ctrl-flagged keyDown only), and this shell has no accessibility trust to post CGEvents,
so in that run the commit is a Control keyUp sent with `webContents.sendInputEvent`,
never esc.
