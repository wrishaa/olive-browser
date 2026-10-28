// static prototype of tab groups in the olive sidebar. renders one named scene
// from ?scene=…&w=252&mode=full|sidebar. markup mirrors src/ui/ui.js rowHtml/listHtml.
'use strict';

const q = new URLSearchParams(location.search);
const SCENE = q.get('scene') || 'basic';
const SBW = Number(q.get('w') || 252);
const MODE = q.get('mode') || 'sidebar';
const SHOT = q.get('shot') != null;

const ICON = {
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 10 10"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sparkle: '<svg viewBox="0 0 16 16"><path d="M7 1.6c.35 2.9 2.5 5.05 5.4 5.4-2.9.35-5.05 2.5-5.4 5.4-.35-2.9-2.5-5.05-5.4-5.4C4.5 6.65 6.65 4.5 7 1.6z" fill="currentColor"/><path d="M12.6 10.2c.15 1.2 1 2.05 2.2 2.2-1.2.15-2.05 1-2.2 2.2-.15-1.2-1-2.05-2.2-2.2 1.2-.15 2.05-1 2.2-2.2z" fill="currentColor"/></svg>',
  submenu: '<svg class="sub" viewBox="0 0 10 10"><path d="M3.5 1.5 7 5l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// site marks: generic coloured favicons (no real brands), so shots don't depend on the network
const FAV = {
  docs: ['#3b7ddd', '<path d="M4.5 2.5h5l2 2v9h-7z" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M6 8h4M6 10.5h4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>'],
  mail: ['#d9534f', '<rect x="2.5" y="4" width="11" height="8" rx="1.5" fill="none" stroke="#fff" stroke-width="1.3"/><path d="m3 5 5 3.5L13 5" fill="none" stroke="#fff" stroke-width="1.3"/>'],
  chat: ['#5b8def', '<path d="M3 3.5h10v6H7l-3 2.5v-2.5H3z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>'],
  cal: ['#e36b2c', '<rect x="2.5" y="3.5" width="11" height="9.5" rx="1.5" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M2.5 6.5h11" stroke="#fff" stroke-width="1.3"/>'],
  code: ['#24292f', '<path d="m6 5-3 3 3 3M10 5l3 3-3 3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'],
  shop: ['#f0a830', '<path d="M3 5h10l-1 7H4z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 5V4a2 2 0 0 1 4 0v1" fill="none" stroke="#fff" stroke-width="1.3"/>'],
  plane: ['#2b9bd1', '<path d="M2.5 9.5 13.5 4l-3 9-2.5-4z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>'],
  video: ['#c62828', '<rect x="2.5" y="4" width="8" height="8" rx="1.5" fill="none" stroke="#fff" stroke-width="1.3"/><path d="m10.5 7 3-2v6l-3-2z" fill="#fff"/>'],
  note: ['#e2b93b', '<path d="M4 2.5h8v11H4z" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M6 6h4M6 8.5h4M6 11h2.5" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'],
  news: ['#444', '<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M5 6h3v3H5zM9.5 6H11M9.5 8.5H11M5 11h6" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'],
  figma: ['#a259ff', '<circle cx="8" cy="8" r="2.4" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M5.5 3h2.5v10H5.5z" fill="none" stroke="#fff" stroke-width="1.2"/>'],
  bank: ['#2e7d5b', '<path d="M2.5 6.5 8 3.5l5.5 3h-11zM4 7v4.5M8 7v4.5M12 7v4.5M2.5 12.5h11" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'],
};

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function favHtml(t, extra = '') {
  if (t.loading) return '<span class="spinner"></span>';
  const f = FAV[t.fav];
  if (f) return `<span class="fav ${extra}" style="background:${f[0]}"><svg viewBox="0 0 16 16" width="16" height="16" style="width:100%;height:100%">${f[1]}</svg></span>`;
  const letter = ((t.host || t.title || '?')[0] || '?').toUpperCase();
  return `<span class="fav letter ${extra}" style="background:hsl(${hue(t.host || t.title)} 35% 48%)">${esc(letter)}</span>`;
}

let S = null;

function rowHtml(t, { inSplit = false, focus = false, member = false } = {}) {
  const cls = ['row'];
  if (S.activeId === t.id && !inSplit) cls.push('active');
  if (inSplit && focus) cls.push('focus');
  if (t.unloaded) cls.push('unloaded');
  if (S.selection.includes(t.id)) cls.push('selected');
  if (S.drag?.src?.includes(t.id)) cls.push('dragging-src');
  if (S.drag?.before === t.id) cls.push('drop-before');
  if (S.drag?.after === t.id) cls.push('drop-after');
  const title = t.title || t.host;
  return `<div class="${cls.join(' ')}" data-id="${t.id}" title="${esc(title)}">${favHtml(t)}<span class="title">${esc(title)}</span><span class="close" title="Close (⌘W)">${ICON.close}</span></div>`;
}

function splitHtml(members) {
  const active = members.some((m) => m.id === S.activeId);
  return `<div class="split-group${active ? ' active' : ''}">${members.map((m) => rowHtml(m, { inSplit: true, focus: m.id === S.activeId })).join('')}</div>`;
}

function itemsHtml(items) {
  return items.map((it) => it.split ? splitHtml(it.split) : it.group ? groupHtml(it) : rowHtml(it)).join('');
}

function groupTabs(g) { return g.tabs.flatMap((it) => it.split ? it.split : [it]); }

function groupHtml(g) {
  const tabs = groupTabs(g);
  const hasActive = tabs.some((t) => t.id === S.activeId);
  const cls = ['group'];
  if (g.collapsed) cls.push('collapsed');
  if (g.agent) cls.push('agent');
  if (g.working) cls.push('working');
  const head = ['row', 'group-head'];
  if (g.collapsed && hasActive) head.push('active');
  if (S.drag?.into === g.id) head.push('drop-into');
  if (S.drag?.after === g.id) head.push('drop-after');
  const n = tabs.length;
  let title = S.rename === g.id
    ? `<span class="rename"><span class="sel">${esc(g.name)}</span><span class="caret"></span></span>`
    : `<span class="title">${esc(g.name)}</span>`;
  const glyph = g.agent ? `<span class="agent-glyph" title="Opened by an agent">${ICON.sparkle}</span>` : '';
  const status = '';
  if (g.status && S.rename !== g.id) title = `<span class="lines">${title}<span class="status">${esc(g.status)}</span></span>`;
  const pulse = g.working ? '<span class="pulse" title="Agent is working"></span>' : '';
  // newest first, up to three
  const favs = `<span class="favs">${tabs.slice(-3).reverse().map((t) => favHtml({ ...t, loading: false }, t.id === S.activeId ? 'is-active' : '')).join('')}</span>`;
  const count = g.collapsed && n ? `<span class="count">${n}</span>` : '';
  const tip = g.agent ? `${esc(g.name)} · opened by an agent · ${n} tab${n === 1 ? '' : 's'}` : `${esc(g.name)} · ${n} tab${n === 1 ? '' : 's'}`;
  const body = n ? itemsHtml(g.tabs.map((it) => it.split ? it : { ...it, member: true })) : '<button class="row newtab-row"><span class="plus">+</span><span class="title">New Tab</span></button>';
  return `<div class="${cls.join(' ')}" data-group="${g.id}"><div class="${head.join(' ')}" title="${tip}"><span class="disc">${ICON.chevron}</span>${glyph}${title}${status}${pulse}${favs}${count}<span class="close" title="Close Group (${n} tabs)">${ICON.close}</span></div><div class="group-body">${body}</div></div>`;
}

function findTab(id) {
  const all = [];
  const walk = (items) => items.forEach((it) => it.split ? all.push(...it.split) : it.group ? walk(it.tabs) : all.push(it));
  walk(S.pinned); walk(S.unpinned); walk(S.agent || []);
  return all.find((t) => t.id === id);
}

function render() {
  const b = document.body;
  b.classList.toggle('no-pinned', S.pinned.length === 0);
  b.classList.toggle('no-agent', !(S.agent || []).length);
  b.classList.toggle('narrow', SBW < 210);
  b.classList.toggle('shot', SHOT);
  b.classList.toggle('w500', !!S.w500);
  document.getElementById('sidebar').style.width = SBW + 'px';
  const active = findTab(S.activeId);
  const host = document.querySelector('#urlbar .host');
  host.textContent = active ? active.host : 'Search or enter URL';
  host.classList.toggle('placeholder', !active);
  document.querySelector('#urlbar .lock').style.display = active ? '' : 'none';
  document.getElementById('pinned').innerHTML = itemsHtml(S.pinned);
  document.getElementById('unpinned').innerHTML = itemsHtml(S.unpinned);
  const agentEl = document.getElementById('agent');
  agentEl.innerHTML = itemsHtml(S.agent || []);
  // scroll-edge fade only while the section actually overflows
  agentEl.classList.toggle('overflows', agentEl.scrollHeight > agentEl.clientHeight + 1);

  // page card exactly where a tab's page goes: x = sbw, y = 8, radius 10
  const cards = document.getElementById('cards');
  const W = innerWidth, H = innerHeight;
  cards.innerHTML = `<div class="card" style="left:${SBW}px;top:8px;width:${W - SBW - 8}px;height:${H - 16}px"></div>`;
  document.getElementById('lights').hidden = MODE !== 'full';

  // hover emulation for static shots
  if (S.hover) {
    const el = document.querySelector(`[data-id="${S.hover}"], [data-group="${S.hover}"] > .group-head`);
    if (el) {
      el.style.background = 'var(--row-hover)';
      const working = el.closest('.group.agent.working');
      if (!working) { el.querySelector('.close').style.display = 'grid'; el.querySelectorAll('.count').forEach((x) => (x.style.display = 'none')); }
    }
  }

  // drag ghost
  const g = document.getElementById('drag-ghost');
  if (S.drag?.ghost) {
    const d = S.drag.ghost;
    g.hidden = false;
    g.innerHTML = favHtml({ ...findTab(d.id), loading: false }) + `<span>${esc(d.title)}</span>` + (d.count > 1 ? `<span class="badge">${d.count}</span>` : '');
    g.style.left = d.x + 'px'; g.style.top = d.y + 'px';
  } else g.hidden = true;

  // context menu mock
  document.querySelectorAll('#ctx').forEach((el) => el.remove());
  if (S.menu) {
    for (const m of [S.menu, S.menu.submenu].filter(Boolean)) {
      const el = document.createElement('div');
      el.id = 'ctx';
      if (m === S.menu.submenu) el.classList.add('submenu');
      el.style.left = m.x + 'px'; el.style.top = m.y + 'px';
      el.innerHTML = m.items.map((it) => it === '-' ? '<div class="sep"></div>' : `<div class="mi${it.hl ? ' hl' : ''}${it.dis ? ' dis' : ''}">${it.chk ? `<span class="chk">${it.chk}</span>` : ''}${it.icon || ''}<span>${esc(it.label)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}${it.sub ? ICON.submenu : ''}</div>`).join('');
      document.body.appendChild(el);
    }
  }
}

// ---------- fixtures ----------
const T = (id, title, host, fav, extra = {}) => ({ id, title, host, fav, ...extra });
const pinnedBase = () => [T('p1', 'Inbox', 'mail.example.com', 'mail'), T('p2', 'General', 'chat.example.com', 'chat'), T('p3', 'Calendar', 'calendar.example.com', 'cal')];
const research = (o = {}) => ({ group: true, id: 'g1', name: 'Research', tabs: [
  T('r1', 'Webhooks — API reference', 'docs.example.com', 'docs'),
  T('r2', 'Idempotent requests', 'docs.example.com', 'docs'),
  T('r3', 'webhook-signing/README.md', 'code.example.com', 'code'),
  T('r4', 'Retries and backoff', 'notes.example.com', 'note'),
], ...o });
const flights = (o = {}) => ({ group: true, id: 'g2', name: 'Flights to Lisbon', agent: true, working: true, collapsed: true, status: 'comparing 3 fares', tabs: [
  T('f1', 'Lisbon flights · Nov 12–16', 'flights.example.com', 'plane'),
  T('f2', 'SFO → LIS · 2 adults', 'air.example.com', 'plane'),
  T('f3', 'Fare rules', 'air.example.com', 'docs'),
  T('f4', 'Hotel near Alfama', 'stay.example.com', 'shop'),
  T('f5', 'Lisbon in November', 'news.example.com', 'news'),
], ...o });
const loose = () => [T('u1', 'Design review notes', 'notes.example.com', 'note'), T('u2', 'Q4 roadmap', 'docs.example.com', 'docs'), T('u3', 'Weekly standup recording', 'video.example.com', 'video')];

const webhooks = (o = {}) => ({ group: true, id: 'g4', name: 'Stripe webhooks', agent: true, working: false, collapsed: true, status: 'done · 2 docs, 1 example', tabs: [
  T('w1', 'Webhook signatures', 'docs.example.com', 'docs'),
  T('w2', 'Event types', 'docs.example.com', 'docs'),
  T('w3', 'examples/webhooks/node.js', 'code.example.com', 'code'),
], ...o });
// agent groups live in S.agent: the section at the bottom of the sidebar (user decision)
const base = () => ({ activeId: 'r2', selection: [], pinned: pinnedBase(), unpinned: [research(), ...loose()], agent: [flights()] });

const SCENES = {
  basic: () => base(),
  'collapsed-active': () => { const s = base(); s.unpinned[0].collapsed = true; return s; },
  multiselect: () => { const s = base(); s.selection = ['r2', 'r4', 'u1']; return s; },
  'context-menu': () => {
    const s = base(); s.selection = ['r2', 'r4', 'u1'];
    // pointer on "Retries and backoff" (y≈448); macOS shifts the menu up so it fits the screen
    const y = 300;
    s.menu = { x: 150, y, items: [
      { label: 'Move 3 Tabs to Group', sub: true, hl: true }, { label: 'Remove from Group' }, '-',
      { label: 'Pin 3 Tabs' }, { label: 'Duplicate' }, { label: 'Copy Links' }, { label: 'Reload' }, { label: 'Mute' }, '-',
      { label: 'Open in Split View with Current Tab', dis: true }, '-',
      { label: 'Open in New Window' }, '-',
      { label: 'Unload (Free Memory)' }, { label: 'Close 3 Tabs' }, { label: 'Close Other Tabs' },
    ], submenu: { x: 150 + 212 + 2, y: y, items: [
      { label: 'New Group with 3 Tabs', k: '⌃⌘N' }, '-',
      // mixed selection (two in Research, one loose): Research stays a valid target, so no ✓
      { label: 'Research' }, { label: 'Flights to Lisbon', icon: `<span class="agent-glyph">${ICON.sparkle}</span>` },
    ] } };
    return s;
  },
  'group-menu': () => {
    const s = base();
    s.menu = { x: 120, y: 298, items: [
      { label: 'New Tab in Group' }, { label: 'Rename' }, '-',
      { label: 'Collapse' }, { label: 'Collapse Other Groups' }, '-',
      { label: 'Copy All Links' }, { label: 'Ungroup (Keep Tabs)' }, '-',
      { label: 'Close Group' },
    ] };
    return s;
  },
  'drag-into': () => {
    const s = base(); s.unpinned[0].collapsed = true; s.activeId = 'u2';
    s.selection = ['u1', 'u3'];
    s.drag = { src: ['u1', 'u3'], into: 'g1', ghost: { id: 'u1', title: 'Design review notes', count: 2, x: 92, y: 176 } };
    return s;
  },
  'drag-reorder': () => {
    const s = base(); s.activeId = 'u2';
    s.drag = { src: ['u3'], before: 'r3', ghost: { id: 'u3', title: 'Weekly standup recording', count: 1, x: 110, y: 236 } };
    return s;
  },
  rename: () => { const s = base(); s.rename = 'g1'; return s; },
  'agent-working': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [flights({ collapsed: true })]; s.activeId = 'u2'; return s; },
  'agent-expanded': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [flights({ collapsed: false, status: 'reading fare rules' })]; s.activeId = 'u2'; s.agent[0].tabs[2].loading = true; return s; },
  'agent-done': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [flights({ collapsed: true, working: false, status: 'done · cheapest $612' })]; s.activeId = 'u2'; return s; },
  'agent-hover': () => { const s = SCENES['agent-working'](); s.hover = 'g2'; return s; },
  'agent-hover-done': () => { const s = SCENES['agent-done'](); s.hover = 'g2'; return s; },
  'agent-emptied': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [flights({ collapsed: true, status: 'comparing 3 fares', tabs: [] })]; s.activeId = 'u2'; return s; },
  'many-groups-w500': () => { const s = SCENES['many-groups'](); s.w500 = true; return s; },
  'basic-w500': () => { const s = SCENES.basic(); s.w500 = true; return s; },
  // the active tab is inside a collapsed agent group (user ⌃Tab'd there, or clicked it before collapsing)
  'agent-active': () => { const s = SCENES['agent-done'](); s.activeId = 'f1'; return s; },
  // two agent groups stacked at the bottom: newest last, one working, one done
  'two-agents': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [webhooks(), flights({ collapsed: true })]; s.activeId = 'u2'; return s; },
  // an agent group just created, no tabs yet
  'agent-starting': () => { const s = base(); s.unpinned = [research({ collapsed: true }), ...loose()]; s.agent = [flights({ collapsed: true, status: 'starting…', tabs: [] })]; s.activeId = 'u2'; return s; },
  empty: () => { const s = base(); s.unpinned = [{ group: true, id: 'g3', name: 'Untitled Group', tabs: [] }, research({ collapsed: true }), ...loose()]; s.rename = 'g3'; s.activeId = 'u1'; return s; },
  'empty-named': () => { const s = base(); s.unpinned = [{ group: true, id: 'g3', name: 'Apartment hunt', tabs: [] }, research({ collapsed: true }), ...loose()]; s.activeId = 'u1'; return s; },
  'long-names': () => {
    const s = base();
    s.unpinned = [
      research({ name: 'Q4 planning — competitor pricing research (EMEA + APAC)', tabs: [T('r1', 'A very long page title that keeps going and going — Documentation — Example', 'docs.example.com', 'docs'), T('r2', 'Short', 'code.example.com', 'code')] }),
      ...loose(),
    ];
    s.agent = [flights({ name: 'Find the cheapest nonstop flights from San Francisco to Lisbon in November', status: 'comparing fares across 4 sites and 2 dates' })];
    s.activeId = 'r2';
    return s;
  },
  'many-groups': () => {
    const s = base();
    const mk = (i, name, favs) => ({ group: true, id: 'm' + i, name, collapsed: true, tabs: favs.map((f, j) => T(`m${i}t${j}`, name + ' ' + j, f + '.example.com', f)) });
    s.unpinned = [
      research({ collapsed: true }),
      mk(1, 'Apartment hunt', ['shop', 'shop', 'news', 'docs']), mk(2, 'Tax return', ['bank', 'docs', 'note']), mk(3, 'Onboarding deck', ['figma', 'docs']),
      mk(4, 'Hiring — design', ['docs', 'mail', 'cal', 'note', 'chat']), mk(5, 'Reading', ['news', 'news', 'news']), mk(6, 'Car', ['shop', 'video']),
      mk(7, 'Conference talk', ['figma', 'video', 'docs', 'code']),
      ...loose(),
    ];
    s.activeId = 'u2';
    return s;
  },
  'split-in-group': () => {
    const s = base();
    s.unpinned[0].tabs = [s.unpinned[0].tabs[0], { split: [s.unpinned[0].tabs[1], s.unpinned[0].tabs[2]] }, s.unpinned[0].tabs[3]];
    s.activeId = 'r2';
    return s;
  },
  'no-groups': () => { const s = base(); s.unpinned = loose(); s.agent = []; s.activeId = 'u1'; return s; },
};

S = (SCENES[SCENE] || SCENES.basic)();
render();
