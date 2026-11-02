# tab rename: triggers (item 3 follow-up, 2026-11-02)

dj confirmed two triggers. what olive does now, and the gaps dj should decide.

## triggers

1. **double-click the tab name** (src/ui/ui.js sidebar `dblclick`): renames when the target
   is inside `.row .title`. works the same on unpinned rows, pinned rows (`#pinned` renders
   ordinary rows with a `.title`) and rows inside a split. not the favicon, not the close x,
   not ↺ / audio (`[data-act]`). a group header double-click still renames the group.
2. **enter on the selected tab** (ui.js window `keydown` → `enterRenameTarget`, pure rule in
   src/ui/rename-keys.js): renames when all of these hold:
   - plain Enter: no shift / cmd / ctrl / alt, not a key repeat, not an IME composition commit
   - the keyboard is in the sidebar: `document.hasFocus()` in the ui view **and** main says
     the ui webcontents is the focused one (`olive.invoke('uiFocused')`, since hasFocus can
     be true in a ui view that isn't focused)
   - no palette open, no field focused (find bar, group / tab rename, any input, textarea,
     select, button, contenteditable), no rename already open
   - exactly one tab selected (`sel`), and it still exists
3. Rename Tab… in the tab context menu (unchanged).

in the field: enter commits, esc cancels, blur commits, empty = page title (unchanged).

## what "selected" means today (the gap)

a plain row click activates the tab **and moves native focus into the page**
(window.js `activate` → `tab.wc.focus()`), so after a plain click enter goes to the page,
not the sidebar. enter-to-rename therefore works after:
- ⌘-click (or ⇧-click) on one row: selects it, the keyboard stays in the sidebar
- the selection surviving while focus is in the sidebar (e.g. after a sidebar button)

it does **not** fire after a plain click on a tab (keyboard is in the page; enter there
belongs to the page: forms, textareas, contenteditable).

## open questions for dj

- should a plain click on the *already active* tab keep the keyboard in the sidebar so
  enter renames it (finder-like), at the cost of page typing needing a click into the page?
  (not done: changes focus behavior for every tab click.)
- several selected tabs + enter: today nothing. rename the first? (finder does nothing.)
- arrow keys to move the selection in the sidebar don't exist yet; with them enter-to-rename
  would be reachable without the mouse.
- pre-existing, not changed: an open group rename field commits on blur even if the group
  was renamed elsewhere meanwhile (e.g. ⌃⌘N field still open while an agent names it).
