// olive chrome ui: sidebar, cards, palette, find bar. talks to main via window.olive.
'use strict';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
if (params.get('private')) document.body.classList.add('private');

let S = null; // latest window state from main
let drag = null; // tab drag in progress
let pressing = null; // pointer down on a tab, maybe becoming a drag

const ICON = {
  command: '<svg viewBox="0 0 16 16"><path d="M5 6H3.5a1.5 1.5 0 1 1 1.5-1.5V11.5a1.5 1.5 0 1 1-1.5-1.5h9a1.5 1.5 0 1 1-1.5 1.5V4.5A1.5 1.5 0 1 1 12.5 6Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  reset: '<svg viewBox="0 0 16 16"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.6 1.9v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor"/><path d="m11 6 3.5 4M14.5 6 11 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  tab: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.3"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 10 10"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sparkle: '<svg viewBox="0 0 16 16"><path d="M7 1.6c.35 2.9 2.5 5.05 5.4 5.4-2.9.35-5.05 2.5-5.4 5.4-.35-2.9-2.5-5.05-5.4-5.4C4.5 6.65 6.65 4.5 7 1.6z" fill="currentColor"/><path d="M12.6 10.2c.15 1.2 1 2.05 2.2 2.2-1.2.15-2.05 1-2.2 2.2-.15-1.2-1-2.05-2.2-2.2 1.2-.15 2.05-1 2.2-2.2z" fill="currentColor"/></svg>',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function letterOf(t) {
  const h = (/^https?:/.test(t.url || '') ? t.host : t.title || t.host || '?').replace(/^www\./, '');
  return esc((h[0] || '?').toUpperCase());
}

function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const brokenFavs = new Set();
function wireFavicons(root) {
  root.querySelectorAll('img.fav').forEach((img) => {
    img.addEventListener('error', () => {
      brokenFavs.add(img.dataset.fav);
      const s = document.createElement('span');
      s.className = 'fav letter';
      s.style.background = `hsl(${img.dataset.hue} 35% 48%)`;
      s.textContent = img.dataset.letter;
      img.replaceWith(s);
    }, { once: true });
  });
}

function favHtml(t, extra = '') {
  if (t.loading) return '<span class="spinner"></span>';
  const cls = extra ? ' ' + extra : '';
  if (t.favicon && !brokenFavs.has(t.favicon)) return `<img class="fav${cls}" src="${esc(t.favicon)}" data-fav="${esc(t.favicon)}" data-letter="${letterOf(t)}" data-hue="${hue(t.host)}">`;
  return `<span class="fav letter${cls}" style="background:hsl(${hue(t.host)} 35% 48%)">${letterOf(t)}</span>`;
}

// ---------- tab groups (notes/tab-groups-mac-design.md) ----------
// selection and the open rename field live here; main gets id arrays for menus and drops.

let sel = []; // selected tab ids (visual only; the active tab stays what it is)
let selAnchor = null; // last clicked tab, for ⇧-click ranges
let renaming = null; // { id } while a group's name is a field
let renamingTab = null; // { id } while a tab's title is a field (Rename Tab…)

function allTabs() {
  return [...S.pinned, ...S.unpinned, ...S.agentTabs];
}

function findTab(id) {
  return allTabs().find((t) => t.id === id);
}

function groupOf(t) {
  return t && t.groupId != null ? S.groups[t.groupId] || null : null;
}

function setSelection(ids, anchor) {
  sel = ids;
  if (anchor !== undefined) selAnchor = anchor;
  olive.cmd('selection', { ids: sel });
  render();
}

// ⇧-click: the range between the anchor and the target over the visible rows; a collapsed
// group's members join only when the anchor is inside that group (Finder selects what you see)
function rangeSelect(anchor, target) {
  const at = findTab(anchor);
  const order = allTabs().filter((t) => { const g = groupOf(t); return !g || !g.collapsed || (at && g.id === at.groupId); }).map((t) => t.id);
  let a = order.indexOf(anchor);
  let b = order.indexOf(target);
  if (a < 0 || b < 0) return [target];
  if (a > b) [a, b] = [b, a];
  return order.slice(a, b + 1);
}

function rowHtml(t, { inSplit = false, focus = false } = {}) {
  const cls = ['row'];
  if (!S.onboarding?.active && !S.appPage && S.activeId === t.id && !inSplit) cls.push('active');
  if (inSplit && focus) cls.push('focus');
  if (t.unloaded) cls.push('unloaded');
  if (sel.includes(t.id)) cls.push('selected');
  const audio = t.audible || t.muted ? `<span class="audio" data-act="mute" title="${t.muted ? 'Unmute' : 'Mute'}">${t.muted ? ICON.muted : ICON.audio}</span>` : '';
  const crash = t.crashed ? '<span class="crash" title="Page crashed. Click to reload">crashed</span>' : '';
  // a pinned tab that wandered off its pinned url: ↺ takes it back (arc)
  if (t.pinned && t.drifted) cls.push('drifted');
  const reset = t.pinned && t.drifted ? `<span class="reset" data-act="reset-pinned" title="Back to Pinned URL\n${esc(t.pinnedUrl)}">${ICON.reset}</span>` : '';
  if (renamingTab?.id === t.id) cls.push('renaming');
  const title = renamingTab?.id === t.id
    ? `<input class="rename tab-rename" value="${esc(t.title)}" placeholder="${esc(t.pageTitle || t.host || 'Tab name')}" maxlength="200" spellcheck="false" autocomplete="off">`
    : `<span class="title${t.customTitle ? ' custom' : ''}">${esc(t.title)}</span>`;
  const tip = t.customTitle && t.pageTitle && t.pageTitle !== t.customTitle ? `${esc(t.title)}\n${esc(t.pageTitle)}\n${esc(t.url)}` : `${esc(t.title)}\n${esc(t.url)}`;
  return `<div class="${cls.join(' ')}" data-id="${t.id}" title="${tip}">${favHtml(t)}${title}${crash}${audio}${reset}<span class="close" data-act="close" title="${t.pinned ? 'Unload' : 'Close'} (⌘W)">${ICON.close}</span></div>`;
}

function splitHtml(members) {
  const active = members.some((m) => m.id === S.activeId);
  const t = members[0];
  return `<div class="split-group${active ? ' active' : ''}" data-split="${t.splitId}" data-id="${t.id}">${members.map((m) => rowHtml(m, { inSplit: true, focus: m.id === S.activeId })).join('')}</div>`;
}

// rows and splits of one flat run (no groups inside)
function runHtml(tabs) {
  const out = [];
  const done = new Set();
  for (const t of tabs) {
    if (done.has(t.id)) continue;
    if (t.splitId) {
      const members = tabs.filter((x) => x.splitId === t.splitId);
      members.forEach((m) => done.add(m.id));
      out.push(splitHtml(members));
    } else {
      out.push(rowHtml(t));
      done.add(t.id);
    }
  }
  return out.join('');
}

// a list: contiguous runs of one groupId become a group block
function listHtml(tabs) {
  const out = [];
  let i = 0;
  while (i < tabs.length) {
    const gid = tabs[i].groupId;
    let j = i;
    while (j < tabs.length && tabs[j].groupId === gid) j++;
    const run = tabs.slice(i, j);
    const g = gid != null ? S.groups[gid] : null;
    out.push(g ? groupHtml(g, run) : runHtml(run));
    i = j;
  }
  return out.join('');
}

// the agent section: every agent group in agentOrder, empty ones included
function agentHtml() {
  return (S.agentOrder || []).map((gid) => {
    const g = S.groups[gid];
    return g ? groupHtml(g, S.agentTabs.filter((t) => t.groupId === g.id)) : '';
  }).join('');
}

function groupHtml(g, tabs) {
  const n = tabs.length;
  const hasActive = tabs.some((t) => t.id === S.activeId);
  const cls = ['group'];
  if (g.collapsed) cls.push('collapsed');
  if (g.agent) cls.push('agent');
  if (g.working) cls.push('working');
  const head = ['row', 'group-head'];
  if (g.collapsed && hasActive) head.push('active');
  let title = renaming?.id === g.id
    ? `<input class="rename" value="${esc(g.name)}" maxlength="60" spellcheck="false" autocomplete="off">`
    : `<span class="title">${esc(g.name)}</span>`;
  const glyph = g.agent ? `<span class="agent-glyph" title="Opened by an agent">${ICON.sparkle}</span>` : '';
  if (g.status && renaming?.id !== g.id) title = `<span class="lines">${title}<span class="status">${esc(g.status)}</span></span>`;
  const pulse = g.working ? '<span class="pulse" title="Agent is working"></span>' : '';
  // newest first, up to three; the loading spinner in the newest slot while that page loads
  const favs = `<span class="favs">${tabs.slice(-3).reverse().map((t, i) => favHtml({ ...t, loading: i === 0 && t.loading }, t.id === S.activeId ? 'is-active' : '')).join('')}</span>`;
  const count = g.collapsed && n ? `<span class="count">${n}</span>` : '';
  const tabsWord = `${n} tab${n === 1 ? '' : 's'}`;
  const tip = g.agent ? `${esc(g.name)} · opened by an agent · ${tabsWord}` : `${esc(g.name)} · ${tabsWord}`;
  const body = n ? runHtml(tabs) : `<button class="row newtab-row" data-group-new="${g.id}"><span class="plus">+</span><span class="title">New Tab</span></button>`;
  return `<div class="${cls.join(' ')}" data-group="${g.id}"><div class="${head.join(' ')}" data-group-head="${g.id}" title="${tip}"><span class="disc">${ICON.chevron}</span>${glyph}${title}${pulse}${favs}${count}<span class="close" data-act="close-group" title="Close Group (${tabsWord})">${ICON.close}</span></div><div class="group-body">${body}</div></div>`;
}

function renderLists(force = false) {
  if (!force && (drag || renaming || renamingTab)) return;
  setHtml($('#pinned'), runHtml(S.pinned));
  setHtml($('#unpinned'), listHtml(S.unpinned));
  const agentEl = $('#agent');
  setHtml(agentEl, agentHtml());
  // scroll-edge fade only while the section actually overflows
  agentEl.classList.toggle('overflows', agentEl.scrollHeight > agentEl.clientHeight + 1);
}

// ---------- render ----------

function render() {
  if (!S) return;
  const b = document.body.classList;
  b.toggle('private', S.private);
  b.toggle('sidebar-hidden', S.sidebarHidden);
  b.toggle('peek', S.overlay === 'peek');
  b.toggle('fullscreen', S.fullscreen);
  b.toggle('loading', !!S.active?.loading);
  b.toggle('no-pinned', S.pinned.length === 0);
  b.toggle('no-agent', !(S.agentOrder || []).length);
  b.toggle('narrow', S.sidebarWidth < 210);
  b.toggle('html-fullscreen', S.htmlFullscreen);
  b.toggle('ui-on-top', !!S.overlay);
  document.documentElement.style.setProperty('--sbw', (S.sidebarHidden ? 0 : S.sidebarWidth) + 'px');

  $('#sidebar').style.width = S.sidebarWidth + 'px';

  const host = $('#urlbar .host');
  if (S.active && S.active.url) {
    host.textContent = S.active.host || S.active.url;
    host.classList.remove('placeholder');
  } else {
    host.textContent = 'Search or enter URL';
    host.classList.add('placeholder');
  }
  const lock = $('#urlbar .lock');
  lock.style.display = S.active?.url ? '' : 'none';
  lock.classList.toggle('insecure', !!S.active && !S.active.secure);
  $('#btn-back').disabled = !S.active?.canGoBack;
  $('#btn-forward').disabled = !S.active?.canGoForward;
  $('#btn-devtools').classList.toggle('on', !!S.active?.devtools);
  $('#profile-badge').textContent = S.private ? 'Private' : '';
  $('#settings-row').hidden = !S.appPage;
  $('#settings-row .title').textContent=S.appPage?.title||'';
  $('#setup-row').hidden = !S.onboarding;
  $('#setup-row').classList.toggle('active',!!S.onboarding?.active);
  $('#setup-left').textContent = S.onboarding?.step && S.onboarding.step!=='welcome' ? `${S.onboarding.remaining} left` : '';
  // extension buttons are opt-in per extension (Extensions settings); hidden by default
  $('#btn-ublock').hidden = S.private || S.extension?.showInToolbar !== true;
  $('#btn-ledger').hidden = S.private;
  $('#btn-ublock').textContent = S.extension?.enabled ? 'uBO Lite · on' : 'uBO Lite · off';
  $('#btn-ublock').onclick = () => olive.cmd('ublock');
  $('#btn-clear').classList.toggle('none', !S.looseCount); // Clear closes the loose tabs only; groups stay (keeps its slot: the hairline never jumps)

  // a selection only holds tabs that still exist
  const live = new Set(allTabs().map((t) => t.id));
  if (sel.some((id) => !live.has(id))) { sel = sel.filter((id) => live.has(id)); olive.cmd('selection', { ids: sel }); }
  if (renaming && !S.groups[renaming.id]) renaming = null;

  renderLists();

  renderCards();
  renderFind();
  renderDownloads();

  const left = S.sidebarHidden ? 0 : S.sidebarWidth;
  const empty = $('#empty');
  empty.hidden = S.panes.length > 0;
  empty.style.left = left + 'px';

  if (S.overlay !== 'palette' && pal.open) hidePalette();
}

function renderCards() {
  const cards = $('#cards');
  const html = [];
  if (!S.htmlFullscreen) {
    const multi = S.panes.length > 1;
    for (const p of S.panes) {
      const f = multi && p.id === S.activeId ? ' focused-pane' : '';
      html.push(`<div class="card${f}" style="${rect(p.page)}"></div>`);
      if (p.devtools) {
        html.push(`<div class="card" style="${rect(p.devtools)}"></div>`);
        const x = p.page.x + p.page.width;
        html.push(`<div class="splitter" data-devtools="${p.id}" style="left:${x}px;top:${p.rect.y}px;width:${p.devtools.x - x}px;height:${p.rect.height}px"></div>`);
      }
    }
    for (let i = 0; i < S.panes.length - 1; i++) {
      const p = S.panes[i];
      const n = S.panes[i + 1];
      const x = p.rect.x + p.rect.width;
      html.push(`<div class="splitter" data-split="${p.splitId}" data-index="${i}" style="left:${x - 2}px;top:${p.rect.y}px;width:${n.rect.x - x + 4}px;height:${p.rect.height}px"></div>`);
    }
  }
  setHtml(cards, html.join(''));
}

function setHtml(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
  wireFavicons(el);
}

function rect(r) {
  return `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
}

function renderFind() {
  const fb = $('#findbar');
  fb.hidden = !S.find.open;
  if (!S.find.open) return;
  const left = S.sidebarHidden ? 8 : S.sidebarWidth;
  fb.style.left = '';
  fb.style.right = '8px';
  fb.style.maxWidth = `calc(100vw - ${left + 16}px)`;
  const c = $('#find-count');
  c.textContent = S.find.query ? (S.find.matches ? `${S.find.active}/${S.find.matches}` : 'no results') : '';
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

function renderDownloads() {
  const box = $('#downloads');
  const list = S.downloads || [];
  box.hidden = list.length === 0;
  if (!list.length) return;
  box.innerHTML = `<div class="dl-head">Downloads<button data-act="clear-dl">Clear</button></div>` + list.slice(0, 4).map((d) => {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    const meta = d.state === 'progressing' ? `${fmtBytes(d.received)}${d.total ? ' / ' + fmtBytes(d.total) : ''}` : d.state === 'completed' ? fmtBytes(d.received) : d.state;
    const bar = d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '';
    return `<div class="dl" data-path="${esc(d.path)}" data-state="${d.state}" title="${esc(d.path)}"><div class="col"><div class="name">${esc(d.filename)}</div>${bar}</div><span class="meta">${esc(meta)}</span></div>`;
  }).join('');
}

// ---------- sidebar interactions ----------

$('#settings-close').onclick = e => {e.stopPropagation();olive.cmd('closePanel');};
$('#setup-row').onclick = () => olive.cmd('onboarding');
$('#setup-close').onclick = e => {e.stopPropagation();olive.cmd('onboardingLater');};
$('#btn-sidebar').onclick = () => olive.cmd('toggleSidebar');
$('#btn-back').onclick = () => olive.cmd('back');
$('#btn-forward').onclick = () => olive.cmd('forward');
$('#btn-reload').onclick = () => olive.cmd(S?.active?.loading ? 'stop' : 'reload');
$('#btn-new').onclick = () => olive.cmd('newTab');
$('#newtab').onclick = () => olive.cmd('newTab');
$('#btn-split').onclick = () => olive.cmd('splitNew');
$('#btn-devtools').onclick = () => olive.cmd('devtools');
$('#btn-clear').onclick = () => olive.cmd('clearUnpinned');
$('#btn-copy').onclick = (e) => { e.stopPropagation(); olive.cmd('copyUrl'); };
$('#btn-site-settings').onclick = (e) => { e.stopPropagation(); olive.cmd('sitePermissions'); };
$('#urlbar').onclick = () => olive.cmd('openLocation');

$('#downloads').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="clear-dl"]')) return olive.cmd('clearDownloads');
  const d = e.target.closest('.dl');
  if (!d) return;
  if (d.dataset.state === 'completed') olive.cmd('openDownload', { path: d.dataset.path });
  else olive.cmd('showDownload', { path: d.dataset.path });
});
$('#downloads').addEventListener('contextmenu', (e) => {
  const d = e.target.closest('.dl');
  if (d) olive.cmd('showDownload', { path: d.dataset.path });
});

// rows live in #tablist and in the agent section below it: listen on the sidebar
const sidebar = $('#sidebar');
const tablist = $('#tablist');
let justDragged = false;

function tabIdFrom(el) {
  const row = el.closest('.row[data-id]');
  return row ? Number(row.dataset.id) : null;
}

function groupIdFrom(el) {
  const head = el.closest('.group-head');
  return head ? Number(head.dataset.groupHead) : null;
}

function tabClick(p) {
  if (p.act === 'close') return olive.cmd('closeTabId', { id: p.id });
  if (p.act === 'mute') return olive.cmd('mute', { id: p.id });
  if (p.act === 'reset-pinned') return olive.cmd('resetPinned', { id: p.id });
  // ⌘-click toggles a tab in the selection, ⇧-click selects a range; a plain click
  // activates and clears the selection (2.1)
  if (p.meta) {
    const next = sel.includes(p.id) ? sel.filter((x) => x !== p.id) : [...sel, p.id];
    return setSelection(next, p.id);
  }
  if (p.shift && selAnchor != null && findTab(selAnchor)) {
    const range = rangeSelect(selAnchor, p.id);
    return setSelection([...new Set([...sel.filter((x) => !range.includes(x)), ...range])]);
  }
  if (sel.length) setSelection([], p.id);
  else selAnchor = p.id;
  olive.cmd('activate', { id: p.id });
  if (S.overlay === 'peek') olive.cmd('overlay', { kind: null });
}

function headClick(p) {
  if (p.act === 'close-group') return olive.cmd('closeGroup', { id: p.group });
  if (p.alt) return olive.cmd('collapseAll', { collapsed: !S.groups[p.group]?.collapsed }); // ⌥-click: every group follows
  olive.cmd('toggleGroup', { id: p.group });
}

sidebar.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const id = tabIdFrom(e.target);
  if (id != null) olive.cmd('closeTabId', { id });
});

sidebar.addEventListener('contextmenu', (e) => {
  const gid = groupIdFrom(e.target);
  if (gid != null) { e.preventDefault(); return olive.cmd('groupMenu', { id: gid }); }
  const id = tabIdFrom(e.target);
  if (id == null) return;
  e.preventDefault();
  if (!sel.includes(id) && sel.length) setSelection([], id); // right-click outside the selection drops it (Finder)
  olive.cmd('tabMenu', { id, ids: sel.includes(id) ? sel : [id] });
});

sidebar.addEventListener('click', (e) => {
  const nt = e.target.closest('[data-group-new]');
  if (nt) olive.cmd('newTabInGroup', { id: Number(nt.dataset.groupNew) });
});

// double-click a group's name to rename it; a tab's title too (Rename Tab…)
sidebar.addEventListener('dblclick', (e) => {
  if (e.target.closest('.close, .rename, [data-act]')) return;
  const gid = groupIdFrom(e.target);
  if (gid != null) return startRename(gid);
  const id = tabIdFrom(e.target);
  if (id != null && e.target.closest('.row .title')) startTabRename(id);
});

// the tab's title becomes a field. enter/blur keeps it, escape cancels, an empty field
// goes back to the page title
function startTabRename(id) {
  if (!findTab(id) || renaming) return;
  renamingTab = { id };
  renderLists(true);
  const field = sidebar.querySelector(`.row[data-id="${id}"] .tab-rename`);
  if (!field) return void (renamingTab = null);
  olive.cmd('focusUi'); // the row click put native focus in the page
  field.focus();
  field.select();
  const before = findTab(id);
  const finish = (commit) => {
    if (renamingTab?.id !== id) return;
    renamingTab = null;
    const name = field.value.replace(/\s+/g, ' ').trim();
    if (commit && name !== (before?.customTitle || '')) {
      // typing the page title back (or nothing) is a reset, not a name
      olive.cmd('renameTab', { id, name: name === before?.pageTitle ? '' : name });
    }
    renderLists(true);
    render();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('pointerdown', (e) => e.stopPropagation());
  field.addEventListener('dblclick', (e) => e.stopPropagation());
}

function startRename(id) {
  if (!S?.groups[id]) return;
  renaming = { id };
  renderLists(true);
  const field = sidebar.querySelector('.group-head .rename');
  if (!field) return void (renaming = null);
  olive.cmd('focusUi');
  field.focus();
  field.select();
  const finish = (commit) => {
    if (!renaming) return;
    const name = field.value.trim();
    renaming = null;
    if (commit && name && name !== S.groups[id]?.name) olive.cmd('renameGroup', { id, name });
    renderLists(true);
    render();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// ---------- drag to reorder / into a group / onto content to split ----------

sidebar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.rename')) return;
  const act = e.target.closest('[data-act]')?.dataset.act || null;
  const gid = groupIdFrom(e.target);
  if (gid != null) {
    pressing = { group: gid, act, alt: e.altKey, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    return;
  }
  const id = tabIdFrom(e.target);
  if (id == null) return;
  pressing = { id, act, meta: e.metaKey, shift: e.shiftKey, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
});

window.addEventListener('pointermove', (e) => {
  if (pressing && !drag && !pressing.act) {
    if (Math.hypot(e.clientX - pressing.x, e.clientY - pressing.y) < 5) return;
    startDrag(e);
  }
  if (drag) moveDrag(e);
});

window.addEventListener('pointerup', (e) => {
  if (drag) endDrag(e);
  else if (pressing && e.button === 0) pressing.group != null ? headClick(pressing) : tabClick(pressing);
  pressing = null;
});

function startDrag(e) {
  const g = $('#drag-ghost');
  if (pressing.group != null) {
    const group = S.groups[pressing.group];
    if (!group) return void (pressing = null);
    const ids = allTabs().filter((t) => t.groupId === group.id).map((t) => t.id);
    drag = { group: group.id, agent: group.agent, ids, target: null, split: false };
    g.innerHTML = `<span class="disc">${ICON.chevron}</span><span class="name">${esc(group.name)}</span>` + (ids.length ? `<span class="badge">${ids.length}</span>` : '');
    sidebar.querySelector(`.group[data-group="${group.id}"]`)?.classList.add('dragging-src');
  } else {
    const t = findTab(pressing.id);
    if (!t) return void (pressing = null);
    // the selection moves as one when the pressed tab is part of it; splits stay whole
    const base = sel.includes(t.id) ? sel : [t.id];
    const splitIds = new Set(allTabs().filter((x) => x.splitId).filter((x) => base.some((id) => findTab(id)?.splitId === x.splitId)).map((x) => x.id));
    const ids = allTabs().map((x) => x.id).filter((id) => base.includes(id) || splitIds.has(id));
    drag = { id: t.id, ids, target: null, split: false, title: t.title };
    g.innerHTML = favHtml({ ...t, loading: false }) + `<span class="name-plain">${esc(t.title)}</span>` + (ids.length > 1 ? `<span class="badge">${ids.length}</span>` : '');
    for (const id of ids) sidebar.querySelector(`.row[data-id="${id}"]`)?.closest('.split-group, .row')?.classList.add('dragging-src');
  }
  try { sidebar.setPointerCapture(pressing.pointerId); } catch {}
  g.hidden = false;
  // ui goes on top so the ghost and split hint are visible over pages
  olive.cmd('overlay', { kind: 'drag' });
  moveDrag(e);
}

function clearDropMarks() {
  sidebar.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

const isSrc = (el) => el.classList.contains('dragging-src');

// flat index in a list = number of rows that are not being dragged before a DOM point
function flatIndex(listEl, upTo, inclusive) {
  const rows = [...listEl.querySelectorAll('.row[data-id]')].filter((r) => !drag.ids.includes(Number(r.dataset.id)));
  let n = 0;
  for (const r of rows) {
    const pos = upTo.compareDocumentPosition(r);
    const before = pos & Node.DOCUMENT_POSITION_PRECEDING;
    const inside = pos & Node.DOCUMENT_POSITION_CONTAINED_BY;
    if (before || (inclusive && (inside || r === upTo))) n++;
  }
  return n;
}

function moveDrag(e) {
  const g = $('#drag-ghost');
  g.style.left = e.clientX + 10 + 'px';
  g.style.top = e.clientY - 17 + 'px';
  clearDropMarks();
  const label = g.querySelector('.name-plain');
  const sidebarRight = S.sidebarHidden ? 0 : S.sidebarWidth;
  let hint = $('#drop-split-hint');
  if (drag.group == null && drag.ids.length === 1 && e.clientX > sidebarRight + 20 && S.panes.length && !drag.ids.includes(S.activeId)) {
    drag.split = true;
    drag.target = null;
    const last = S.panes[S.panes.length - 1];
    const r = S.panes.length > 1 ? last.rect : { ...last.rect, x: last.rect.x + last.rect.width / 2, width: last.rect.width / 2 };
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'drop-split-hint';
      document.body.appendChild(hint);
    }
    Object.assign(hint.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
    if (label) label.textContent = 'Open in split view';
    return;
  }
  hint?.remove();
  drag.split = false;
  if (label) label.textContent = drag.title;
  drag.target = null;

  // which section: the agent section (below its hairline), the pinned strip, or the user's list
  const noAgent = document.body.classList.contains('no-agent');
  const agentTop = noAgent ? Infinity : sidebar.querySelector('.agent-divider').getBoundingClientRect().top;
  const divider = $('#divider').getBoundingClientRect();
  const listName = e.clientY >= agentTop ? 'agent' : e.clientY < divider.top + divider.height / 2 ? 'pinned' : 'unpinned';
  const listEl = $('#' + listName);

  if (drag.group != null) {
    // a group block moves between top-level items of its own list only (2.5)
    if ((drag.agent && listName !== 'agent') || (!drag.agent && listName !== 'unpinned')) return;
    const items = [...listEl.children].filter((el) => !isSrc(el));
    const hit = nearest(items, e.clientY);
    if (!hit) { drag.target = { list: listName, index: 0 }; return; }
    hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
    drag.target = drag.agent
      ? { list: 'agent', index: items.indexOf(hit.el) + (hit.after ? 1 : 0) }
      : { list: 'unpinned', index: flatIndex(listEl, hit.el, hit.after) };
    return;
  }

  if (listName === 'agent') {
    // tabs join an agent group (onto its header, or between its members); never loose here
    const groups = [...listEl.querySelectorAll('.group')];
    const el = groups.find((x) => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; }) || groups[groups.length - 1];
    if (!el) return;
    dropInGroup(el, listEl, e);
    return;
  }

  const items = [...listEl.children].filter((el) => !isSrc(el));
  if (!items.length) {
    listEl.classList.add('drop-into');
    drag.target = { list: listName, index: 0, groupId: null };
    return;
  }
  const hit = nearest(items, e.clientY);
  if (!hit) return;
  if (hit.el.classList.contains('group')) {
    const gid = Number(hit.el.dataset.group);
    const own = drag.ids.every((id) => findTab(id)?.groupId === gid);
    const headRect = hit.el.querySelector('.group-head').getBoundingClientRect();
    const collapsed = hit.el.classList.contains('collapsed');
    // a member dragged left of the indent, or past the group's ends, leaves its group
    if (own && (e.clientX < headRect.left + 30 || collapsed)) {
      hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
      drag.target = { list: 'unpinned', index: flatIndex(listEl, hit.el, hit.after), groupId: null };
      if (label) label.textContent = `Move out of ${S.groups[gid]?.name || 'group'}`;
      return;
    }
    if (e.clientY <= headRect.bottom || collapsed) {
      if (e.clientY < headRect.top + 6 && !own) {
        hit.el.classList.add('drop-before');
        drag.target = { list: 'unpinned', index: flatIndex(listEl, hit.el, false), groupId: null };
        return;
      }
      hit.el.querySelector('.group-head').classList.add('drop-into');
      drag.target = { list: 'unpinned', index: flatIndex(listEl, hit.el, true), groupId: gid };
      return;
    }
    dropInGroup(hit.el, listEl, e);
    return;
  }
  hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
  drag.target = { list: listName, index: flatIndex(listEl, hit.el, hit.after), groupId: null };
}

// inside an expanded group block: onto the header appends, between members inserts
function dropInGroup(groupEl, listEl, e) {
  const gid = Number(groupEl.dataset.group);
  const head = groupEl.querySelector('.group-head');
  const headRect = head.getBoundingClientRect();
  const listName = listEl.id;
  if (groupEl.classList.contains('collapsed') || e.clientY <= headRect.bottom) {
    head.classList.add('drop-into');
    drag.target = { list: listName, index: flatIndex(listEl, groupEl, true), groupId: gid };
    return;
  }
  const members = [...groupEl.querySelectorAll(':scope > .group-body > .row[data-id], :scope > .group-body > .split-group')].filter((el) => !isSrc(el));
  const hit = nearest(members, e.clientY);
  if (!hit) {
    head.classList.add('drop-into');
    drag.target = { list: listName, index: flatIndex(listEl, groupEl, true), groupId: gid };
    return;
  }
  hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
  drag.target = { list: listName, index: flatIndex(listEl, hit.el, hit.after), groupId: gid };
}

// the item under y, or the last one above it; after = pointer in its lower half
function nearest(items, y) {
  if (!items.length) return null;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (y < r.top) return { el, after: false };
    if (y <= r.bottom) return { el, after: y > r.top + r.height / 2 };
  }
  return { el: items[items.length - 1], after: true };
}

function endDrag() {
  const d = drag;
  drag = null;
  pressing = null;
  try { sidebar.releasePointerCapture(d.pointerId); } catch {}
  $('#drag-ghost').hidden = true;
  $('#drop-split-hint')?.remove();
  clearDropMarks();
  sidebar.querySelectorAll('.dragging-src').forEach((el) => el.classList.remove('dragging-src'));
  $('#pinned')._html = $('#unpinned')._html = $('#agent')._html = null;
  justDragged = true;
  setTimeout(() => (justDragged = false), 50);
  olive.cmd('overlay', { kind: null });
  if (d.group != null) { if (d.target) olive.cmd('moveGroup', { id: d.group, index: d.target.index }); }
  else if (d.split && S.activeId) olive.cmd('split', { a: S.activeId, b: d.id });
  else if (d.target) olive.cmd('move', { ids: d.ids, list: d.target.list, index: d.target.index, groupId: d.target.groupId ?? null });
  render();
}

// ---------- splitters (split panes, devtools, sidebar width) ----------

function dragHandle(el, onMove, onEnd) {
  el.classList.add('dragging');
  let raf = 0;
  let last = null;
  const move = (e) => {
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; onMove(last); });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    document.body.style.cursor = '';
    onEnd && onEnd();
  };
  document.body.style.cursor = 'col-resize';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

$('#cards').addEventListener('pointerdown', (e) => {
  const sp = e.target.closest('.splitter');
  if (!sp) return;
  e.preventDefault();
  try { sp.setPointerCapture(e.pointerId); } catch {}
  if (sp.dataset.devtools) {
    const id = Number(sp.dataset.devtools);
    const pane = S.panes.find((p) => p.id === id);
    dragHandle(sp, (ev) => {
      const r = pane.rect;
      const ratio = (r.x + r.width - ev.clientX) / r.width;
      olive.cmd('devtoolsRatio', { id, ratio });
    });
    return;
  }
  const i = Number(sp.dataset.index);
  const splitId = Number(sp.dataset.split);
  const panes = S.panes;
  const total = panes.reduce((s, p) => s + p.rect.width, 0);
  const x0 = panes[0].rect.x;
  dragHandle(sp, (ev) => {
    const widths = panes.map((p) => p.rect.width);
    const leftEdge = panes[i].rect.x;
    const pairW = widths[i] + widths[i + 1];
    const nw = Math.max(220, Math.min(pairW - 220, ev.clientX - leftEdge - 4));
    widths[i] = nw;
    widths[i + 1] = pairW - nw;
    olive.cmd('splitRatios', { splitId, ratios: widths.map((w) => w / total) });
    void x0;
  });
});

$('#sidebar-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  dragHandle(e.target, (ev) => olive.cmd('sidebarWidth', { width: ev.clientX }));
});

// ---------- peek sidebar when hidden ----------

let peekCloseTimer = null;
const keepPeek = () => { clearTimeout(peekCloseTimer); peekCloseTimer = null; };
const leavePeek = () => {
  if (peekCloseTimer || drag || S?.overlay !== 'peek') return;
  // A short crossing grace prevents oscillation at the native titlebar/DOM
  // boundary and lets the pointer return from the page without a flicker.
  peekCloseTimer = setTimeout(() => {
    peekCloseTimer = null;
    if (!drag && S?.overlay === 'peek') olive.cmd('overlay', { kind: null });
  }, 160);
};
$('#peek-zone').addEventListener('mouseenter', () => {
  keepPeek();
  if (S?.sidebarHidden && !S.htmlFullscreen && !S.overlay) olive.cmd('overlay', { kind: 'peek' });
});
$('#sidebar').addEventListener('mouseenter', keepPeek);
$('#sidebar').addEventListener('mouseleave', (e) => {
  // Native window buttons are not DOM children. Moving into them must not
  // collapse the sidebar they belong to. The whole top/left envelope is safe.
  if (e.clientX > S?.sidebarWidth + 24 || e.clientX < 0 || e.clientY < 0 || e.clientY >= innerHeight) leavePeek();
});
document.addEventListener('mousemove', (e) => {
  if (S?.overlay !== 'peek') { keepPeek(); return; }
  if (e.clientX >= 0 && e.clientX <= S.sidebarWidth + 24 && e.clientY >= 0 && e.clientY < innerHeight) keepPeek();
  else leavePeek();
});
window.addEventListener('blur', keepPeek);

// ---------- find ----------

const findInput = $('#find-input');
findInput.addEventListener('input', () => olive.cmd('findQuery', { query: findInput.value }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); olive.cmd('findQuery', { query: findInput.value, forward: !e.shiftKey, findNext: true }); }
  if (e.key === 'Escape') { e.preventDefault(); olive.cmd('closeFind'); }
});
$('#find-next').onclick = () => olive.cmd('findQuery', { query: findInput.value, forward: true, findNext: true });
$('#find-prev').onclick = () => olive.cmd('findQuery', { query: findInput.value, forward: false, findNext: true });
$('#find-close').onclick = () => olive.cmd('closeFind');

// ---------- palette ----------

const pal = { open: false, mode: 'new', items: [], sel: -1, seq: 0, completion: null, lastValue: '' };
const palInput = $('#palette-input');

function openPalette(mode, value) {
  pal.open = true;
  pal.mode = mode;
  pal.completion = null;
  $('#palette-scrim').hidden = false;
  $('#palette-mode').textContent = mode === 'split' ? 'Split View' : mode === 'edit' ? '' : '';
  palInput.placeholder = mode === 'split' ? 'Open in split view…' : 'Search, enter URL, or find a command…';
  palInput.value = value || '';
  pal.lastValue = palInput.value;
  palInput.focus();
  palInput.select();
  suggest(mode === 'edit' ? '' : palInput.value);
}

function hidePalette() {
  pal.open = false;
  $('#palette-scrim').hidden = true;
  $('#palette-results').innerHTML = '';
}

function closePalette() {
  hidePalette();
  olive.cmd('overlay', { kind: null });
}

async function suggest(q, { typed = false } = {}) {
  const seq = ++pal.seq;
  const items = await olive.invoke('suggest', { query: q });
  if (seq !== pal.seq || !pal.open) return;
  pal.items = items || [];
  pal.completion = null;
  // inline completion: "git" -> "github.com" when a history host starts with what was typed
  if (pal.items[0]?.kind !== 'command' && typed && q && !/\s/.test(q) && palInput.selectionStart === palInput.value.length) {
    const ql = q.toLowerCase();
    for (const it of pal.items) {
      if (it.kind !== 'history' && it.kind !== 'tab') continue;
      const host = it.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      const hostOnly = host.split('/')[0];
      if (hostOnly.toLowerCase().startsWith(ql) && hostOnly.length > q.length) {
        palInput.value = q + hostOnly.slice(q.length);
        palInput.setSelectionRange(q.length, palInput.value.length);
        pal.completion = { text: hostOnly, url: 'https://' + hostOnly + '/' };
        pal.items[0] = { kind: 'url', title: hostOnly, url: pal.completion.url, sub: 'Open' };
        break;
      }
    }
  }
  pal.sel = q ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  const box = $('#palette-results');
  box.innerHTML = pal.items.map((it, i) => {
    let icon;
    if (it.favicon && !brokenFavs.has(it.favicon)) icon = `<img class="fav" src="${esc(it.favicon)}" data-fav="${esc(it.favicon)}" data-letter="${esc((it.title || '?')[0].toUpperCase())}" data-hue="${hue(it.url)}">`;
    else icon = `<span class="fav">${it.kind === 'search' ? ICON.search : it.kind === 'tab' ? ICON.tab : it.kind === 'history' ? ICON.clock : it.kind === 'command' ? ICON.command : ICON.globe}</span>`;
    return `<div class="sug${i === pal.sel ? ' sel' : ''}" data-i="${i}">${icon}<span class="t">${esc(it.title)}</span><span class="s">${esc(it.sub || '')}</span></div>`;
  }).join('');
  wireFavicons(box);
}

palInput.addEventListener('input', (e) => {
  const typed = e.inputType && e.inputType.startsWith('insert');
  pal.lastValue = palInput.value;
  suggest(palInput.value, { typed });
});

palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    if (pal.items.length) pal.sel = (pal.sel + 1) % pal.items.length;
    renderSuggestions();
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    if (pal.items.length) pal.sel = pal.sel <= 0 ? pal.items.length - 1 : pal.sel - 1;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.isComposing) return; // IME candidate confirm, not a submit
    // ↵ current tab (edit) / new tab (cmd+t), ⇧↵ split, ⌘↵ new foreground tab
    submitPalette(e.shiftKey, e.metaKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (pal.completion && palInput.selectionStart !== palInput.selectionEnd) {
      palInput.value = palInput.value.slice(0, palInput.selectionStart);
      pal.completion = null;
      suggest(palInput.value);
      return;
    }
    closePalette();
  } else if (e.key === 'Tab' && pal.completion) {
    e.preventDefault();
    palInput.setSelectionRange(palInput.value.length, palInput.value.length);
  }
});

function submitPalette(split, newTab = false) {
  const value = palInput.value.trim();
  const item = pal.sel >= 0 ? pal.items[pal.sel] : null;
  if (!value && !item) return;
  hidePalette();
  olive.cmd('submit', { mode: pal.mode, input: value, item, split, newTab: !!newTab && !split });
}

$('#palette-results').addEventListener('mousemove', (e) => {
  const el = e.target.closest('.sug');
  if (!el) return;
  const i = Number(el.dataset.i);
  if (i !== pal.sel) { pal.sel = i; renderSuggestions(); }
});
$('#palette-results').addEventListener('click', (e) => {
  const el = e.target.closest('.sug');
  if (!el) return;
  pal.sel = Number(el.dataset.i);
  submitPalette(e.shiftKey, e.metaKey);
});
$('#palette-scrim').addEventListener('mousedown', (e) => {
  if (e.target.id === 'palette-scrim') closePalette();
});

// ---------- toast ----------

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1400);
}

// ---------- wire up ----------

olive.on('state', (s) => { S = s; render(); });
olive.on('palette', ({ mode, value }) => openPalette(mode, value));
olive.on('focus-find', () => {
  render();
  findInput.focus();
  findInput.select();
  if (findInput.value) olive.cmd('findQuery', { query: findInput.value });
});
olive.on('toast', toast);
olive.on('rename-group', ({ id }) => startRename(id));
olive.on('rename-tab', ({ id }) => startTabRename(id));
olive.invoke('state').then((s) => { if (s) { S = s; render(); } });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pal.open && S?.overlay === 'peek') olive.cmd('overlay', { kind: null });
  if (e.key === 'Escape' && !pal.open && !renaming && sel.length) setSelection([]);
  const id = enterRenameTarget(e);
  if (id != null) {
    e.preventDefault();
    // document.hasFocus() can be true in a ui view that isn't the focused webcontents;
    // main knows for sure
    olive.invoke('uiFocused').then((yes) => { if (yes && enterRenameTarget(e, true) === id) startTabRename(id); });
  }
});

// enter renames the selected tab (finder), but only when the keyboard is really in the
// sidebar: the ui webcontents has focus (a plain row click hands it to the page), no
// field / palette / find bar has it, no rename is open, and exactly one tab is selected.
// notes/tab-rename-spec.md
function enterRenameTarget(e, again = false) {
  const el = document.activeElement;
  return enterRenameId(again ? { ...pick(e), repeat: false, isComposing: false } : pick(e), {
    uiFocused: document.hasFocus(),
    paletteOpen: pal.open,
    renaming: !!(renaming || renamingTab),
    editableFocused: !!el && (el.matches('input, textarea, select, button, [contenteditable]') || el.isContentEditable),
    selection: sel,
    exists: (id) => !!findTab(id),
  });
}
const pick = (e) => ({ key: e.key, repeat: e.repeat, isComposing: e.isComposing, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey });

$('#btn-ledger').onclick = () => olive.cmd('activities');
