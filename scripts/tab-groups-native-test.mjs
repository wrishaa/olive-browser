// tab groups, natively: a disposable electron fixture (temp userData, its own agent api
// on a random port, a local fixture http server), never the installed app or a real
// profile. checks the model through the window, the rendered sidebar through its DOM,
// pointer interactions through playwright's mouse, and the agent api over http. with
// --shots it also screenshots the built sidebar (light + dark, 252 + 180) next to the
// prototype mockups into notes/test-shots/tab-groups-built/.
// run: node scripts/tab-groups-native-test.mjs [--shots]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'notes/test-shots/tab-groups-built');
const mockDir = path.join(repo, 'notes/test-shots/tab-groups');
const wantShots = process.argv.includes('--shots');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-tab-groups-fixture-'));
fs.writeFileSync(path.join(root, 'onboarding.json'), JSON.stringify({ version: 1, step: 'done', completed: true }));
const results = [];
const check = (yes, label, detail) => { results.push({ ok: !!yes, label, detail }); console.log((yes ? 'PASS ' : 'FAIL ') + label + (yes ? '' : ' ' + JSON.stringify(detail))); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
const poll = async (fn, n = 100) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await pause(50); } throw new Error('poll timeout'); };

// fixture pages: a title and a coloured svg favicon each, like the prototype's site marks
const SITES = {
  inbox: ['Inbox', '#d9534f'], general: ['General', '#5b8def'], calendar: ['Calendar', '#e36b2c'],
  webhooks: ['Webhooks — API reference', '#3b7ddd'], idempotent: ['Idempotent requests', '#3b7ddd'], readme: ['webhook-signing/README.md', '#24292f'], retries: ['Retries and backoff', '#e2b93b'],
  design: ['Design review notes', '#e2b93b'], roadmap: ['Q4 roadmap', '#3b7ddd'], standup: ['Weekly standup recording', '#c62828'],
  f1: ['Lisbon flights · Nov 12–16', '#2b9bd1'], f2: ['SFO → LIS · 2 adults', '#2b9bd1'], f3: ['Fare rules', '#3b7ddd'], f4: ['Hotel near Alfama', '#f0a830'], f5: ['Lisbon in November', '#444444'],
  w1: ['Webhook signatures', '#3b7ddd'], w2: ['Event types', '#3b7ddd'], w3: ['examples/webhooks/node.js', '#24292f'],
};
const server = http.createServer((req, res) => {
  const slug = req.url.slice(1).split('?')[0];
  const s = SITES[slug] || [slug || 'Fixture', '#5d7d3c'];
  const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${s[1]}"/><circle cx="8" cy="8" r="3" fill="#fff"/></svg>`)}`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${s[0]}</title><link rel="icon" href="${icon}"><body style="margin:0;background:#fff;font:15px -apple-system"><p style="padding:24px">${s[0]}</p>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const url = (slug) => `${base}/${slug}`;

let app, ui, api, token;
const call = async (method, p, body) => {
  const r = await fetch(api + p, { method, headers: { authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// run in the main process against the focused window
const W = (fn, arg) => app.evaluate(({ nativeTheme }, { src, arg }) => { const w = global.olive.focusedWindow(); return (new Function('w', 'arg', 'nativeTheme', 'TG', `return (${src})(w, arg, nativeTheme, TG)`))(w, arg, nativeTheme, process.mainModule.require(process.cwd() + '/src/core/tab-groups')); }, { src: fn.toString(), arg });
const settle = () => pause(120);
const dom = (fn, arg) => ui.evaluate(fn, arg);
const open = async (slug, opts = {}) => W((w, { u, opts }) => w.createTab({ url: u, index: 1e9, ...opts }).id, { u: url(slug), opts }); // index: append, so the fixture reads top-down like the mockup

try {
  app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [repo], cwd: repo, env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'tab-groups-fixture', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, timeout: 30000 });
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise((r) => setTimeout(r, 50)); global.olive.onboarding?.close(); const w = global.olive.focusedWindow(); w.win.setTitle('Olive tab groups synthetic fixture'); for (const t of [...w.tabs.values()]) w.closeTab(t.id, { force: true }); w.setOverlay(null); w.win.setSize(1280, 800); });
  ui = await poll(async () => (await app.windows()).find((p) => p.url().includes('/ui/index.html')));
  const info = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
  api = info.api;
  token = fs.readFileSync(path.join(root, 'agent-token'), 'utf8').trim();

  // ---------- fixture: pinned, a user group, loose tabs, an agent group ----------
  for (const s of ['inbox', 'general', 'calendar']) await open(s, { pinned: true, activate: false });
  const r = {};
  let st;
  for (const s of ['webhooks', 'idempotent', 'readme', 'retries']) r[s] = await open(s, { activate: false });
  const loose = {};
  for (const s of ['design', 'roadmap', 'standup']) loose[s] = await open(s, { activate: false });
  await W((w) => { w.setOverlay(null); }); // closing every tab opened the palette; the fixture has tabs now
  await W((w, ids) => { w.newGroup(ids); }, Object.values(r));
  const research = await W((w) => [...w.groups.values()][0].id);
  await settle();
  check((await dom(() => !!document.querySelector('.group-head .rename'))) === true, 'the new group opens with its rename field (from main\'s rename-group message)');
  await dom(() => document.querySelector('.group-head .rename')?.blur());
  await W((w, { id }) => { w.renameGroup(id, 'Research'); w.activate(w.unpinned.find((x) => w.tabs.get(x).groupId === id && w.tabs.get(x).url.endsWith('/idempotent'))); }, { id: research });
  await settle();
  st = await W((w) => w.unpinned.map((id) => w.tabs.get(id).groupId));
  check(st.length === 7 && st.filter((x) => x === research).length === 4 && /^(n+g{4}n*|n*g{4}n+)$/.test(st.map((x) => (x === research ? 'g' : 'n')).join('')), 'a new group is a contiguous run where its first tab was', st);
  check((await W((w, id) => w.groups.get(id), research)).renamedByUser === true, 'a user rename marks the group as the user\'s');
  await ui.locator('#unpinned .group[data-group]').waitFor();
  let d = await dom(() => ({ groups: document.querySelectorAll('#unpinned .group').length, members: document.querySelectorAll('#unpinned .group .group-body > .row').length, title: document.querySelector('#unpinned .group-head .title')?.textContent, pad: getComputedStyle(document.querySelector('#unpinned .group .group-body > .row')).paddingLeft, weight: getComputedStyle(document.querySelector('#unpinned .group-head .title')).fontWeight, noAgent: document.body.classList.contains('no-agent'), clear: document.querySelector('#btn-clear').classList.contains('none') }));
  check(d.groups === 1 && d.members === 4 && d.title === 'Research' && d.pad === '35px' && d.weight === '600', 'sidebar renders the group as an outline node (bold name, members indented 35px)', d);
  check(d.noAgent === true, 'no agent section without agent groups (sidebar pixel-identical to today)', d);
  check(d.clear === false, 'Clear shows while there are loose tabs', d);

  // agent group over the fixture's own api
  const activeBefore = await W((w) => w.activeId);
  const g = await call('POST', '/groups', { name: 'Flights to Lisbon', status: 'comparing 3 fares' });
  check(g.status === 200 && g.body.section === 'agent' && g.body.collapsed && g.body.working, 'POST /groups makes a collapsed working agent group', g.body);
  const flights = g.body.id;
  const agentTabs = [];
  for (const s of ['f1', 'f2', 'f3', 'f4', 'f5']) { const t = await call('POST', '/tabs', { url: url(s), group: flights, activate: true }); agentTabs.push(t.body.id); check(t.status === 200 && t.body.groupId === flights && t.body.active === false, `POST /tabs {group} opens ${s} in the group, in the background`, t.body); }
  await settle();
  st = await W((w) => ({ active: w.activeId, agent: w.agent, unpinned: w.unpinned.length, order: w.agentOrder }));
  check(st.active === activeBefore && st.agent.join() === agentTabs.join() && st.unpinned === 7 && st.order.join() === String(flights), 'agent tabs live in the agent list; the user\'s active tab and list are untouched', st);
  d = await dom(() => { const h = document.querySelector('#agent .group.agent.working .group-head'); const sb = document.querySelector('#sidebar').getBoundingClientRect(); const hr = h.getBoundingClientRect(); const ub = document.querySelector('#btn-ublock').getBoundingClientRect(); const div = document.querySelector('.agent-divider').getBoundingClientRect(); return { noAgent: document.body.classList.contains('no-agent'), collapsed: h.parentElement.classList.contains('collapsed'), title: h.querySelector('.title').textContent, status: h.querySelector('.status')?.textContent, pulse: !!h.querySelector('.pulse'), count: h.querySelector('.count')?.textContent, favs: getComputedStyle(h.querySelector('.favs')).display, belowList: hr.top > document.querySelector('#tablist').getBoundingClientRect().bottom - 1, aboveUbo: hr.bottom <= ub.top, inSidebar: hr.right <= sb.right, hairline: Math.round(div.width), sparkle: !!h.querySelector('.agent-glyph') }; });
  check(!d.noAgent && d.collapsed && d.title === 'Flights to Lisbon' && d.status === 'comparing 3 fares' && d.pulse && d.count === '5' && d.favs === 'none' && d.sparkle, 'agent header: sparkle, name over status, breathing dot, count, no favicons with a status', d);
  check(d.belowList && d.aboveUbo && d.inSidebar, 'agent section sits below the tab list and above the uBO pill', d);
  // hover a working agent header: no ×, the count stays
  const headBox = await ui.locator('#agent .group-head').boundingBox();
  const hover = async (x, y) => { for (let i = 0; i < 20; i++) { await ui.mouse.move(x + (i % 2), y); await pause(60); if (await dom(() => !!document.querySelector('.group-head:hover'))) return true; } return false; };
  await hover(headBox.x + 60, headBox.y + headBox.height / 2);
  d = await dom(() => { const h = document.querySelector('#agent .group-head'); return { close: getComputedStyle(h.querySelector('.close')).display, count: getComputedStyle(h.querySelector('.count')).display, hovered: h.matches(':hover') }; });
  check(d.hovered && d.close === 'none' && d.count !== 'none', 'no hover × on a working agent group (the count stays)', d);
  await ui.mouse.move(600, 400);

  // ---------- collapse / expand ----------
  const researchHead = ui.locator(`#unpinned .group[data-group="${research}"] .group-head`);
  await researchHead.click();
  await settle();
  d = await dom((id) => { const el = document.querySelector(`.group[data-group="${id}"]`); const h = el.querySelector('.group-head'); return { collapsed: el.classList.contains('collapsed'), favs: el.querySelectorAll('.favs .fav').length, count: h.querySelector('.count')?.textContent, active: h.classList.contains('active'), ring: !!el.querySelector('.favs .fav.is-active'), bodyShown: getComputedStyle(el.querySelector('.group-body')).display, h: Math.round(h.getBoundingClientRect().height) }; }, research);
  check(d.collapsed && d.favs === 3 && d.count === '4' && d.active && d.ring && d.bodyShown === 'none' && d.h === 36, 'click on the header collapses: three favicons, count, active style and ring because the active tab is inside', d);
  const groupState = await W((w, id) => w.groups.get(id).collapsed, research);
  check(groupState === true, 'collapse state lives in main (persists)', groupState);
  await researchHead.click();
  await settle();
  check((await W((w, id) => w.groups.get(id).collapsed, research)) === false, 'click again expands');
  // ⌥-click collapses every group
  await researchHead.click({ modifiers: ['Alt'] });
  await settle();
  check((await W((w) => [...w.groups.values()].every((g) => g.collapsed))) === true, '⌥-click on a header collapses all groups');
  await researchHead.click({ modifiers: ['Alt'] });
  await settle();
  check((await W((w) => [...w.groups.values()].every((g) => !g.collapsed))) === true, '⌥-click again expands all groups');
  await W((w, id) => w.setGroupCollapsed(id, true), flights);
  // ⌃Tab-style activation of a collapsed member expands the group and keeps it so
  await W((w, id) => { w.setGroupCollapsed(id, true); w.activate(w.unpinned.find((x) => w.tabs.get(x).groupId === id)); }, research);
  check((await W((w, id) => w.groups.get(id).collapsed, research)) === false, 'activating a member of a collapsed group expands it (decision 7.4)');

  // ---------- selection ----------
  const rowOf = (id) => ui.locator(`.row[data-id="${id}"]`);
  const activeBeforeSel = await W((w) => w.activeId);
  await rowOf(loose.design).click({ modifiers: ['Meta'] });
  await rowOf(loose.standup).click({ modifiers: ['Meta'] });
  await settle();
  d = await dom(() => [...document.querySelectorAll('.row.selected')].map((r) => Number(r.dataset.id)));
  st = await W((w) => ({ sel: w.selection, active: w.activeId }));
  check(same(d, [loose.design, loose.standup]) && same(st.sel, d) && st.active === activeBeforeSel, '⌘-click toggles two tabs into the selection without activating', { d, st });
  // menu verbs read the selection
  let menu = await W((w, { id, ids }) => w.tabMenuTemplate(id, ids).map((i) => i.label || '-'), { id: loose.design, ids: [loose.design, loose.standup] });
  check(menu[0] === 'Move 2 Tabs to Group' && menu.includes('Pin 2 Tabs') && menu.includes('Close 2 Tabs') && menu.includes('Copy Links'), 'tab menu verbs count the selection', menu);
  let sub = await W((w, { id, ids }) => w.tabMenuTemplate(id, ids)[0].submenu.map((i) => ({ l: i.label || '-', e: i.enabled !== false, c: !!i.checked })), { id: loose.design, ids: [loose.design, loose.standup] });
  check(sub[0].l === 'New Group with 2 Tabs' && sub[1].l === '-' && sub[2].l === 'Research' && sub[2].e && sub[3].l === '✦ Flights to Lisbon', 'Move to Group submenu: New Group, then every group (agent ones with the sparkle)', sub);
  sub = await W((w, { id, ids }) => w.tabMenuTemplate(id, ids)[0].submenu.map((i) => ({ l: i.label || '-', e: i.enabled !== false, c: !!i.checked })), { id: r.webhooks, ids: [r.webhooks, r.readme] });
  check(sub[2].l === 'Research' && !sub[2].e && sub[2].c, 'the group every selected tab is already in is checked and disabled', sub);
  menu = await W((w, { id, ids }) => w.tabMenuTemplate(id, ids).find((i) => i.label === 'Remove from Group').enabled !== false, { id: loose.design, ids: [loose.design, loose.standup] });
  check(menu === false, 'Remove from Group is disabled for loose tabs');
  const gm = await W((w, id) => w.groupMenuTemplate(id).map((i) => i.label || '-'), research);
  check(gm.join('|') === 'New Tab in Group|Rename|-|Collapse|Collapse Other Groups|-|Copy All Links|Ungroup (Keep Tabs)|-|Close Group', 'group header menu is exactly the spec\'s', gm);
  // ⇧-click range over visible rows; esc clears
  await rowOf(r.webhooks).click();
  await settle();
  check((await dom(() => document.querySelectorAll('.row.selected').length)) === 0, 'a plain click clears the selection');
  await rowOf(loose.roadmap).click({ modifiers: ['Shift'] });
  await settle();
  d = await dom(() => [...document.querySelectorAll('.row.selected')].map((x) => Number(x.dataset.id)));
  check(same(d, [r.webhooks, r.idempotent, r.readme, r.retries, loose.design, loose.roadmap]), '⇧-click selects the visible range from the anchor', d);
  await W((w, id) => w.setGroupCollapsed(id, true), research);
  await settle();
  await rowOf(loose.design).click();
  await rowOf(loose.standup).click({ modifiers: ['Shift'] });
  await settle();
  d = await dom(() => [...document.querySelectorAll('.row.selected')].map((x) => Number(x.dataset.id)));
  check(same(d, [loose.design, loose.roadmap, loose.standup]), 'a range skips a collapsed group it is not anchored in', d);
  await ui.keyboard.press('Escape');
  await settle();
  check((await dom(() => document.querySelectorAll('.row.selected').length)) === 0 && (await W((w) => w.selection.length)) === 0, 'esc clears the selection');
  await W((w, id) => w.setGroupCollapsed(id, false), research);

  // ---------- drag: a loose tab onto the group header joins it ----------
  await settle();
  await rowOf(loose.roadmap).waitFor({ timeout: 5000 }).catch(async () => { console.log('rows now:', await dom(() => [...document.querySelectorAll('.row[data-id]')].map((x) => x.dataset.id + ':' + x.querySelector('.title')?.textContent).join(' | '))); });
  const from = await rowOf(loose.roadmap).boundingBox();
  const to = await researchHead.boundingBox();
  await ui.mouse.move(from.x + 80, from.y + from.height / 2);
  await ui.mouse.down();
  for (let i = 1; i <= 8; i++) await ui.mouse.move(from.x + 80 + i, from.y + from.height / 2 - i * 2);
  await ui.mouse.move(to.x + 90, to.y + to.height / 2, { steps: 8 });
  await pause(60);
  d = await dom(() => ({ into: !!document.querySelector('.group-head.drop-into'), ghost: !document.querySelector('#drag-ghost').hidden, close: getComputedStyle(document.querySelector('.group-head.drop-into .close')).display }));
  check(d.into && d.ghost && d.close === 'none', 'dragging over a header shows the drop-target style, no ×', d);
  await ui.mouse.up();
  await settle();
  st = await W((w, { id, gid }) => ({ g: w.tabs.get(id).groupId, last: w.unpinned[w.unpinned.indexOf(w.unpinned.findLast((x) => w.tabs.get(x).groupId === gid))] }), { id: loose.roadmap, gid: research });
  check(st.g === research && st.last === loose.roadmap, 'dropped on the header: the tab joins at the end of the group', st);
  // drag between members inserts there
  const roadmapBox = await rowOf(loose.roadmap).boundingBox();
  const webhooksBox = await rowOf(r.webhooks).boundingBox();
  await ui.mouse.move(roadmapBox.x + 100, roadmapBox.y + 18);
  await ui.mouse.down();
  for (let i = 1; i <= 8; i++) await ui.mouse.move(roadmapBox.x + 100, roadmapBox.y + 18 - i);
  await ui.mouse.move(webhooksBox.x + 100, webhooksBox.y + 4, { steps: 8 });
  await pause(60);
  d = await dom(() => ({ mark: !!document.querySelector('.group-body > .row.drop-before, .group-body > .row.drop-after'), left: getComputedStyle(document.querySelector('.group-body > .row.drop-before, .group-body > .row.drop-after'), '::after').left }));
  check(d.mark && d.left === '33px', 'between members: the indented insertion line', d);
  await ui.mouse.up();
  await settle();
  st = await W((w, { gid, a, b }) => { const m = w.unpinned.filter((x) => w.tabs.get(x).groupId === gid); return { m, ok: m.indexOf(a) + 1 === m.indexOf(b) && w.tabs.get(a).groupId === gid }; }, { gid: research, a: loose.roadmap, b: r.webhooks });
  check(st.ok, 'dropped before a member: inserted right before it, still in the group', st);
  // drag a member out to the left of the indent: "Move out of Research"
  const memberBox = await rowOf(loose.roadmap).boundingBox();
  await ui.mouse.move(memberBox.x + 100, memberBox.y + 18);
  await ui.mouse.down();
  for (let i = 1; i <= 8; i++) await ui.mouse.move(memberBox.x + 100 - i * 8, memberBox.y + 18);
  await ui.mouse.move(memberBox.x + 12, memberBox.y + 18, { steps: 6 });
  await pause(60);
  d = await dom(() => ({ text: document.querySelector('#drag-ghost .name-plain')?.textContent, mark: !!document.querySelector('.group.drop-before, .group.drop-after') }));
  check(d.text === 'Move out of Research' && d.mark, 'a member dragged left of the indent reads "Move out of Research"', d);
  await ui.mouse.up();
  await settle();
  st = await W((w, { id, gid }) => ({ g: w.tabs.get(id).groupId, n: w.unpinned.filter((x) => w.tabs.get(x).groupId === gid).length, loose: w.looseCount() }), { id: loose.roadmap, gid: research });
  check(st.g === null && st.n === 4 && st.loose === 3, 'dropped at list level: the tab left the group', st);
  // group reorder by dragging the header below the loose tabs
  const head2 = await researchHead.boundingBox();
  const lastLoose = await dom(() => Number([...document.querySelectorAll('#unpinned > .row[data-id]')].pop().dataset.id));
  const standupBox = await rowOf(lastLoose).boundingBox();
  await ui.mouse.move(head2.x + 80, head2.y + 18);
  await ui.mouse.down();
  for (let i = 1; i <= 8; i++) await ui.mouse.move(head2.x + 80, head2.y + 18 + i * 3);
  await ui.mouse.move(standupBox.x + 80, standupBox.y + standupBox.height - 4, { steps: 10 });
  await pause(60);
  d = await dom(() => ({ ghost: document.querySelector('#drag-ghost .name')?.textContent, badge: document.querySelector('#drag-ghost .badge')?.textContent, after: !!document.querySelector('.drop-after') }));
  check(d.ghost === 'Research' && d.badge === '4' && d.after, 'dragging a header: ghost = name + count badge, drop between top-level items', d);
  await ui.mouse.up();
  await settle();
  st = await W((w, gid) => w.unpinned.map((x) => (w.tabs.get(x).groupId === gid ? 'g' : 'l')).join(''), research);
  check(st === 'lllgggg', 'the whole group moved below the loose tabs', st);
  await W((w, gid) => w.moveGroup(gid, 0), research);
  await settle();

  // ---------- move to group / remove from group via verbs ----------
  await W((w, { ids, gid }) => w.moveToGroup(ids, gid), { ids: [loose.design], gid: flights });
  await settle();
  st = await W((w, id) => ({ g: w.tabs.get(id).groupId, list: w.agent.includes(id), unp: w.unpinned.includes(id) }), loose.design);
  check(st.g === flights && st.list && !st.unp, 'Move to Group onto an agent group: the tab leaves the user\'s list for the agent section', st);
  await W((w, ids) => w.moveToGroup(ids, null), [loose.design]);
  await settle();
  st = await W((w, id) => ({ g: w.tabs.get(id).groupId, last: w.unpinned[w.unpinned.length - 1] }), loose.design);
  check(st.g === null && st.last === loose.design, 'Remove from Group on an agent member: to the end of the loose tabs', st);

  // ---------- rename ----------
  await researchHead.dblclick();
  await pause(150);
  d = await dom(() => { const f = document.querySelector('.group-head .rename'); return { field: !!f, focused: document.activeElement === f, selected: f && f.selectionStart === 0 && f.selectionEnd === f.value.length, weight: f && getComputedStyle(f).fontWeight, h: f && Math.round(f.getBoundingClientRect().height) }; });
  check(d.field && d.focused && d.selected && d.weight === '600' && d.h === 22, 'double-click opens the in-place rename field, text selected, same weight', d);
  await ui.keyboard.type('Payments research');
  await ui.keyboard.press('Enter');
  await settle();
  check((await W((w, id) => w.groups.get(id).name, research)) === 'Payments research' && (await dom(() => document.querySelector('#unpinned .group-head .title').textContent)) === 'Payments research', 'return commits the rename');
  await researchHead.dblclick();
  await pause(100);
  await ui.keyboard.type('nope');
  await ui.keyboard.press('Escape');
  await settle();
  check((await W((w, id) => w.groups.get(id).name, research)) === 'Payments research', 'esc reverts');
  await W((w, id) => w.renameGroup(id, 'Research'), research);
  // ⌃⌘N on a selection opens the rename field on a new Untitled Group
  await W((w, ids) => w.newGroup(ids), [loose.design, loose.standup]);
  await pause(150);
  d = await dom(() => { const f = document.querySelector('.group-head .rename'); return { field: !!f, value: f?.value, focused: document.activeElement === f }; });
  const untitled = await W((w) => [...w.groups.values()].find((g) => g.name === 'Untitled Group')?.id);
  check(d.field && d.value === 'Untitled Group' && d.focused && untitled != null, '⌃⌘N: Untitled Group, expanded, rename field open with the text selected', d);
  await ui.keyboard.type('Reading');
  await ui.keyboard.press('Enter');
  await settle();
  st = await W((w, id) => ({ name: w.groups.get(id)?.name, n: w.unpinned.filter((x) => w.tabs.get(x).groupId === id).length, pos: w.unpinned.findIndex((x) => w.tabs.get(x).groupId === id) }), untitled);
  check(st.name === 'Reading' && st.n === 2 && st.pos === 4, 'the new group holds the two selected tabs, where the first of them was', st);

  // ---------- closing ----------
  await W((w, id) => w.closeTab(id), loose.design);
  await W((w, id) => w.closeTab(id), loose.standup);
  await settle();
  check((await W((w, id) => w.groups.has(id), untitled)) === false, 'closing the last member removes a user group');
  // Close Group as one undo entry
  const beforeIds = await W((w, gid) => w.unpinned.filter((x) => w.tabs.get(x).groupId === gid).map((x) => w.tabs.get(x).url), research);
  await W((w, gid) => w.closeGroup(gid), research);
  await settle();
  st = await W((w) => ({ groups: w.groups.size, top: w.closedStack[w.closedStack.length - 1], n: w.unpinned.length }));
  check(st.groups === 1 && st.top.kind === 'group' && st.top.name === 'Research' && st.top.tabs.length === 4 && st.n === 1, 'Close Group closes its tabs and leaves one closed-stack entry', { groups: st.groups, top: { kind: st.top.kind, name: st.top.name, tabs: st.top.tabs.length } });
  await W((w) => w.reopenClosed());
  await pause(400);
  st = await W((w) => { const g = [...w.groups.values()].find((x) => !x.agent); return { name: g?.name, urls: w.unpinned.filter((x) => w.tabs.get(x).groupId === g?.id).map((x) => w.tabs.get(x).url), pos: w.unpinned.findIndex((x) => w.tabs.get(x).groupId === g?.id), active: w.tabs.get(w.activeId)?.groupId === g?.id }; });
  check(st.name === 'Research' && st.urls.join() === beforeIds.join() && st.pos === 0 && st.active, '⇧⌘T brings the group back: name, order, place', st);
  const research2 = await W((w) => [...w.groups.values()].find((x) => !x.agent).id);
  // Clear keeps groups
  await W((w) => w.clearUnpinned());
  await settle();
  st = await W((w) => ({ loose: w.looseCount(), groups: w.groups.size, clear: null }));
  d = await dom(() => document.querySelector('#btn-clear').classList.contains('none'));
  check(st.loose === 0 && st.groups === 2 && d === true, 'Clear closes the loose tabs only and hides when there are none', { st, d });

  // ---------- agent lifecycle over the api ----------
  for (const id of agentTabs) await call('POST', `/tabs/${id}/close`);
  await settle();
  st = await W((w, id) => ({ has: w.groups.has(id), working: w.groups.get(id)?.working, agent: w.agent.length }), flights);
  d = await dom(() => { const h = document.querySelector('#agent .group-head'); return { shown: !!h, status: h?.querySelector('.status')?.textContent, count: h?.querySelector('.count')?.textContent ?? null }; });
  check(st.has && st.working && st.agent === 0 && d.shown && d.status === 'comparing 3 fares' && d.count === null, 'an agent emptying its working group keeps the group (header, status, no count)', { st, d });
  const again = await call('POST', '/tabs', { url: url('f1'), group: flights });
  check(again.status === 200 && again.body.groupId === flights, 'and can open into it again');
  let p = await call('PATCH', `/groups/${flights}`, { status: 'done · cheapest $612', working: false });
  await settle();
  d = await dom(() => { const h = document.querySelector('#agent .group-head'); return { pulse: !!h.querySelector('.pulse'), status: h.querySelector('.status')?.textContent }; });
  check(p.status === 200 && !d.pulse && d.status === 'done · cheapest $612', 'PATCH working:false ends the pulse and keeps the status', { p: p.body, d });
  const hb = await ui.locator('#agent .group-head').boundingBox();
  await hover(hb.x + 60, hb.y + 18);
  d = await dom(() => { const h = document.querySelector('#agent .group-head'); return { close: getComputedStyle(h.querySelector('.close')).display, count: getComputedStyle(h.querySelector('.count')).display, title: h.querySelector('.close').title }; });
  check(d.close === 'grid' && d.count === 'none' && d.title === 'Close Group (1 tab)', 'once done, the hover × returns in the count\'s slot', d);
  await ui.mouse.move(600, 400);
  await W((w, id) => { w.groups.get(id).renamedByUser = true; }, flights);
  p = await call('PATCH', `/groups/${flights}`, { name: 'Agent wants this' });
  check(p.status === 409, 'an agent rename after a user rename is refused (409)', p);
  // user closes the last member: gone at once, even while working
  await call('PATCH', `/groups/${flights}`, { working: true });
  await W((w, id) => w.closeTab(id, { force: true }), again.body.id);
  await settle();
  d = await dom(() => document.body.classList.contains('no-agent'));
  check((await W((w, id) => w.groups.has(id), flights)) === false && d, 'a user closing the last agent tab removes the group and the section', d);
  // the empty-group timer: an agent group with no tabs goes 2 minutes after its last call
  const g2 = (await call('POST', '/groups', { name: 'Stale' })).body;
  await W((w, id) => { w.groups.get(id).lastAgentCall -= 3 * 60 * 1000; w.expireGroups(); }, g2.id);
  check((await W((w, id) => w.groups.has(id), g2.id)) === false, 'an agent group still empty 2 minutes after its last call is removed');
  // a working group with tabs goes quiet after 2 minutes, stays
  const g3 = (await call('POST', '/groups', { name: 'Stripe webhooks', status: 'done · 2 docs, 1 example' })).body;
  for (const s of ['w1', 'w2', 'w3']) await call('POST', '/tabs', { url: url(s), group: g3.id });
  await W((w, id) => { w.groups.get(id).lastAgentCall -= 3 * 60 * 1000; w.expireGroups(); }, g3.id);
  st = await W((w, id) => ({ has: w.groups.has(id), working: w.groups.get(id)?.working }), g3.id);
  check(st.has && st.working === false, 'working ends by itself 2 minutes after the last api call; the group stays', st);
  const g4 = (await call('POST', '/groups', { name: 'Flights to Lisbon', status: 'comparing 3 fares' })).body;
  for (const s of ['f1', 'f2', 'f3', 'f4', 'f5']) await call('POST', '/tabs', { url: url(s), group: g4.id });
  await settle();
  d = await dom(() => [...document.querySelectorAll('#agent .group')].map((x) => ({ name: x.querySelector('.title').textContent, working: x.classList.contains('working'), top: Math.round(x.getBoundingClientRect().top) })));
  check(d.length === 2 && d[0].name === 'Stripe webhooks' && !d[0].working && d[1].name === 'Flights to Lisbon' && d[1].working && d[1].top - d[0].top === 38, 'two agent groups stack at the bottom, newest last, 38px rhythm', d);

  // ---------- geometry: rhythm, names at 35, hairlines, 180px ----------
  d = await dom(() => { const rows = [...document.querySelectorAll('#unpinned > .row, #unpinned > .group.collapsed > .group-head, #unpinned > .group > .group-body > .row')].map((r) => Math.round(r.getBoundingClientRect().top)); const diffs = rows.slice(1).map((y, i) => y - rows[i]); const name = document.querySelector('#unpinned .group-head .title').getBoundingClientRect().left; const title = document.querySelector('#newtab .title').getBoundingClientRect().left; /* Clear just ran: the New Tab row has a tab row's metrics */ const memberFav = document.querySelector('#unpinned .group .group-body > .row .fav, #unpinned .group .group-body > .row .spinner').getBoundingClientRect().left; const hair = [...document.querySelectorAll('.divider .line')].map((l) => { const r = l.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }); return { diffs, name: Math.round(name), title: Math.round(title), memberFav: Math.round(memberFav), hair }; });
  check(d.diffs.every((x) => x === 38) && d.name === d.title && d.memberFav === d.name, 'rows keep the 38px rhythm; the group name starts where tab titles start; member favicons sit under the name', d);
  check(d.hair.length === 2 && d.hair[0].join() === d.hair[1].join(), 'both hairlines span the same width (the Clear button overlays the pinned one)', d);
  await W((w) => w.setSidebarWidth(180));
  await settle();
  d = await dom(() => { const sb = document.querySelector('#sidebar').getBoundingClientRect(); const over = [...document.querySelectorAll('.row')].filter((r) => r.getBoundingClientRect().right > sb.right + 0.5).length; const ah = document.querySelector('#agent .group.working .group-head'); return { narrow: document.body.classList.contains('narrow'), favs: getComputedStyle(document.querySelector('#unpinned .group.collapsed .favs') || document.querySelector('#agent .favs')).display, over, count: ah ? getComputedStyle(ah.querySelector('.count')).display : null, nameClipped: [...document.querySelectorAll('.group-head .title')].every((t) => getComputedStyle(t).textOverflow === 'ellipsis') }; });
  check(d.narrow && d.favs === 'none' && d.over === 0 && d.count === 'none' && d.nameClipped, '180px: narrow mode drops favicons and the count under a status; nothing clips the sidebar', d);
  await W((w) => w.setSidebarWidth(252));

  // ---------- session restore ----------
  st = await W((w) => { const s = w.serialize(); const w2 = global.olive.newWindow({ state: s, inactive: true }); const out = { groups: [...w2.groups.values()].map((g) => ({ name: g.name, agent: g.agent, working: g.working, status: g.status, collapsed: g.collapsed, n: w2.unpinned.concat(w2.agent).filter((x) => w2.tabs.get(x).groupId === g.id).length })), agent: w2.agent.length, order: w2.agentOrder.length }; w2.win.close(); return out; });
  check(st.groups.length === 3 && st.groups.find((g) => g.name === 'Research')?.n === 4 && st.groups.filter((g) => g.agent).every((g) => !g.working) && st.agent === 8 && st.order === 2, 'session state round-trips groups: names, membership, agent section, status; the pulse does not survive a restart', st);
  await pause(200);
  await W((w) => { w.win.focus(); });

  // ---------- screenshots next to the mockups ----------
  if (wantShots) {
    fs.mkdirSync(outDir, { recursive: true });
    const desktop = { light: 'linear-gradient(135deg, #dfe6ea 0%, #cdd7df 50%, #d9d4cc 100%)', dark: 'linear-gradient(135deg, #2a2f36 0%, #1a1e24 55%, #24201f 100%)' };
    const SIDEBAR_H = 760;
    const made = [];
    const shoot = async (name, w, { full = false, theme }) => {
      await dom(({ bg }) => { let s = document.getElementById('shot-style'); if (!s) { s = document.createElement('style'); s.id = 'shot-style'; document.head.appendChild(s); } s.textContent = `html{background:${bg}} .group-head .pulse{animation:none!important} #urlbar .progress{display:none}`; document.body.classList.add('shot'); }, { bg: desktop[theme] });
      await pause(120);
      await app.evaluate((_, h) => { global.olive.focusedWindow().win.setContentSize(1280, h); }, full ? 800 : SIDEBAR_H);
      await pause(150);
      const file = path.join(outDir, `${name}-${theme}-${w}${full ? '-window' : ''}.png`);
      await ui.screenshot({ path: file, clip: full ? { x: 0, y: 0, width: 1280, height: 800 } : { x: 0, y: 0, width: w + 56, height: SIDEBAR_H } });
      made.push(path.basename(file));
    };
    const scenes = {
      // name -> setup in main (w) and ui, after the fixture is reset to the basic state
      basic: async () => {},
      'collapsed-active': async () => { await W((w, id) => w.setGroupCollapsed(id, true), research2); },
      multiselect: async () => { const m = await W((w, id) => w.unpinned.filter((x) => w.tabs.get(x).groupId === id), research2); const l = await W((w) => w.unpinned.find((x) => w.tabs.get(x).groupId == null)); await rowOf(m[1]).click({ modifiers: ['Meta'] }); await rowOf(m[3]).click({ modifiers: ['Meta'] }); await rowOf(l).click({ modifiers: ['Meta'] }); },
      'agent-working': async () => { await W((w, id) => { w.setGroupCollapsed(id, true); w.activate(w.unpinned.find((x) => w.tabs.get(x).groupId == null && w.tabs.get(x).url.endsWith('/roadmap'))); }, research2); },
      'agent-expanded': async () => { await W((w, id) => { w.setGroupCollapsed(id, true); w.activate(w.unpinned.find((x) => w.tabs.get(x).groupId == null && w.tabs.get(x).url.endsWith('/roadmap'))); }, research2); await call('PATCH', `/groups/${g4.id}`, { status: 'reading fare rules', collapsed: false }); },
      'agent-done': async () => { await W((w, id) => { w.setGroupCollapsed(id, true); w.activate(w.unpinned.find((x) => w.tabs.get(x).groupId == null && w.tabs.get(x).url.endsWith('/roadmap'))); }, research2); await call('PATCH', `/groups/${g4.id}`, { status: 'done · cheapest $612', working: false }); },
      'agent-hover-done': async () => { await scenes['agent-done'](); await settle(); const b = await ui.locator(`#agent .group[data-group="${g4.id}"] .group-head`).boundingBox(); await ui.mouse.move(b.x + 70, b.y + 18); },
      'agent-hover': async () => { await scenes['agent-working'](); await settle(); const b = await ui.locator(`#agent .group[data-group="${g4.id}"] .group-head`).boundingBox(); await ui.mouse.move(b.x + 70, b.y + 18); },
      rename: async () => { await researchHead2().dblclick(); },
      'two-agents': async () => { await scenes['agent-working'](); },
    };
    const researchHead2 = () => ui.locator(`#unpinned .group[data-group="${research2}"] .group-head`);
    const reset = async () => {
      await ui.mouse.move(700, 500);
      await ui.keyboard.press('Escape');
      await W((w, { research2, g3, g4 }) => {
        for (const g of w.groups.values()) g.collapsed = g.agent;
        w.selection = [];
        const idem = w.unpinned.find((x) => w.tabs.get(x).groupId === research2 && w.tabs.get(x).url.endsWith('/idempotent'));
        w.activate(idem);
        const a = w.groups.get(g4); a.status = 'comparing 3 fares'; a.working = true; a.lastAgentCall = Date.now();
        const b = w.groups.get(g3); if (b) { b.status = 'done · 2 docs, 1 example'; b.working = false; }
        w.sendState();
      }, { research2, g3: g3.id, g4: g4.id });
      await dom(() => { const f = document.querySelector('.rename'); if (f) f.blur(); });
      await settle();
    };
    // the basic fixture needs the loose tabs back and only one agent group for most scenes
    for (const s of ['design', 'roadmap', 'standup']) loose[s] = await open(s, { activate: false });
    await W((w, g3) => { for (const x of [...w.agent].filter((id) => w.tabs.get(id).groupId === g3)) w.closeTab(x, { force: true }); }, g3.id);
    await settle();
    for (const theme of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await ui.emulateMedia({ colorScheme: theme });
      for (const [name, setup] of Object.entries(scenes)) {
        // one agent group for every scene but two-agents, which gets Stripe webhooks back (done, above Flights)
        const two = name === 'two-agents';
        if (two) { const gg = (await call('POST', '/groups', { name: 'Stripe webhooks', status: 'done · 2 docs, 1 example' })).body; for (const s of ['w1', 'w2', 'w3']) await call('POST', '/tabs', { url: url(s), group: gg.id }); await call('PATCH', `/groups/${gg.id}`, { working: false }); await W((w, id) => w.moveGroup(id, 0), gg.id); g3.id = gg.id; }
        await reset();
        await setup();
        await settle();
        const widths = ['basic', 'agent-working', 'two-agents', 'collapsed-active'].includes(name) ? [252, 180] : [252];
        for (const w of widths) {
          await W((w2, width) => w2.setSidebarWidth(width), w);
          await settle();
          if (name.startsWith('agent-hover')) await setup();
          await pause(80);
          await shoot(name, w, { theme });
          if (w === 252 && ['basic', 'agent-working', 'many-groups'].includes(name)) await shoot(name, w, { theme, full: true });
        }
        await W((w2) => w2.setSidebarWidth(252));
        if (two) { await W((w, g3) => { for (const x of [...w.agent].filter((id) => w.tabs.get(id).groupId === g3)) w.closeTab(x, { force: true }); }, g3.id); await settle(); }
      }
    }
    await dom(() => { document.getElementById('shot-style')?.remove(); document.body.classList.remove('shot'); });
    await app.evaluate(() => { global.olive.focusedWindow().win.setContentSize(1280, 800); });
    fs.writeFileSync(path.join(outDir, 'SHOTS.json'), JSON.stringify({ made, mockDir: path.relative(repo, mockDir), note: 'built sidebar shots from the disposable fixture; pair-*.png and contact-sheet-*.png put each next to its prototype mockup' }, null, 2));
    await contactSheet(made);
  }
} catch (error) {
  results.push({ ok: false, label: 'test exception', detail: String(error.stack || error) });
  console.error(error);
} finally {
  fs.writeFileSync(path.join(repo, 'notes/test-shots/tab-groups-native-test.json'), JSON.stringify(results, null, 2));
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;

// mockup | built pairs and contact sheets: scripts/tab-groups-contact-sheet.mjs
async function contactSheet(made) {
  const { contactSheet: sheet } = await import('./tab-groups-contact-sheet.mjs');
  await sheet(made);
}
