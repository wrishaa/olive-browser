# olive tab groups: mac-native design spec (v2)

author: fable design owner (task #499, model id `claude-fable-5-1`). date: 2026-10-28.
v2: agent groups moved to their own section at the bottom of the sidebar (user decision),
the six open questions closed as decisions (sec 7), blind review + fixes (sec 10).
spec + static prototype + shots only; no app code. follows `notes/onboarding-mac-design.md`
(sec 0, 2.2, 5.3, 8) for tokens, type and voice.

user, verbatim: "i think what would be nice is to have a tab grouping feature (see Dia
browser designs from Arc creators), where i can select tabs and move them into groups (or
create new ones), closing all tabs from a group clears it too, then if agent needs to
create new tabs, it can just create a new group and work inside. it will also make the
sidebar clean too as groups should be collapsible. and agent can start with auto
collapsed groups. but the form factor / design must be impeccable". also: "tabs showing
up on sidebar is fine".

prototype: `notes/tab-groups-proto/index.html?scene=…&w=252|180&mode=sidebar|full`
(links the real `src/ui/ui.css`; `groups.css` is the exact css to append to `ui.css`).
shots: `notes/test-shots/tab-groups/*.png` (2x, rendered by `shoot.mjs` with the cached
playwright chromium headless shell). sources read: sec 9.

---

## 0. the model, in one paragraph

a group is an **outline node in the unpinned list**, exactly like a folder in Notes or a
mailbox in Mail: one header row (disclosure triangle, bold name) followed by its member
tab rows indented one level. no box, no tint, no colour chip, no rail, no emoji. groups
are contiguous runs of the ordered tab list, never nested, never in the pinned section.
a tab belongs to at most one group; a split view lives inside one group. collapsing a
group hides its members and the header stands in for them (favicons, count, active
style if the active tab is inside). **closing the last tab removes the group**; "Close
Group" closes all its tabs and is undone whole with ⇧⌘T. an **agent group** is the same
node with an `agent` flag, but it lives in its own **agent section at the bottom of the
sidebar** (user decision): a hairline, then the agent groups, resting on the bottom edge
above the uBO pill, outside the scrolling tab list. the local api creates it, its tabs
always open in the background, it starts collapsed, it carries a small accent sparkle, a
breathing accent dot while the agent works, and an optional one-line status the agent
sets, so the user sees what is happening without expanding anything, and the user's own
rows never move because an agent opened something.

---

## 1. geometry and type (exact, existing tokens only)

everything is the existing `.row` (36px, radius 9, gap 9, padding `0 6px 0 10px`,
13px SF). the header is a `.row.group-head`; members are plain `.row`s with more left
padding. the whole css is `notes/tab-groups-proto/groups.css` (~110 lines).

| part | spec |
|---|---|
| group block | `display:flex; column; gap:2px; margin:0`; expanded only: `margin:4px 0`. a **collapsed group is one row in the list's 2px rhythm** (Notes' folder list is uniform); an expanded block gets 4px of air (6px to a neighbouring row, 10px to another expanded block) |
| header row | `.row` metrics; `gap:9px` (same as a tab row, so the name starts at x=35 like every tab title); hover `--row-hover`; active (collapsed + holds the active tab) `--row-active` + `--row-active-shadow` |
| disclosure | 16×16 slot where the favicon would be; 10px chevron, 1.6 stroke round caps, `--text-dim` (`--text` on row hover); points right collapsed, rotates 90° in 160ms ease when expanded |
| name | 13/600 `--text`, ellipsis. sentence case, as the user typed it |
| count | 11/400 `--text-dim`, tabular numerals, trailing, **collapsed only** |
| favicon stack | collapsed only: up to 3 member favicons 14×14 radius 3.5, newest first, gap 3, before the count. the active tab's favicon gets a 1.5px `--accent` ring. hidden under 210px sidebar width and whenever an agent status is shown |
| member rows | `padding-left:35px` so the member favicon sits exactly under the header's name (10 + 16 + 9). the hover/active fill still spans the full row width (Finder/Notes behaviour). in an agent group the sparkle pushes the name to x=51, so its members use `padding-left:51px` (split `41`, insertion line `49`) and still sit under the name |
| split inside a group | `.split-group { padding-left:25px }`; member rows inside keep their own 8px padding |
| insertion line (drag) | existing 2px `--accent` line, `left:33px` for members instead of 8 |
| agent sparkle | 13×13 `--accent` two-star glyph between the disclosure and the name, `margin:0 -3px` (name lands at 35 + 13 − 6 + 9 = 51) |
| agent dot | 6px circle `--accent`, trailing (before favicons/count), `breathe` 1.6s ease-in-out opacity 1→.35→1; static under reduced motion. stays on hover. all dots in the section breathe in phase (the section is rebuilt in one innerHTML write, so their animations start together; drift after a partial re-render is accepted) |
| agent status | 11/400 `--text-dim`, ellipsis. when set, the header's text becomes two lines inside the same 36px: name (line-height 15) over status (line-height 13), 1px gap, vertically centred. favicons hide; count stays |
| hover × | existing `.row .close` 22×22. on a header it means **Close Group**, title `Close Group (n tabs)`; it takes only the **count's** slot while hovered, favicons and the dot stay (mac rows add on hover, they do not remove). **no × on a working agent group** (2.6, decision 7.2); none while the header is a drop target |
| selection | `.row.selected { background: var(--palette-sel) }`; the active tab when also selected keeps its lift (`--row-active-shadow`) on `color-mix(--row-active, --accent 10%)`: a faintly tinted lifted row says "showing and selected" with no stroke (macOS never outlines a selection; the only stroke in the sidebar is the drop target, like Finder's) |
| drop target (header) | `background: var(--palette-sel); box-shadow: inset 0 0 0 1.5px var(--accent)`; count/favicons stay visible |
| drag ghost | existing `#drag-ghost` + a trailing count badge 18px capsule `--accent`, 11/600 `--on-accent` (new token: `#fff` light, `#1d2a1f` dark, `#1f1a33` private, since white on the private lavender accent is 2.2:1) when more than one tab is dragged |
| rename field | the name becomes a field in place: height 22, radius 5, `--card` fill, 13/600 `--text` (same face and weight as the name, so nothing thins on entry), `0 0 0 1px var(--line), 0 0 0 3.5px color-mix(--accent 38%)`, margin-left −5 and padding 4 so the text does not move. all text selected on entry |
| empty group | expanded header + one dimmed member row `+ New Tab` (the existing `.newtab-row`, padded 35) |
| narrow (<210px) | `body.narrow`: favicon stacks off; a header with a status line also drops its count (the status carries one word at 180, the count is dim redundancy). nothing else changes |
| agent section | a third sidebar section **below `#tablist`** (so outside its scroll), above the uBO pill: `.divider.agent-divider` (the existing 1px `--line` hairline, margin `0 4px 8px`, no button) then `#agent.list`. `max-height:50%` of the sidebar, scrolls inside itself beyond that (scrollbar width 0 like the tab list), `padding-bottom:8px` so the last row clears the pill. groups inside follow the same rhythm as the list (2px between collapsed groups). the whole section is hidden (`body.no-agent`) when there is no agent group, so a sidebar without agents is pixel-identical to today. while the section exists, `#tablist` gets a 28px bottom mask fade (macOS scroll-edge effect, never cutting a row mid-glyph) so a half-scrolled row never butts against the hairline; `#agent` gets the same fade while it overflows (the renderer sets `.overflows` when `scrollHeight > clientHeight` after each render, so a fourth group is hinted and a last row is never faded). both hairlines end at the same x: the pinned divider is unchanged (its Clear button shortens the line, decision 7.9) and the agent divider reserves the same slot |

two token changes in `ui.css` (the blind review measured the old values, sec 10): `--text-dim`
`#4c584d` → `#3f4b40` light and `#a8b3a5` → `#b0bbad` dark, so 11px dim text holds ≥ 4.5:1 on
the bottom of the light gradient (3.88 → 4.76 at the agent header) and on the dark active row
(4.49 → 4.91); and a new `--on-accent` for text on an accent fill. otherwise no new colours,
no new font sizes, no uppercase, nothing lighter than 400. the dark appearance is the same
css through the existing dark tokens.

---

## 2. the user side: every interaction

### 2.1 selecting tabs

- click = activate (and clears any selection). ⌘-click toggles a tab in/out of the
  selection without activating it. ⇧-click selects the range from the last clicked tab
  over the **visible** rows of the same list (Finder selects what you can see: a collapsed
  group's members join a range only when the range is anchored inside that group; its
  header is skipped, never selected). esc clears.
- selection is visual only (`.selected`); the active tab stays what it was. selecting
  across pinned and unpinned is allowed; a group header is never "selected", it is a
  container (clicking it toggles collapse, see 2.4).
- the selection drives the context menu verbs ("Pin 3 Tabs", "Close 3 Tabs") and drag.

### 2.2 making a group

- **⌃⌘N — New Group with Selection** (Finder's "New Folder with Selection", also dia's
  shortcut). with no selection it groups the active tab. the group is inserted where the
  first selected tab was, named "Untitled Group", expanded, with the rename field open
  and the text selected; return commits, esc keeps the group with the default name.
- context menu on any tab row: **Move to Group ▸** submenu: `New Group with n Tabs  ⌃⌘N` (Finder's "New Folder with Selection (n Items)";
  no ellipsis, nothing opens but the rename field), separator,
  then every group by name (agent groups show the sparkle; when *every* selected tab is
  already in a group, that group shows a ✓ and is disabled). the submenu is a real
  `Menu.popup` submenu.
- drag one or more tabs onto a group header → they join at the end of the group. onto a
  member row → inserted at that position. the header shows the drop-target style (1.1);
  between members the indented insertion line. a collapsed header accepts drops without
  expanding (hover-to-expand after 600ms, like Finder spring-loaded folders, is a
  **should**, not needed for v1).
- dragging a member to the list level (pointer x left of the member indent, or below the
  group's last member) takes it out of the group. the ghost reads "Move out of Research"
  while that would happen, the way it reads "Open in split view" today.
- **Remove from Group** in the context menu moves the tab(s) to just below the group. it
  is enabled when at least one selected tab is grouped and acts on those only.
- pinning a member (menu or drag to the pinned section) takes it out of the group;
  groups exist only in the unpinned list and the agent section (decision 7.1).
- a tab dropped on an agent group's header (bottom section) joins it like any group; the
  tab leaves the user's list. "Remove from Group" on an agent member puts it at the end
  of the user's loose tabs (there is no "below the group" in the agent section).

### 2.3 renaming

- double-click the name, or **Rename** in the header's context menu, or return when the
  header has keyboard focus (the sidebar has no focus model yet; the first two are v1).
- in-place field (1.1). return / click elsewhere commits; esc reverts; an empty name
  reverts to the previous one. 1–60 characters, no newline. names are plain text; no
  icon or emoji picker.

### 2.4 collapse and expand

- click anywhere on the header toggles. ⌥-click toggles **all** groups the same way
  (NSOutlineView convention). the triangle animates 160ms; members appear without any
  other animation.
- the collapsed header shows the newest three favicons and the count. if the active tab
  is inside, the header takes the active style and that favicon is ringed, so the row
  that "is the page" is always visible in the sidebar even when it is folded away.
- keyboard tab cycling (⌃Tab, ⇧⌘[ ]) runs through collapsed members too; landing on one
  **expands its group** and it stays expanded (decision 7.4: no peek surface in v1). the
  agent never expands anything. the cycle order is the visual order: pinned, the user's
  list, then the agent section.
- "Collapse Other Groups" in the header menu. collapse state persists in session state.

### 2.5 reordering

- drag a header to move the whole group (ghost = chevron glyph + name + count badge);
  drop positions are between top-level items only, never inside another group. agent
  group headers reorder **within the agent section only**; a group never crosses the
  hairline in either direction (ungroup + regroup is the way, and it is two clicks).
- members reorder inside their group with the existing drag; dropping on a *different*
  group's member moves the tab across groups.

### 2.6 closing

- ⌘W / hover × on a member closes that tab; **closing the last member removes the
  group** (user rule). the next active tab is picked by the existing rule.
  one carve-out, because an agent opens, reads and closes as it goes: an **agent-initiated**
  close (`POST /tabs/:id/close` from the api) that empties a *working* agent group keeps the
  group for the 2-minute `lastAgentCall` window (header stays, status kept, no favicons or
  count), then it is removed; a user close of the last member removes it at once, as does
  `PATCH working:false` on an empty group (3.3).
- hover × on the header or "Close Group" in its menu: all member tabs close and the group goes to the closed stack **as one entry**, so ⇧⌘T
  brings back the group, its name, its order and its collapse state. no confirmation
  sheet; undo is the safety (decision 7.2: × means close, everywhere on the mac; collapse
  already has the chevron and the whole header as its click target). **a working agent
  group shows no hover ×**: closing it kills the run, and ⇧⌘T brings back the tabs but
  not the run, so that undo is not complete; Close Group stays in its menu, and the ×
  returns once `working` is false.
- **Ungroup (Keep Tabs)**: removes the header, members stay in place at list level.
- the divider's "Clear" closes the **loose** unpinned tabs only; groups, the user's and
  the agents', stay (decision 7.6). its tooltip becomes "Close loose tabs" and the
  button hides when there are none. groups go with Close Group / Ungroup, one click away.

### 2.7 context menus (native `Menu.popup`, exactly these)

tab row (n = selection size, "Tab"/"Tabs"):

```
Move n Tabs to Group        ▸   New Group with n Tabs   ⌃⌘N
Remove from Group                ─────────────────
─────────────────                ✓ Research
Pin n Tabs                       ✦ Flights to Lisbon
Duplicate
Copy Links
Reload
Mute
─────────────────
Open in Split View with Current Tab
─────────────────
Open in New Window
─────────────────
Unload (Free Memory)
Close n Tabs
Close Other Tabs
```

group header:

```
New Tab in Group
Rename
─────────────────
Collapse / Expand
Collapse Other Groups
─────────────────
Copy All Links
Ungroup (Keep Tabs)
─────────────────
Close Group
```

the prototype mocks these as macOS menus (13px, 22px items, radius 10, system-blue
highlight because the real menu takes the user's system accent, not olive's green).
no key next to Rename: return-to-rename needs a sidebar focus model that is not v1 (2.3),
and Finder shows none either.

### 2.8 pinned tabs and split views

- pinned section: flat, as today. no groups there in v1 (decision 7.1); dia's "pinned
  tab groups" (arc folders) can come later without changing anything here.
- a split is one row inside one group. splitting a member with a tab from outside moves
  the outside tab into the group next to it (the current "keep the split contiguous"
  rule, applied to groups). splitting two tabs from different groups moves the second into
  the first's group. "Remove from Split View" leaves the tab in the group.
- collapsing a group that holds the active split: header active; the panes stay.

### 2.9 keyboard summary

| keys | action |
|---|---|
| ⌘-click / ⇧-click | toggle / range select |
| ⌃⌘N | New Group with Selection (or the active tab) |
| ↩ / esc (in rename) | commit / revert |
| ⌥-click header | collapse or expand all groups |
| ⌘W | close tab; last tab closes the group |
| ⇧⌘T | reopen the last closed tab **or group** |
| esc | clear selection |

no new global shortcut beyond ⌃⌘N. "Move to Group" has no shortcut; the menu is enough.

---

## 3. the agent side

### 3.1 behaviour

- an agent that wants tabs asks for a group: everything it opens lands in that group,
  **collapsed by default**, **always in the background** (`activate:false` is forced;
  `background` is ignored for grouped tabs). the user's active tab, scroll, focus and
  sidebar scroll position never change because of agent work.
- **where**: every agent group lives in the agent section at the bottom of the sidebar
  (user decision). new groups append at the bottom of that section (newest nearest the
  edge, like a new line in a log); the user's list above is untouched. the section sits
  outside the scrolling tab list, so a long list never pushes it out of view; it takes at
  most half the sidebar and scrolls inside itself past that (three collapsed agent groups
  take 112px, 120 with the section's padding; the user is not expected to run ten
  agents at once). with no agent group
  the section and its hairline do not exist.
- a tab an agent opens **without** a group (`POST /tabs {url}`) behaves exactly as today:
  loose, in the user's list. v1 does not move it; a later `agentTabsDefaultGroup` setting
  can route those into an "Agent" group at the bottom.
- the header shows: sparkle (this was made by an agent), name, status (if any), the
  breathing dot while working, favicons + count when collapsed and no status.
- "what is the agent doing without expanding?" three layers, in order of cost:
  1. the status line the agent sets ("comparing 3 fares", "done · cheapest $612").
     short, present tense, no trailing period, max ~40 chars; it is the second line of
     the header. when the agent sets none, olive shows the host of the newest loading
     tab ("loading air.example.com") while something loads, and nothing once idle
     (decision 7.3).
  2. **only when there is no status line**: the favicon stack (newest first) with the
     loading spinner in the newest slot while that page loads. the count ticks up as
     tabs open either way.
  3. the tooltip: `Flights to Lisbon · opened by an agent · 5 tabs`.
- **working → done**: the dot disappears; the status stays until the agent changes it
  or the user renames/ungroups. `working` also clears by itself 2 minutes after the last
  api call that touched the group (agents forget to say done; a stuck pulse is worse than
  a missing one).
- the agent never activates a tab unless it calls `POST /tabs/:id/activate` explicitly;
  that call focuses the window and expands the group, because it is an explicit ask.
- the user can do everything to an agent group they can do to their own: rename, move
  tabs in or out, collapse, close. after a user edit the sparkle stays (provenance), the
  status is kept, nothing else is special.
- closing the group while the agent is still working (Close Group in the header menu;
  there is no hover × on a working group, 2.6): tabs close; subsequent api calls on those
  tab ids get 404 like today; the agent's next `POST /tabs` with the same group id gets
  404 and must create a new group. no "are you sure".
- the agent closing its own tabs never loses the group: a `working` agent group that the
  agent empties stays (header, status, no count) for the 2-minute `lastAgentCall` window,
  so open → read → close → open keeps working. a user closing the last member removes it
  at once.

### 3.2 naming

- the agent **must** name the group when it creates it (`name`, 1–60 chars, a task noun
  phrase: "Flights to Lisbon", "Stripe webhooks", "Competitor pricing"). if it sends
  none, olive names it `Agent` / `Agent 2` / `Agent 3`. no model-generated names in olive.
  user-made groups default to "Untitled Group" with the rename field open (decision 7.5).
- the agent may rename later (`PATCH /groups/:id {name}`); a user rename wins
  (`renamedByUser: true` makes later agent renames 409).

### 3.3 local api additions (for the implementer)

```
POST  /groups {name, status?, collapsed?=true}        -> {id, name, agent:true, …}
GET   /groups                                          -> [{id, name, agent, working, status, collapsed, tabIds}]
PATCH /groups/:id {name?, status?, working?, collapsed?}
POST  /groups/:id/close                                -> closes tabs, removes group
POST  /tabs {url, group: <id> | {name, status?}}       -> opens in that group (creates it if {name}); background forced
```

`GET /groups` returns `section: "agent"` for every api-made group (`"list"` for the
user's; the api cannot create those). `describe()` gains `groupId`. `working` is true while any tab in the group is loading or
within 2 minutes of an agent call that set it; `PATCH working:false` ends it at once.
an empty agent group renders collapsed with its status ("starting…" when it never had
one) and is removed when it is still empty 2 minutes after `lastAgentCall`, at once on
`PATCH working:false`, and at once when a **user** close emptied it (2.6).

---

## 4. states covered by the prototype and shots

all at 2x, light and dark, `notes/test-shots/tab-groups/<scene>-<light|dark>-<252|180>[-window].png`.
`-window` is the full 1280×800 window (every scene at 252, the width-sensitive ones at
180 too); the others are sidebar crops (w+56 × 760) for detail:

| scene | what it shows |
|---|---|
| basic (252, 180, +window) | pinned flat; "Research" expanded with the active tab inside; three loose tabs; the agent section at the bottom with one working group |
| collapsed-active (252, 180) | collapsed "Research" holding the active tab: header active, active favicon ringed |
| multiselect | three selected across a group and the list; the active one keeps its fill + ring |
| context-menu | mock native menu for a 3-tab selection with the "Move 3 Tabs to Group" submenu open |
| group-menu | mock native menu on a header |
| drag-into | two tabs dragged (count badge "2") over a collapsed header: drop-target style |
| drag-reorder | one tab dragged between two members: indented insertion line |
| rename | in-place field with text selected |
| agent-working (252, 180, +window) | collapsed agent group at the bottom, sparkle, two-line status, breathing dot |
| agent-active | the active tab is inside the collapsed agent group: the bottom header takes the active style |
| agent-starting | a group the agent just created, no tabs yet: status "starting…", no count |
| two-agents (252, 180) | two agent groups stacked at the bottom, newest last: one done, one working |
| agent-expanded | the same group open, one member loading (spinner in the favicon slot) |
| agent-done | dot gone, status "done · cheapest $612", favicons hidden because status is shown |
| agent-hover | a *working* agent header hovered: row fill, dot and count stay, **no ×** |
| agent-hover-done | a done agent header hovered: × (Close Group) takes the count's slot |
| agent-emptied | a working agent group the agent emptied itself: header and status stay, no count |
| basic-w500, many-groups-w500 | weight study for decision 7.8: group names at 500 instead of 600 |
| empty / empty-named | fresh "Untitled Group" in rename; a named empty group with its `+ New Tab` member |
| long-names (252, 180) | 60-char group name, 80-char tab title, long agent name + status: everything ellipsises, nothing wraps or clips |
| many-groups | eight collapsed groups; the list scrolls while the agent section stays put at the bottom |
| no-groups | nothing grouped and no agent: the sidebar is pixel-identical to today (no hairline, no section) |
| split-in-group | a split pair as one member row of a group |

---

## 5. what not to do

- no coloured group chips/strips (chrome), no emoji or icon pickers, no auto-generated
  icons: the chevron and the bold name are the whole identity. dia even ships an option
  to turn its emoji off.
- no card, border or background behind a group's members. indent is the grouping.
- no nested groups (dia doesn't either), no groups inside the pinned section in v1.
- no agent group among the user's tabs, ever; no sticky or floating "agent tray" with its
  own background (the sidebar is vibrancy, an opaque strip would read as a toolbar).
- no auto-grouping of the user's tabs, no model-named user groups, no "tidy" button.
- the agent never: activates, expands, scrolls the sidebar, steals focus, or shows a toast.
- no confirmation dialogs for Close Group / Ungroup; ⇧⌘T undo instead.
- no second row height: headers are 36 like everything else; the two-line agent header
  lives inside those 36px.
- no "n tabs" capsule badges, no progress bars in the sidebar, no animated favicon
  stacks (only a 120ms crossfade when a favicon changes).
- no web-style multi-select checkboxes or "select all" bars.

---

## 6. acceptance (visual)

1. a collapsed sidebar with five groups reads like Notes' folder list: same row height,
   same type, chevrons aligned at x=10, nothing but names and dim numbers.
2. at 180px nothing clips: no favicons, counts fully visible, names ellipsise.
3. the active tab is visible in the sidebar in every state, collapsed or not.
4. an agent group at work is recognisable at a glance from across the room (dot) and
   readable up close (status) without expanding it; it never moves the user's view.
   it is always at the bottom of the sidebar, in view however long the list is.
5. light and dark are the same css; contrast of every text on its row ≥ 4.5:1 (with the
   `--text-dim` change in sec 1: 4.76 at the bottom of the light gradient, 4.91 on the
   dark active row; computed against the backgrounds the review sampled on the shots,
   which the fix did not change; sec 10).
6. all menus are native. the only drawn controls are the rename field and the chevron.

---

## 7. decisions (were open questions; closed 2026-10-28 on the user's "use your best call")

1. **pinned groups: no in v1.** the pinned strip is a flat set of favourites; groups there
   would need a second model (pinned-but-foldable) for no v1 use case. dia's pinned groups
   exist to absorb arc folders. nothing in this spec blocks adding them later.
2. **hover × on a header closes the group** (undo with ⇧⌘T). × means close everywhere on
   the mac; making it collapse would be the one × that doesn't. collapse already owns the
   chevron and the whole header click. **amended after review: not on a working agent
   group.** undo only justifies a confirm-free × when it is complete, and ⇧⌘T restores the
   tabs with new ids, not the agent's run; that × would also sit 11px above the uBO pill on
   the pointer's way to the footer. Close Group stays in the menu; the × returns when done.
3. **the agent writes the status line; olive derives a fallback.** the agent knows its
   intent ("comparing 3 fares"); olive only knows hosts. with no agent status, olive shows
   "loading <host>" of the newest loading tab while something loads, nothing when idle.
4. **⌃Tab into a collapsed group expands it, and it stays expanded.** the user is
   navigating, they want to see where they are; dia's "peek" is a new surface and a new
   state to explain. the agent never expands anything.
5. **default name is "Untitled Group" with the rename field open.** Finder's "untitled
   folder"; a host-derived name lies the moment the selection mixes two sites, and the
   open field makes naming a one-keystroke habit.
6. **"Clear" skips groups.** groups (the user's and the agents') are deliberate; Clear is
   for the loose mess. clearing an agent mid-task from the tidy-up button would be a nasty
   surprise. tooltip "Close loose tabs"; Close Group is one click away.
7. **agent groups live at the bottom of the sidebar** (user decision). one hairline, then
   the groups, newest last, outside the scroll, max half the sidebar. note for later: an
   active (lifted) agent header sits 11px above the filled uBO pill, two capsules of
   different radius (9 vs 7); if the pill ever moves into the footer row the bottom reads
   cleaner. not a change now.
8. **group names stay 13/600** (the review asked for a 500 study: `basic-w500`,
   `many-groups-w500`). at 13px SF, 500 is barely apart from the 400 tab titles, and unlike
   Notes, where folders live in their own pane, a collapsed group sits in the same list as
   loose tabs with only a 10px chevron as its container cue; 600 is what keeps "Research"
   and "Design review notes" from reading as two tabs. the list reads a little heavier than
   Notes' folder list; accepted.

9. **the pinned hairline stays as it is today** (user decision, 2026-10-28, on the build's one open
   question): the agent hairline matches it rather than both being redrawn under the Clear
   button. less churn; the two lines still end at the same x (the agent divider reserves the
   Clear button's slot with an invisible twin, and Clear keeps its slot when it has nothing to
   do; checked in the native test "both hairlines span the same width").

---

## 8. for the implementer (short)

- model: `groups: Map<id, {id, name, agent, working, status, collapsed, renamedByUser, lastAgentCall}>`;
  tabs get `groupId`. unpinned order is still one array; a group's tabs are a contiguous
  run and `listHtml` wraps that run in the `.group` markup (`groups.css` + `proto.js`
  `groupHtml()` are the reference). `moveTab` gets `groupId` as a target.
- a third ordered list `agent[]` next to `pinned[]`/`unpinned[]` holds the agent groups'
  tab ids; the renderer puts it in `#agent` under `#tablist` (see `index.html` in the
  proto). drag/drop and tab cycling treat it as the list after `unpinned`.
- selection lives in the renderer; main receives id arrays for menu verbs and drops.
- closed stack entry kind `group` restores name/order/collapsed; `closeGroup()` pushes one.
- after each render: `#agent.classList.toggle('overflows', scrollHeight > clientHeight)`.
- `ui.css`: `--text-dim` and `--on-accent` as in sec 1; `.divider` Clear button overlays
  the line. `--row-hover`'s own 1px of `.divider button` fill is `--bg2`.
- api close (`POST /tabs/:id/close`) vs user close must be distinguishable in `closeTab`
  (a `by: 'agent'|'user'` arg) for the empty-group rule in 2.6/3.3.
- `tabMenu(ids)` and new `groupMenu(id)` build the templates in 2.7.
- session state: groups persisted next to `splits`.

---

## 9. sources read

- dia changelog (diabrowser.com/changelog, 1.47.1–1.54.0, 2026): ⌃⌘N "New Group with
  Selected Tabs" matching Finder; pinned tab groups; "peeked" tab groups; automatic tab
  groups with an option for calmer (non-emoji) icons; "Match Sidebar Typography to
  macOS"; contrast between pinned tabs and expanded groups; close-all-unpinned button.
- arc help center, "Move from Arc to Dia" (2026-10-21): folders → named pinned tab
  groups, nested folders flattened because dia doesn't nest.
- arc 2023/2024 release notes (search "folders"): ⌘-click multi-select then right-click or
  ⌘T "New Folder"; drag a tab onto another = split view; collapsible pinned section.
- `notes/test-shots/references/dia-home.png` + sec 8 of the onboarding spec: 13px rows,
  16pt icons, bold for folders, dimmed trailing labels.
- macOS conventions: NSOutlineView disclosure triangles (⌥-click = all), Finder
  "New Folder with Selection" ⌃⌘N, in-place rename with selected text, undo over confirm.

---

## 10. blind review (2026-10-28) and fixes

reviewer: a blind fable (`claude-fable-5-1`, high), given the spec, `groups.css`, `proto.js`
and the 104 shots, nothing else. verdict: **PASS with polish**: "reads as a first-party mac
outline (Notes/Mail folder list), not chrome's chips or a web app"; nothing needs a
redesign; three things failed the spec's own bar. all numbers were measured on the 2x
shots. everything below is fixed in the spec, `groups.css`, `proto.js`, and the re-shot
set (120 shots, light + dark, 1280×800 windows at 252 and at 180 where width matters).

blockers (fixed):

1. **contrast**: `--text-dim` `#4c584d` measured 4.61:1 at the top of the light gradient,
   4.40 at "Research 4", **3.88 at the agent header** (bg `rgb(165,193,182)`); dark
   `#a8b3a5` on the active row (`rgb(63,69,69)`) 4.49. fix: token change (sec 1):
   `#3f4b40` light (4.76 at the agent header, 5.62 at the top, 8.3 on the active row),
   `#b0bbad` dark (4.91 on the active row, 6.81 on the sidebar). the proto overrides the
   tokens at the top of `groups.css`; the implementer edits `ui.css`.
2. **agent lifecycle**: "closing the last tab removes the group" killed an agent that opens →
   reads → closes → opens (its second `POST /tabs` got 404). fix: 2.6 and 3.1/3.3 split the
   rule: an agent-initiated close that empties a working group keeps it for the 2-minute
   `lastAgentCall` window; a user close or `PATCH working:false` removes it at once. new
   state `agent-emptied`.
3. **hover × on a working agent group** was a confirm-free destructive action 11px above the
   uBO pill with a lossy "undo" (⇧⌘T restores tabs, not the run). fix: no × while
   `working` (css + proto), the dot stays on hover, Close Group stays in the menu, the ×
   returns when done. decision 7.2 amended; states `agent-hover` (no ×) and
   `agent-hover-done` (×).

polish (all applied unless noted):

1. collapsed groups broke the row rhythm (48px pitch vs 38). fix: `.group { margin:0 }`,
   `4px 0` only when expanded; the agent section's 6px dropped too. measured after: 38.
2. header name 2px left of tab titles (`gap:7`). fix: `gap:9`, name at 35 like every title.
3. agent members did not sit under the agent name (sparkle pushes it to 51). fix: agent
   member padding 51, split 41, insertion line 49; sparkle margin `0 -3px`.
4. hover removed favicons, count and dot (48px content jump). fix: hover hides only the
   count; favicons and dot stay; the × takes the count's slot.
5. two hairlines of two lengths. fix: both span 14 → w−12; the pinned divider's Clear button
   overlays its line.
6. selected+active accent ring read as a web focus ring. fix: tinted lifted row, no stroke.
7. `.drop-into` header also showed the ×. fix: hidden while a drop target.
8. scroll-edge fade too short (14px cut a row mid-glyph); `#agent` had none. fix: 28px on
   both; `#agent` only while it overflows (`.overflows` set by the renderer).
9. rename field thinned the name (600 → 400). fix: the field keeps 600.
10. drag badge text hard-coded white/`#1d2a1f`; private lavender accent gave 2.2:1. fix:
    `--on-accent` token (`#1f1a33` in private, 7.7:1).
11. spec vs proto contradictions: submenu item is "New Group with n Tabs" (no ellipsis, Finder's
    form); no ↩ next to Rename and no "⌘W with a header focused" (no focus model in v1);
    favicon-slot spinner only when there is no status line; "three agent groups in 122px" →
    112 (+8); "10px between groups" → the rhythm rule above; sec 10 now exists.
12. "Remove from Group" on a mixed selection: enabled when ≥ 1 selected tab is grouped, acts
    on those only (2.2).
13. ⇧-click crossing a collapsed group selected hidden members ("Close 7 Tabs" over three
    highlighted rows). fix: ranges run over visible rows; collapsed members join only when
    the range is anchored inside the group (2.1).
14. two agent dots breathing out of phase: accepted and stated (sec 1, agent dot).
15. 180px agent header: count hidden when a status line is present under `body.narrow`.
16. dark drag-ghost shadow nearly invisible on the dark vibrancy: no action for v1.

overturned / amended: 7.2 for working agent groups (above). kept as reviewed: 7.4 (⌃Tab
expands, stays), 7.5 ("Untitled Group" + open rename), 7.6 (Clear skips groups), 7.7
(bottom section; the uBO-pill note recorded there). new 7.8 (weight 600) after the 500 study
the reviewer asked for.

checked on the re-shot set (`basic`, `many-groups`, `*-w500`, `agent-hover`,
`agent-hover-done`, `agent-expanded`, `agent-emptied`, `multiselect`, `two-agents-*-180`,
`context-menu`, `group-menu`, `basic-dark`, `agent-active-dark`): rhythm 38px throughout,
names at 35, both hairlines 14 → 240, agent members under the agent name, no × on the
working header, × on the done header, tinted selected+active row with no stroke, count
hidden at 180 with a status, menu labels as in 2.7. in `many-groups` the 28px fade now
shows the top of the lifted "Q4 roadmap" row as a soft sliver under "Design review notes":
that is the scroll-edge effect doing its job (the row is scrolled under the hairline), not
an artefact.

## 11. built review (2026-10-28, blind fable #516 on built-vs-mockup pairs)

the build on branch `tab-groups` (`src/core/tab-groups.js`, `window.js`, `ui.js`, `ui.css`,
`agent-api.js`) was shot by `scripts/tab-groups-native-test.mjs --shots` into
`notes/test-shots/tab-groups-built/` (light/dark, 252 and 180, mockup|built pairs plus
`contact-sheet-{light,dark}.png`) and reviewed blind against the mockups.

verdict: PASS. measured as identical to the mockups: chevron x 27, bold 13/600 name at 45,
members +25 (favicon 53, title 70), agent members +51 (favicon 69, title 86), 38px pitch
with 4px air around an expanded group, favicon stack 181/198/215 + count 234, agent header
44css two-line with the dot at 214 and the count/× sharing one slot on hover, active pill
10 → 244 at 35 tall, selected and selected+active tints, 180px truncation and hiding, both
hairlines ending at the same x (decision 7.9), light/dark parity.

one verify item: the rename shot was read as still showing a ×. checked by eye (no × in the
shot; the selection band sits behind the name; the field runs to the pill's edge) and the
native test now asserts `getComputedStyle(.close).display === 'none'` while the field is open.

polish taken: the rename scene moves the mouse off the header after the double-click (the
hover tint in the first shot was the harness's cursor). polish noted, no action: 1css
name→status gap and 1css hover-pill delta vs the proto (font rendering in electron vs the
proto browser), collapsed-active pill a hair lighter in light built, dark selected pill a
touch more olive (`--palette-sel`), a faint strip at the sidebar's right edge in the crop
(card shadow, not tab groups).

mockup-wrong, built follows the spec: the active collapsed favicon ring (sec 1), select-all
on rename entry (2.4), spinner only on loading tabs, no scroll fade when the list fits,
three selected across group and list in `multiselect` (sec 4).

fixture artefacts to ignore in the pairs: the first built set read the fixture bottom-up
(pinned and member order reversed, loose tabs above the group); fixed in the harness
(`open()` appends top-down) and reshot.
