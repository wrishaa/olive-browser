// tab groups: the pure list/group model shared by window.js (electron) and the unit
// tests (no electron). a state looks like
//   { pinned: [ids], unpinned: [ids], agent: [ids], agentOrder: [groupIds],
//     tabs: Map<id, {id, pinned, groupId, splitId}>, groups: Map<id, group> }
// a group's tabs are a contiguous run in one list (unpinned for the user's groups,
// agent for the agents'); the agent section's order of groups is agentOrder, so an
// empty agent group keeps its place. design: notes/tab-groups-mac-design.md.
'use strict';

const AGENT_GRACE_MS = 2 * 60 * 1000; // working / empty agent groups outlive the last api call this long
const NAME_MAX = 60;
const DEFAULT_NAME = 'Untitled Group';

let nextGroupId = 1;

function makeGroup({ name, agent = false, status = '', collapsed = agent, working = false, now = Date.now() } = {}) {
  return {
    id: nextGroupId++,
    name: cleanName(name) || (agent ? '' : DEFAULT_NAME),
    agent: !!agent,
    working: !!working,
    status: cleanStatus(status),
    collapsed: !!collapsed,
    renamedByUser: false,
    lastAgentCall: agent ? now : 0,
    created: now,
  };
}

// 1-60 chars, one line, trimmed; null when nothing usable is left
function cleanName(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return t.length ? t : null;
}

function cleanStatus(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// agents that send no name get "Agent", "Agent 2", …
function agentDefaultName(st) {
  const taken = new Set([...st.groups.values()].map((g) => g.name));
  if (!taken.has('Agent')) return 'Agent';
  for (let n = 2; ; n++) if (!taken.has(`Agent ${n}`)) return `Agent ${n}`;
}

function listNamed(st, name) {
  return name === 'pinned' ? st.pinned : name === 'agent' ? st.agent : st.unpinned;
}

function listNameOf(st, tab) {
  if (tab.pinned) return 'pinned';
  const g = tab.groupId != null ? st.groups.get(tab.groupId) : null;
  return g && g.agent ? 'agent' : 'unpinned';
}

function listOf(st, tab) {
  return listNamed(st, listNameOf(st, tab));
}

function allIds(st) {
  return [...st.pinned, ...st.unpinned, ...st.agent];
}

function members(st, gid) {
  const out = [];
  for (const list of [st.unpinned, st.agent]) for (const id of list) if (st.tabs.get(id)?.groupId === gid) out.push(id);
  return out;
}

function removeFromLists(st, ids) {
  const set = new Set(ids);
  for (const list of [st.pinned, st.unpinned, st.agent]) {
    for (let i = list.length - 1; i >= 0; i--) if (set.has(list[i])) list.splice(i, 1);
  }
}

// where a tab appended to group `gid` goes: right after the group's last member, or,
// for an empty agent group, after the members of the agent groups before it in agentOrder
function appendIndex(st, gid) {
  const g = st.groups.get(gid);
  if (!g) return null;
  const list = g.agent ? st.agent : st.unpinned;
  const mem = members(st, gid);
  if (mem.length) return { list: g.agent ? 'agent' : 'unpinned', index: list.indexOf(mem[mem.length - 1]) + 1 };
  if (!g.agent) return { list: 'unpinned', index: list.length };
  const before = st.agentOrder.slice(0, st.agentOrder.indexOf(gid));
  let idx = 0;
  for (let i = 0; i < list.length; i++) if (before.includes(st.tabs.get(list[i])?.groupId)) idx = i + 1;
  return { list: 'agent', index: idx };
}

// put tabs into a list at index (index counted in the destination without the moved
// tabs), with the given group. keeps split runs together: callers pass whole splits.
function place(st, ids, { list, index, groupId = null }) {
  if (list === 'pinned') groupId = null; // the pinned strip is flat (decision 7.1)
  const g = groupId != null ? st.groups.get(groupId) : null;
  if (groupId != null && !g) groupId = null;
  const name = list || (g ? (g.agent ? 'agent' : 'unpinned') : 'unpinned');
  if (g && g.agent && name !== 'agent') return place(st, ids, { list: 'agent', index, groupId });
  if (g && !g.agent && name !== 'unpinned') return place(st, ids, { list: 'unpinned', index, groupId });
  if (!g && name === 'agent') return place(st, ids, { list: 'unpinned', index: st.unpinned.length, groupId: null });
  removeFromLists(st, ids);
  const dst = listNamed(st, name);
  const at = Math.max(0, Math.min(index ?? dst.length, dst.length));
  dst.splice(at, 0, ...ids);
  for (const id of ids) {
    const t = st.tabs.get(id);
    if (!t) continue;
    t.pinned = name === 'pinned';
    t.groupId = name === 'pinned' ? null : groupId;
  }
  if (g) fixContiguity(st, g.id);
  return { list: name, index: at, groupId: name === 'pinned' ? null : groupId };
}

// a group's members must be one run. if a placement split a run (a drop index inside
// another group, say), pull the strays next to the first member.
function fixContiguity(st, gid) {
  const g = st.groups.get(gid);
  if (!g) return;
  const list = g.agent ? st.agent : st.unpinned;
  const mem = list.filter((id) => st.tabs.get(id)?.groupId === gid);
  if (mem.length < 2) return;
  const first = list.indexOf(mem[0]);
  let contiguous = true;
  for (let i = 0; i < mem.length; i++) if (list[first + i] !== mem[i]) { contiguous = false; break; }
  if (contiguous) return;
  const rest = list.filter((id) => st.tabs.get(id)?.groupId !== gid);
  const at = Math.min(first, rest.length);
  rest.splice(at, 0, ...mem);
  list.length = 0;
  list.push(...rest);
}

// a group's members leave it, staying where they are at list level (user group) or
// going to the end of the user's loose tabs (agent group: there is no "below" there)
function ungroup(st, gid) {
  const g = st.groups.get(gid);
  if (!g) return [];
  const mem = members(st, gid);
  if (g.agent) place(st, mem, { list: 'unpinned', index: st.unpinned.length, groupId: null });
  else for (const id of mem) st.tabs.get(id).groupId = null;
  dropGroup(st, gid);
  return mem;
}

// tabs leave their group: user-group members go just below their group, agent members
// to the end of the loose tabs
function removeFromGroup(st, ids) {
  const byGroup = new Map();
  for (const id of ids) {
    const t = st.tabs.get(id);
    if (!t || t.groupId == null) continue;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(id);
  }
  for (const [gid, moved] of byGroup) {
    const g = st.groups.get(gid);
    const mem = members(st, gid);
    const last = mem[mem.length - 1];
    if (g.agent) place(st, moved, { list: 'unpinned', index: st.unpinned.length, groupId: null });
    else {
      const idx = st.unpinned.indexOf(last) + 1 - moved.filter((id) => st.unpinned.indexOf(id) <= st.unpinned.indexOf(last)).length;
      place(st, moved, { list: 'unpinned', index: idx, groupId: null });
    }
  }
  prune(st, { by: 'user' });
  return [...byGroup.keys()];
}

function dropGroup(st, gid) {
  st.groups.delete(gid);
  const i = st.agentOrder.indexOf(gid);
  if (i >= 0) st.agentOrder.splice(i, 1);
}

// remove groups that lost their last tab. by: 'user' removes any empty group at once;
// 'agent' keeps a working agent group for the grace window (open → read → close → open).
function prune(st, { by = 'user', now = Date.now() } = {}) {
  const removed = [];
  for (const g of [...st.groups.values()]) {
    if (members(st, g.id).length) continue;
    if (g.agent && by === 'agent' && g.working && now - g.lastAgentCall < AGENT_GRACE_MS) continue;
    if (g.agent && by === 'tick' && now - g.lastAgentCall < AGENT_GRACE_MS) continue;
    dropGroup(st, g.id);
    removed.push(g.id);
  }
  return removed;
}

// periodic: working ends 2 minutes after the last api call; empty agent groups go then too
function expire(st, now = Date.now()) {
  let changed = false;
  for (const g of st.groups.values()) {
    if (g.agent && g.working && now - g.lastAgentCall >= AGENT_GRACE_MS) { g.working = false; changed = true; }
  }
  if (prune(st, { by: 'tick', now }).length) changed = true;
  return changed;
}

// an api call touched the group: it is working again
function touch(st, gid, now = Date.now()) {
  const g = st.groups.get(gid);
  if (!g || !g.agent) return;
  g.lastAgentCall = now;
  g.working = true;
}

// the row order the sidebar shows: pinned, the user's list, the agent section; members
// of a collapsed group are skipped unless the group is `through`
function visibleOrder(st, { through = null } = {}) {
  const out = [];
  for (const id of allIds(st)) {
    const t = st.tabs.get(id);
    if (!t) continue;
    const g = t.groupId != null ? st.groups.get(t.groupId) : null;
    if (g && g.collapsed && g.id !== through) continue;
    out.push(id);
  }
  return out;
}

// ⇧-click: the range between anchor and target over the visible rows; a collapsed
// group's members join only when the anchor is inside that group
function rangeSelect(st, anchor, target) {
  const at = st.tabs.get(anchor);
  const order = visibleOrder(st, { through: at?.groupId ?? null });
  let a = order.indexOf(anchor);
  let b = order.indexOf(target);
  if (a < 0 || b < 0) return b >= 0 ? [target] : [];
  if (a > b) [a, b] = [b, a];
  return order.slice(a, b + 1);
}

// the snapshot's view of a group: the agent status, or olive's fallback while something loads
function statusShown(st, g, tabsById = st.tabs) {
  if (g.status) return g.status;
  if (!g.agent) return '';
  const mem = members(st, g.id);
  for (let i = mem.length - 1; i >= 0; i--) {
    const t = tabsById.get(mem[i]);
    if (t?.loading && t.host) return `loading ${t.host}`;
  }
  if (!mem.length && g.working) return 'starting…';
  return '';
}

module.exports = {
  AGENT_GRACE_MS, NAME_MAX, DEFAULT_NAME,
  makeGroup, cleanName, cleanStatus, agentDefaultName,
  listNamed, listNameOf, listOf, allIds, members, removeFromLists, appendIndex, place, fixContiguity,
  ungroup, removeFromGroup, dropGroup, prune, expire, touch, visibleOrder, rangeSelect, statusShown,
};
