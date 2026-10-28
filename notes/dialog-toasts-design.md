# page dialogs as toast cards (design, phase 2)

status: design only, nothing built. phase 1 (7912cd3, branch `dialogs`) ships a working stopgap:
page `alert/confirm/prompt` go through a preload -> `sendSync('olive:page-dialog')` ->
`src/main/page-dialogs.js`, answered in a tab-modal centered popup (`src/ui/page-dialog.*`,
scrim over the pane). this doc is the "make it look like the other toast-like notifications" step
the user asked for: "prompts should be show similar to other toast-like notifications beatufully".

mockups: `notes/test-shots/dialog-toasts/{prompt,confirm,alert,long,queued,focus,agent}-{light,dark}.png`,
rendered by `node scripts/dialog-toasts-mockup.mjs` (real olive window in a throwaway fixture
profile; `http://gateway.acme.io` is proxied to a local fixture server, so the url bar and the
cards agree; static html cards from `notes/dialog-toasts-mockup.css` +
`notes/dialog-toasts-scenes.mjs` layered on top). the page is a fake "gateway · agents" page. the
permission card in `queued` is a mockup of the unified look (see 2), not today's card.

review: blind review (#537) applied in this revision: stronger veil and light shadow, no default
"page paused" chip, one header style + 16px padding for every card in the column, "2 tabs
waiting" summary with no shortcut, taller long-message cap with a scrollbar instead of a text hint,
suppression checkbox on its own row, dark focus ring in text color, no hint row. a second blind
pass (#538) checked every reshot scene renders.

## what exists today (the "toast-like" family)

- permission cards (`src/ui/permissions.*`, `src/main/permissions.js`): a transparent
  `WebContentsView` at window bottom-left (`x:12`, 12px from the bottom, 390 wide incl. 12px
  padding, so cards are 366 wide), cards stack upward (`column-reverse`), 12px radius, 1px border,
  soft shadow, bold origin line, muted text, right-aligned small buttons, enter = slide up 18px +
  scale .96 over .24s, leave = fade + drop. window-scoped: they stay put when you switch tabs.
- `#toast` in `src/ui/ui.css`: a dark 12px pill bottom-left of the ui view, 1.4s, for
  "copied" style feedback. not interactive, so not a model for dialogs beyond the corner.

## decisions (proposed)

1. **placement: bottom-left of the tab's own pane**, 12px inset, 366 wide, same as a permission
   card. not window bottom-left: a dialog belongs to one tab, and in a split it must sit on the
   pane that asked. the card's left edge lines up with the pane, not the sidebar.
   - permission cards move to the same anchor (active pane bottom-left) so there is one column:
     dialog card at the bottom (nearest the corner, focused), permission cards above, a collapsed
     "waiting" summary on top. see `queued-*.png`.
   - column taller than the pane: permission cards collapse into the summary line first
     ("2 tabs waiting · 1 permission"), then the dialog's message scrolls. the dialog card never
     shrinks below its field + buttons.
   - why not top-center (chrome/safari): the user clicks something in the page and the answer
     shows up ~500px away in the corner. the veil, the slide-in and the nudge on page click are
     what make the corner work. if the veil isn't perceptible in practice, move to top-center.
2. **look: a permission card, a bit more lifted.** same tokens (bg, border, 12px radius, 13px
   system font, 16px padding), deeper shadow because it blocks (light
   `0 8px 24px rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.08)` + 1px border; dark a bit stronger).
   head row: favicon + "`host` says" (bold). the host is ellipsized in the middle (the
   registrable suffix is the part that matters), port only when non-default. permission cards
   get the same head (favicon + bare host, no scheme) so the column reads as one family.
   no chip by default. the chip slot is used for "waiting for your answer" (1.5s, after the user
   clicks the frozen page) and "agent waiting" (while an agent request is blocked on the tab,
   see 10). message in normal
   text color (it's the page's words, not olive's explanation), `pre-wrap`. buttons: Cancel (plain)
   then OK (filled accent, the enter default), right-aligned, mac order. alert has OK only.
   embedded cross-origin frames keep phase 1's title: "an embedded page at `host` says".
3. **the tab pane gets a veil** (black 10% on light pages / 26% on dark; black vs white picked
   from the page body's background luminance, read by the preload, so a dark page still shows
   it) while a dialog is up: the page is
   truly frozen (its js thread is blocked in `sendSync`), so it should look inert, but no heavy
   scrim, it's a toast not a sheet. clicking the frozen page nudges the card (2px shake, or a
   ring pulse under reduced motion) and keeps focus in the card.
4. **states**: entering (slide up from the pane corner, like permission cards), focused, waiting
   (tab in background: card hidden, sidebar dot), answered (fade + drop .18s, focus back to the
   page), cancelled by navigation/close/crash (card just leaves, page gets the fallback:
   `confirm` false, `prompt` null).
5. **keyboard + focus**: the card takes focus when it appears in the active tab (field for
   prompt with the default selected, OK for confirm/alert), unless the user is typing in olive's
   own ui (palette, url bar), then it waits for that to close. enter = OK, esc = Cancel (alert:
   esc = OK), ⌘. = cancel (mac), tab cycles field -> suppression box -> Cancel -> OK inside the
   card only (focus trap, since the page can't take input anyway). olive shortcuts (⌘T, ⌘L,
   switching tabs) still work; the dialog just waits. no keyboard hint row (mac shows none).
   focus ring: 2px, 2px card-colored gap, accent in light, text color in dark (a mint ring on
   the mint OK button blended). `focus-*.png` shows the ring + the click chip.
6. **queueing**: one dialog per tab at a time (its js thread is blocked, so a tab can't ask
   twice; cross-origin iframes in another process can, they queue behind it per tab, fifo).
   across tabs only the active tab's (or each visible split pane's) card is shown. other tabs'
   dialogs wait: a dot on their sidebar row, plus one collapsed summary card "2 tabs waiting:
   Billing, Docs" (two short titles, then "+n") with a "Show" button (jumps to the oldest). no
   keyboard shortcut in v1: arrow chords are risky while a prompt field has focus. permission
   cards sit between the summary and the dialog card in the same column.
7. **background tabs**: never steal the tab or the window. the dialog waits (no timeout: the
   page asked synchronously and chrome waits too). sidebar row dot in the dark accent
   (`#245e40` light, `#a4d6b6` dark) with a tooltip "waiting for an answer" (a tiny
   speech-bubble glyph instead of a dot is an option, since a dot also reads as unread/audio);
   if the tab is in a collapsed group, the group header gets it. plus the live-region
   announcement. no dock bounce, no system notification: the page asked, not the user.
8. **suppression**: from the 3rd dialog in one page load, the card shows "Don't let this page
   ask again" as a checkbox on its own row above the buttons, in normal text color (it's a
   control; on the action row it sat 23px from Cancel and would wrap in other locales) (phase 1 logic, `PageCounter`). checked + any
   answer = the rest of this page load gets fallbacks at once. a reload resets it.
9. **long messages**: message capped at `min(320px, 45% of pane height)` with a 24px fade-out
   at the bottom and a thin overlay scrollbar (no text hint); it scrolls inside, buttons always
   visible. text is selectable and
   ⌘C copies. text over 10000 chars is clipped (phase 1 `normalize`).
10. **agents and cdp (important caveat)**: our override never reaches chromium's dialog code,
    so CDP `Page.javascriptDialogOpening` never fires; playwright `page.on('dialog')` won't see
    it, and an agent's `eval` that triggers a dialog hangs until a human answers. proposal:
    - agent api: `GET /tabs` and `GET /tabs/:id` get `dialog: { id, kind, title, message, value, since }`
      for a pending one; `POST /tabs/:id/dialog {accept: bool, text?}` answers it (same path as
      the card, the card leaves). a dialog raised while an agent request is in flight on that tab
      also shows a chip "agent waiting" on the card so the human knows who's blocked.
    - optional later: emit a synthetic `Page.javascriptDialogOpening` to cdp clients and honor
      `Page.handleJavaScriptDialog` for that tab, so playwright scripts keep working. needs
      the cdp passthrough to intercept; more work, open decision.
    - agent `eval` should not wait forever: the agent api returns
      `{ blockedByDialog: {...} }` after a short wait instead of hanging. see `agent-*.png`.
    - per-session policy `dialogs: "ask" | "dismiss" | "accept"` (default ask) so unattended
      agents never hang: dismiss = fallback at once, accept = OK / default text.
11. **accessibility**: card is `role="alertdialog"`, `aria-labelledby` = title,
    `aria-describedby` = message; voiceover reads "gateway.acme.io says, Agent name…, text field".
    a polite live region announces "Billing is waiting for an answer" for background tabs.
    contrast: all text ≥ 4.5:1 on both themes (muted dark `#b2bbb5` on `#252927` is ~8:1).
    buttons have visible focus rings (see 5).
12. **reduced motion**: no slide/scale, plain 120ms opacity fade; the "nudge" becomes a ring
    pulse instead of a shake.

## implementation sketch (when ok'd)

- keep `src/main/page-dialogs.js` (queue, sendSync, counters, cancel on nav/close) as is. change
  `layout()` to a small view at the pane's bottom-left (height from the card's content via ipc
  `olive:page-dialog-size`) instead of covering the pane, and add a pane-sized veil (can be the
  same view with a transparent top area, or the ui view's pane overlay).
- one shared "toast column" placement helper used by `permissions.js` and `page-dialogs.js` so
  they stack without overlapping.
- sidebar dot: `w.state()` gets `dialog: true` per tab, `src/ui/ui.js` row renderer adds the dot.
- agent api endpoints in `src/main/agent-api.js` as above; tests in `tests/page-dialogs.test.js`
  and the native suite (`scripts/page-dialogs-native-test.mjs`) extended with layout + api checks.

## open decisions for the user

the reviewer's recommendation is next to each; the doc above already assumes it.

1. placement: bottom-left of the pane (recommended, with the stronger veil + nudge) vs top-center
   of the pane (chrome/safari spot) vs keep phase 1's centered card?
2. veil on the frozen page: yes at 10% / 26% (recommended), or no tint?
3. permission cards move to the pane corner too, tab-scoped, sharing one column with dialogs?
   (recommended yes, only together with the unified header; otherwise two corners is better)
4. background tabs: sidebar dot + live region only (recommended), or also dock bounce / system
   notification when the window isn't focused?
5. agents: api endpoints + `blockedByDialog` + per-session `dialogs` policy now (recommended);
   fake cdp dialog events for playwright only if someone needs them?
6. sidebar marker: plain dot, or a tiny speech bubble?

settled by the review (no longer open): no keyboard hint row; no shortcut on the summary card
in v1.
