// tab groups: the list/group model (src/core/tab-groups.js) and the agent api hooks, with
// fakes only: no electron, no real profile. design: notes/tab-groups-mac-design.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TG = require('../src/core/tab-groups');
const { startAgentApi } = require('../src/main/agent-api');

// ---------- a window-like state ----------

function state() {
  const st = { pinned: [], unpinned: [], agent: [], agentOrder: [], tabs: new Map(), groups: new Map(), nextId: 1 };
  st.add = (opts = {}) => {
    const t = { id: st.nextId++, pinned: !!opts.pinned, groupId: opts.groupId ?? null, splitId: null, loading: !!opts.loading, host: opts.host || 'example.com', url: 'https://example.com/' + st.nextId };
    st.tabs.set(t.id, t);
    TG.listOf(st, t).push(t.id);
    return t;
  };
  st.group = (opts = {}) => {
    const g = TG.makeGroup(opts);
    st.groups.set(g.id, g);
    if (g.agent) st.agentOrder.push(g.id);
    return g;
  };
  return st;
}

test('names: 1-60 chars, one line, trimmed; agents get Agent, Agent 2', () => {
  assert.equal(TG.cleanName('  Flights to\n Lisbon  '), 'Flights to Lisbon');
  assert.equal(TG.cleanName(''), null);
  assert.equal(TG.cleanName('   '), null);
  assert.equal(TG.cleanName('x'.repeat(80)).length, 60);
  assert.equal(TG.makeGroup({ name: '' }).name, TG.DEFAULT_NAME);
  const st = state();
  assert.equal(TG.agentDefaultName(st), 'Agent');
  st.group({ name: 'Agent', agent: true });
  assert.equal(TG.agentDefaultName(st), 'Agent 2');
});

test('a group is a contiguous run; place keeps it so and appendIndex finds its end', () => {
  const st = state();
  const g = st.group({ name: 'Research' });
  const a = st.add(); const b = st.add({ groupId: g.id }); const c = st.add(); const d = st.add({ groupId: g.id });
  // b and d are both in g but c sits between them
  TG.fixContiguity(st, g.id);
  assert.deepEqual(st.unpinned, [a.id, b.id, d.id, c.id]);
  assert.deepEqual(TG.appendIndex(st, g.id), { list: 'unpinned', index: 3 });
  // dropping c onto the header appends it
  TG.place(st, [c.id], { list: 'unpinned', index: 3, groupId: g.id });
  assert.deepEqual(st.unpinned, [a.id, b.id, d.id, c.id]);
  assert.equal(st.tabs.get(c.id).groupId, g.id);
  assert.deepEqual(TG.members(st, g.id), [b.id, d.id, c.id]);
});

test('place into the pinned strip ungroups; a user group never lands in the agent list', () => {
  const st = state();
  const g = st.group({ name: 'Research' });
  const a = st.add({ groupId: g.id }); const b = st.add({ groupId: g.id });
  TG.place(st, [a.id], { list: 'pinned', index: 0, groupId: g.id });
  assert.deepEqual(st.pinned, [a.id]);
  assert.equal(st.tabs.get(a.id).groupId, null);
  assert.equal(st.tabs.get(a.id).pinned, true);
  TG.place(st, [b.id], { list: 'agent', index: 0, groupId: g.id });
  assert.deepEqual(st.agent, []);
  assert.deepEqual(st.unpinned, [b.id]);
});

test('agent groups live in the agent list in agentOrder; an empty one keeps its place', () => {
  const st = state();
  const g1 = st.group({ name: 'Flights', agent: true });
  const g2 = st.group({ name: 'Hotels', agent: true });
  const f1 = st.add({ groupId: g1.id }); const f2 = st.add({ groupId: g1.id });
  assert.deepEqual(st.agent, [f1.id, f2.id]);
  assert.deepEqual(TG.appendIndex(st, g2.id), { list: 'agent', index: 2 });
  const h1 = st.add({ groupId: g2.id });
  assert.deepEqual(st.agent, [f1.id, f2.id, h1.id]);
  // a third group placed first in the order: its tabs go before the others
  const g0 = st.group({ name: 'Early', agent: true });
  st.agentOrder = [g0.id, g1.id, g2.id];
  assert.deepEqual(TG.appendIndex(st, g0.id), { list: 'agent', index: 0 });
  assert.equal(TG.listNameOf(st, st.tabs.get(f1.id)), 'agent');
  assert.deepEqual(TG.allIds(st), [f1.id, f2.id, h1.id]);
});

test('last tab closed clears a user group; prune by user removes any empty group', () => {
  const st = state();
  const g = st.group({ name: 'Research' });
  const a = st.add({ groupId: g.id });
  TG.removeFromLists(st, [a.id]); st.tabs.delete(a.id);
  assert.deepEqual(TG.prune(st, { by: 'user' }), [g.id]);
  assert.equal(st.groups.size, 0);
});

test('agent-close grace: an agent emptying its working group keeps it 2 minutes; a user close removes it at once', () => {
  const now = 1_000_000;
  const st = state();
  const g = st.group({ name: 'Flights', agent: true, working: true, now });
  const a = st.add({ groupId: g.id });
  TG.removeFromLists(st, [a.id]); st.tabs.delete(a.id);
  assert.deepEqual(TG.prune(st, { by: 'agent', now: now + 1000 }), []);
  assert.ok(st.groups.has(g.id), 'kept for the grace window');
  // the periodic tick leaves it inside the window and removes it after
  assert.equal(TG.expire(st, now + 60_000), false);
  assert.equal(TG.expire(st, now + TG.AGENT_GRACE_MS + 1), true);
  assert.equal(st.groups.size, 0);
  assert.deepEqual(st.agentOrder, []);
  // the same, but the user closed the last tab
  const g2 = st.group({ name: 'Hotels', agent: true, working: true, now });
  const b = st.add({ groupId: g2.id });
  TG.removeFromLists(st, [b.id]); st.tabs.delete(b.id);
  assert.deepEqual(TG.prune(st, { by: 'user', now: now + 1000 }), [g2.id]);
  // a done (not working) agent group emptied by the agent goes at once too
  const g3 = st.group({ name: 'Done', agent: true, working: false, now });
  const c = st.add({ groupId: g3.id });
  TG.removeFromLists(st, [c.id]); st.tabs.delete(c.id);
  assert.deepEqual(TG.prune(st, { by: 'agent', now: now + 1000 }), [g3.id]);
});

test('working ends 2 minutes after the last api call; touch restarts it', () => {
  const now = 5_000_000;
  const st = state();
  const g = st.group({ name: 'Flights', agent: true, working: true, now });
  st.add({ groupId: g.id });
  assert.equal(TG.expire(st, now + TG.AGENT_GRACE_MS - 1), false);
  assert.equal(g.working, true);
  TG.touch(st, g.id, now + 60_000);
  assert.equal(TG.expire(st, now + TG.AGENT_GRACE_MS + 1), false, 'the touch moved the window');
  assert.equal(TG.expire(st, now + 60_000 + TG.AGENT_GRACE_MS), true);
  assert.equal(g.working, false);
  assert.ok(st.groups.has(g.id), 'a group with tabs stays when the run ends');
});

test('ungroup keeps user tabs in place; agent members go to the end of the loose tabs', () => {
  const st = state();
  const a = st.add();
  const g = st.group({ name: 'Research' });
  const b = st.add({ groupId: g.id }); const c = st.add({ groupId: g.id });
  const d = st.add();
  assert.deepEqual(TG.ungroup(st, g.id), [b.id, c.id]);
  assert.deepEqual(st.unpinned, [a.id, b.id, c.id, d.id]);
  assert.equal(st.tabs.get(b.id).groupId, null);
  assert.equal(st.groups.size, 0);
  const ag = st.group({ name: 'Flights', agent: true });
  const f = st.add({ groupId: ag.id });
  TG.ungroup(st, ag.id);
  assert.deepEqual(st.agent, []);
  assert.deepEqual(st.unpinned, [a.id, b.id, c.id, d.id, f.id]);
  assert.deepEqual(st.agentOrder, []);
});

test('Remove from Group puts user members just below their group and acts on grouped tabs only', () => {
  const st = state();
  const g = st.group({ name: 'Research' });
  const a = st.add({ groupId: g.id }); const b = st.add({ groupId: g.id }); const c = st.add({ groupId: g.id });
  const loose = st.add();
  TG.removeFromGroup(st, [a.id, loose.id]);
  assert.deepEqual(st.unpinned, [b.id, c.id, a.id, loose.id]);
  assert.equal(st.tabs.get(a.id).groupId, null);
  assert.deepEqual(TG.members(st, g.id), [b.id, c.id]);
  // removing the rest removes the group
  TG.removeFromGroup(st, [b.id, c.id]);
  assert.equal(st.groups.size, 0);
  assert.deepEqual(st.unpinned, [b.id, c.id, a.id, loose.id]);
});

test('⇧-click ranges run over visible rows; a collapsed group joins only when anchored inside it', () => {
  const st = state();
  const p = st.add({ pinned: true });
  const a = st.add();
  const g = st.group({ name: 'Research', collapsed: true });
  const r1 = st.add({ groupId: g.id }); const r2 = st.add({ groupId: g.id });
  const b = st.add();
  assert.deepEqual(TG.rangeSelect(st, a.id, b.id), [a.id, b.id], 'collapsed members skipped');
  g.collapsed = false;
  assert.deepEqual(TG.rangeSelect(st, a.id, b.id), [a.id, r1.id, r2.id, b.id]);
  g.collapsed = true;
  assert.deepEqual(TG.rangeSelect(st, r1.id, b.id), [r1.id, r2.id, b.id], 'anchored inside: its members join');
  assert.deepEqual(TG.rangeSelect(st, b.id, p.id), [p.id, a.id, b.id], 'across pinned and unpinned');
});

test('status fallback: the agent line, else "loading <host>" of the newest loading tab, else nothing', () => {
  const st = state();
  const g = st.group({ name: 'Flights', agent: true, working: true });
  assert.equal(TG.statusShown(st, g), 'starting…', 'empty and working');
  const a = st.add({ groupId: g.id, host: 'a.example' });
  assert.equal(TG.statusShown(st, g), '');
  const b = st.add({ groupId: g.id, host: 'b.example', loading: true });
  a.loading = true;
  assert.equal(TG.statusShown(st, g), 'loading b.example', 'newest loading tab wins');
  g.status = 'comparing 3 fares';
  assert.equal(TG.statusShown(st, g), 'comparing 3 fares');
  const u = st.group({ name: 'Research' });
  assert.equal(TG.statusShown(st, u), '', 'user groups never get a fallback');
  void b;
});

// ---------- the agent api hooks, against a fake window ----------

function fakeTab(id) {
  const tab = { id, title: 't' + id, url: 'https://example.com/' + id, pinned: false, splitId: null, groupId: null, loading: false, host: 'example.com' };
  tab.view = { getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }), setBounds() {} };
  tab.wc = { debugger: { isAttached: () => false, attach() {}, detach() {}, sendCommand: async () => ({ targetInfo: { targetId: 'T' + id } }) }, isLoading: () => false, isDestroyed: () => false, focus() {}, executeJavaScript: async () => 1, on() {}, off() {}, navigationHistory: {} };
  return tab;
}

// the slice of OliveWindow the api touches, over the real model module
function fakeWindow(id) {
  const w = {
    id, isPrivate: false, activeId: null, overlay: null, tabs: new Map(), pinned: [], unpinned: [], agent: [], agentOrder: [], groups: new Map(),
    win: { isFocused: () => false }, nextTab: 100, closed: [], touched: [],
    visibleIds: () => (w.activeId ? [w.activeId] : []),
    allIds: () => TG.allIds(w),
    ensureView() {}, hiddenPaneRect: () => ({ x: 250, y: 8, width: 1000, height: 700 }),
    changed() {},
    activate(tid) { w.activeId = tid; },
    createTab({ url, activate, groupId = null }) {
      const t = fakeTab(w.nextTab++);
      t.url = url;
      const g = groupId != null ? w.groups.get(groupId) : null;
      if (g?.agent) activate = false;
      t.groupId = g ? g.id : null;
      w.tabs.set(t.id, t);
      const at = g ? TG.appendIndex(w, g.id) : { list: 'unpinned', index: w.unpinned.length };
      TG.listNamed(w, at.list).splice(at.index, 0, t.id);
      if (activate) w.activeId = t.id;
      return t;
    },
    closeTab(tid, { by = 'user' } = {}) {
      const t = w.tabs.get(tid);
      if (!t) return;
      w.closed.push([tid, by]);
      TG.removeFromLists(w, [tid]);
      w.tabs.delete(tid);
      if (t.groupId != null) TG.prune(w, { by });
    },
    createAgentGroup({ name, status = '', collapsed = true }) {
      const g = TG.makeGroup({ name: name || TG.agentDefaultName(w), agent: true, status, collapsed, working: true });
      if (!g.name) g.name = TG.agentDefaultName(w);
      w.groups.set(g.id, g);
      w.agentOrder.push(g.id);
      return g;
    },
    touchGroup(gid) { w.touched.push(gid); TG.touch(w, gid); },
    patchGroup(gid, { name, status, working, collapsed } = {}) {
      const g = w.groups.get(gid);
      if (!g) return { error: 'no such group', code: 404 };
      if (name !== undefined) {
        if (!TG.cleanName(name)) return { error: 'name must be 1-60 characters', code: 400 };
        if (g.renamedByUser) return { error: 'renamed by the user', code: 409 };
        g.name = TG.cleanName(name);
      }
      if (status !== undefined) g.status = TG.cleanStatus(String(status ?? ''));
      if (collapsed !== undefined) g.collapsed = !!collapsed;
      if (working !== undefined) { g.working = !!working; if (!g.working) TG.prune(w, { by: 'user' }); }
      else TG.touch(w, gid);
      return { ok: true, group: w.groups.get(gid) || null };
    },
    closeGroup(gid, { by = 'user' } = {}) {
      for (const x of TG.members(w, gid)) w.closeTab(x, { by });
      TG.dropGroup(w, gid);
    },
    groupInfo(g) { return { id: g.id, name: g.name, agent: g.agent, section: g.agent ? 'agent' : 'list', working: g.working, status: g.status, collapsed: g.collapsed, tabIds: TG.members(w, g.id), windowId: w.id }; },
  };
  return w;
}

async function api() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-tab-groups-test-'));
  const w = fakeWindow(1);
  const user = w.createTab({ url: 'https://user.example/', activate: true });
  const mgr = {
    windows: [w], focused: w, cdpPort: null, history: { list: () => [] }, downloads: [],
    focusedWindow: () => w,
    findTab: (id) => (w.tabs.has(id) ? { tab: w.tabs.get(id), win: w } : null),
    allTabs: () => w.allIds().map((id) => ({ win: w, tab: w.tabs.get(id) })),
    agentInfo: () => ({}),
    newWindow() { throw new Error('no new windows in this test'); },
  };
  const server = await startAgentApi(mgr, 0, dir);
  const port = server.address().port;
  const token = fs.readFileSync(path.join(dir, 'agent-token'), 'utf8').trim();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: 'Bearer ' + token, host: '127.0.0.1' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const close = () => new Promise((r) => server.close(r)).then(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { w, user, call, close };
}

test('api: POST /groups makes a collapsed working agent group at the bottom; POST /tabs {group} opens into it in the background', async () => {
  const { w, user, call, close } = await api();
  try {
    const g = await call('POST', '/groups', { name: 'Flights to Lisbon', status: 'comparing 3 fares' });
    assert.equal(g.status, 200);
    assert.equal(g.body.agent, true);
    assert.equal(g.body.section, 'agent');
    assert.equal(g.body.collapsed, true);
    assert.equal(g.body.working, true);
    assert.deepEqual(w.agentOrder, [g.body.id]);
    const t = await call('POST', '/tabs', { url: 'https://air.example/', group: g.body.id, activate: true });
    assert.equal(t.status, 200);
    assert.equal(t.body.groupId, g.body.id);
    assert.equal(t.body.active, false, 'activate is ignored for grouped tabs');
    assert.equal(w.activeId, user.id, 'the user keeps their tab');
    assert.deepEqual(w.agent, [t.body.id]);
    assert.deepEqual(w.unpinned, [user.id]);
    const list = await call('GET', '/groups');
    assert.deepEqual(list.body[0].tabIds, [t.body.id]);
    // {name} makes the group on the way
    const t2 = await call('POST', '/tabs', { url: 'https://stay.example/', group: { name: 'Hotels' } });
    assert.equal(t2.status, 200);
    assert.equal(w.groups.size, 2);
    assert.equal(w.groups.get(t2.body.groupId).name, 'Hotels');
    // no name: Agent, Agent 2
    const t3 = await call('POST', '/tabs', { url: 'https://x.example/', group: {} });
    assert.equal(w.groups.get(t3.body.groupId).name, 'Agent');
    const bad = await call('POST', '/tabs', { url: 'https://x.example/', group: 999 });
    assert.equal(bad.status, 404);
    const badName = await call('POST', '/groups', { name: '   ' });
    assert.equal(badName.status, 400);
  } finally { await close(); }
});

test('api: PATCH renames, sets status, ends the run (409 after a user rename); /close removes the group; agent close keeps a working group', async () => {
  const { w, call, close } = await api();
  try {
    const g = (await call('POST', '/groups', { name: 'Flights' })).body;
    const t = (await call('POST', '/tabs', { url: 'https://a.example/', group: g.id })).body;
    let r = await call('PATCH', `/groups/${g.id}`, { name: 'Flights to Lisbon', status: 'reading fare rules' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Flights to Lisbon');
    assert.equal(r.body.status, 'reading fare rules');
    w.groups.get(g.id).renamedByUser = true;
    r = await call('PATCH', `/groups/${g.id}`, { name: 'Nope' });
    assert.equal(r.status, 409);
    assert.equal(w.groups.get(g.id).name, 'Flights to Lisbon');
    r = await call('PATCH', `/groups/${g.id}`, { name: '' });
    assert.equal(r.status, 400);
    // an eval on a grouped tab is a touch
    const before = w.touched.length;
    await call('POST', `/tabs/${t.id}/eval`, { expression: '1' });
    assert.ok(w.touched.length > before);
    // the agent closes its only tab: group stays (working, grace)
    r = await call('POST', `/tabs/${t.id}/close`);
    assert.equal(r.status, 200);
    assert.deepEqual(w.closed.pop(), [t.id, 'agent']);
    assert.ok(w.groups.has(g.id), 'agent-close keeps the working group');
    // ...and opens again into the same group
    const t2 = (await call('POST', '/tabs', { url: 'https://b.example/', group: g.id })).body;
    assert.equal(t2.groupId, g.id);
    // working:false with tabs: pulse off, group stays
    r = await call('PATCH', `/groups/${g.id}`, { working: false });
    assert.equal(r.body.working, false);
    assert.ok(w.groups.has(g.id));
    // /close: tabs go, group goes
    r = await call('POST', `/groups/${g.id}/close`);
    assert.equal(r.status, 200);
    assert.equal(w.groups.has(g.id), false);
    assert.equal(w.tabs.has(t2.id), false);
    assert.equal((await call('GET', `/groups/${g.id}`)).status, 404);
    assert.equal((await call('POST', '/tabs', { url: 'https://c.example/', group: g.id })).status, 404, 'a closed group is gone for the agent too');
    // an empty group that is told working:false disappears at once
    const g2 = (await call('POST', '/groups', { name: 'Empty' })).body;
    r = await call('PATCH', `/groups/${g2.id}`, { working: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, true);
    assert.equal(w.groups.has(g2.id), false);
  } finally { await close(); }
});

test('api: GET /tabs lists groupId; the help mentions the group routes', async () => {
  const { call, close } = await api();
  try {
    const g = (await call('POST', '/groups', { name: 'Flights' })).body;
    await call('POST', '/tabs', { url: 'https://a.example/', group: g.id });
    const tabs = (await call('GET', '/tabs')).body;
    assert.deepEqual(tabs.map((t) => t.groupId), [null, g.id]);
    const help = (await call('GET', '/')).body;
    assert.ok(Object.keys(help.routes).some((k) => k.startsWith('POST /groups')));
    assert.ok(Object.keys(help.routes).some((k) => k.startsWith('PATCH /groups/:id')));
  } finally { await close(); }
});
