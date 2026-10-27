// olive chrome ui: sidebar, cards, palette, find bar. talks to main via window.olive.
'use strict';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
if (params.get('private')) document.body.classList.add('private');

let S = null; // latest window state from main
let drag = null; // tab drag in progress
let pressing = null; // pointer down on a tab, maybe becoming a drag

const ICON = {
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor"/><path d="m11 6 3.5 4M14.5 6 11 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  tab: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.3"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
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

function favHtml(t) {
  if (t.loading) return '<span class="spinner"></span>';
  if (t.favicon && !brokenFavs.has(t.favicon)) return `<img class="fav" src="${esc(t.favicon)}" data-fav="${esc(t.favicon)}" data-letter="${letterOf(t)}" data-hue="${hue(t.host)}">`;
  return `<span class="fav letter" style="background:hsl(${hue(t.host)} 35% 48%)">${letterOf(t)}</span>`;
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

function rowHtml(t, { inSplit = false, focus = false } = {}) {
  const cls = ['row'];
  if (!S.onboarding?.active && !S.appPage && S.activeId === t.id && !inSplit) cls.push('active');
  if (inSplit && focus) cls.push('focus');
  if (t.unloaded) cls.push('unloaded');
  const audio = t.audible || t.muted ? `<span class="audio" data-act="mute" title="${t.muted ? 'Unmute' : 'Mute'}">${t.muted ? ICON.muted : ICON.audio}</span>` : '';
  const crash = t.crashed ? '<span class="crash" title="Page crashed. Click to reload">crashed</span>' : '';
  return `<div class="${cls.join(' ')}" data-id="${t.id}" title="${esc(t.title)}\n${esc(t.url)}">${favHtml(t)}<span class="title">${esc(t.title)}</span>${crash}${audio}<span class="close" data-act="close" title="${t.pinned ? 'Unload' : 'Close'} (⌘W)">${ICON.close}</span></div>`;
}

function listHtml(tabs) {
  const out = [];
  const done = new Set();
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (done.has(t.id)) continue;
    if (t.splitId) {
      const members = tabs.filter((x) => x.splitId === t.splitId);
      members.forEach((m) => done.add(m.id));
      const active = members.some((m) => m.id === S.activeId);
      out.push(`<div class="split-group${active ? ' active' : ''}" data-split="${t.splitId}" data-id="${t.id}">${members.map((m) => rowHtml(m, { inSplit: true, focus: m.id === S.activeId })).join('')}</div>`);
    } else {
      out.push(rowHtml(t));
      done.add(t.id);
    }
  }
  return out.join('');
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
  $('#btn-ublock').hidden = S.private;
  $('#btn-ledger').hidden = S.private;
  $('#btn-ublock').textContent = S.extension?.enabled ? 'uBO Lite · on' : 'uBO Lite · off';
  $('#btn-ublock').onclick = () => olive.cmd('ublock');

  if (!drag) {
    setHtml($('#pinned'), listHtml(S.pinned));
    setHtml($('#unpinned'), listHtml(S.unpinned));
  }

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

const tablist = $('#tablist');
let justDragged = false;

function tabIdFrom(el) {
  const row = el.closest('.row[data-id]');
  return row ? Number(row.dataset.id) : null;
}

function tabClick(p) {
  if (p.act === 'close') return olive.cmd('closeTabId', { id: p.id });
  if (p.act === 'mute') return olive.cmd('mute', { id: p.id });
  if (p.meta && S.activeId && p.id !== S.activeId) return olive.cmd('split', { a: S.activeId, b: p.id });
  olive.cmd('activate', { id: p.id });
  if (S.overlay === 'peek') olive.cmd('overlay', { kind: null });
}

tablist.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const id = tabIdFrom(e.target);
  if (id != null) olive.cmd('closeTabId', { id });
});

tablist.addEventListener('contextmenu', (e) => {
  const id = tabIdFrom(e.target);
  if (id == null) return;
  e.preventDefault();
  olive.cmd('tabMenu', { id });
});

// ---------- drag to reorder / drag onto content to split ----------


tablist.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const id = tabIdFrom(e.target);
  if (id == null) return;
  const act = e.target.closest('[data-act]')?.dataset.act || null;
  pressing = { id, act, meta: e.metaKey, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
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
  else if (pressing && e.button === 0) tabClick(pressing);
  pressing = null;
});

function findTab(id) {
  return [...S.pinned, ...S.unpinned].find((t) => t.id === id);
}

function startDrag(e) {
  const t = findTab(pressing.id);
  if (!t) return void (pressing = null);
  const groupIds = t.splitId ? [...S.pinned, ...S.unpinned].filter((x) => x.splitId === t.splitId).map((x) => x.id) : [t.id];
  drag = { id: t.id, groupIds, target: null, split: false };
  try { tablist.setPointerCapture(pressing.pointerId); } catch {}
  const g = $('#drag-ghost');
  g.innerHTML = favHtml({ ...t, loading: false }) + `<span>${esc(t.title)}</span>`;
  g.hidden = false;
  for (const id of groupIds) tablist.querySelector(`.row[data-id="${id}"]`)?.closest('.split-group, .row')?.classList.add('dragging-src');
  // ui goes on top so the ghost and split hint are visible over pages
  olive.cmd('overlay', { kind: 'drag' });
  moveDrag(e);
}

function topItems(listEl) {
  return [...listEl.children].filter((el) => !el.classList.contains('dragging-src'));
}

function clearDropMarks() {
  tablist.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function moveDrag(e) {
  const g = $('#drag-ghost');
  g.style.left = e.clientX + 10 + 'px';
  g.style.top = e.clientY - 17 + 'px';
  clearDropMarks();
  const sidebarRight = S.sidebarHidden ? 0 : S.sidebarWidth;
  let hint = $('#drop-split-hint');
  if (e.clientX > sidebarRight + 20 && S.panes.length && !drag.groupIds.includes(S.activeId)) {
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
    g.lastChild.textContent = 'Open in split view';
    return;
  }
  hint?.remove();
  drag.split = false;
  const t = findTab(drag.id);
  if (g.lastChild && t) g.lastChild.textContent = t.title;
  // figure out list + index
  const lists = [$('#pinned'), $('#unpinned')];
  const pinnedBox = $('#pinned').getBoundingClientRect();
  const divider = $('#divider').getBoundingClientRect();
  let listEl = e.clientY < divider.top + divider.height / 2 ? lists[0] : lists[1];
  const items = topItems(listEl);
  let index = items.length;
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { index = i; break; }
  }
  // index counts top-level items; convert to tab index in the list
  const tabsInList = listEl === lists[0] ? S.pinned : S.unpinned;
  let tabIndex = 0;
  for (let i = 0; i < index; i++) {
    const el = items[i];
    tabIndex += el.classList.contains('split-group') ? el.querySelectorAll('.row').length : 1;
  }
  drag.target = { list: listEl.dataset.list, index: tabIndex };
  if (items.length === 0) listEl.classList.add('drop-into');
  else if (index < items.length) items[index].classList.add('drop-before');
  else items[items.length - 1].classList.add('drop-after');
  void pinnedBox;
  void tabsInList;
}

function endDrag() {
  const d = drag;
  drag = null;
  $('#drag-ghost').hidden = true;
  $('#drop-split-hint')?.remove();
  clearDropMarks();
  $('#pinned')._html = $('#unpinned')._html = null;
  justDragged = true;
  setTimeout(() => (justDragged = false), 50);
  olive.cmd('overlay', { kind: null });
  if (d.split && S.activeId) olive.cmd('split', { a: S.activeId, b: d.id });
  else if (d.target) olive.cmd('move', { id: d.id, list: d.target.list, index: d.target.index });
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

$('#peek-zone').addEventListener('mouseenter', () => {
  if (S?.sidebarHidden && S.overlay !== 'palette') olive.cmd('overlay', { kind: 'peek' });
});
$('#sidebar').addEventListener('mouseleave', (e) => {
  if (S?.overlay === 'peek' && !drag && e.clientX > 20) olive.cmd('overlay', { kind: null });
});
document.addEventListener('mousemove', (e) => {
  if (S?.overlay === 'peek' && !drag && e.clientX > S.sidebarWidth + 30) olive.cmd('overlay', { kind: null });
});

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
  palInput.placeholder = mode === 'edit' ? 'Search or enter URL…' : mode === 'split' ? 'Open in split view…' : 'Search or enter URL…';
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
  if (typed && q && !/\s/.test(q) && palInput.selectionStart === palInput.value.length) {
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
    else icon = `<span class="fav">${it.kind === 'search' ? ICON.search : it.kind === 'tab' ? ICON.tab : it.kind === 'history' ? ICON.clock : ICON.globe}</span>`;
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
    submitPalette(e.shiftKey);
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

function submitPalette(split) {
  const value = palInput.value.trim();
  const item = pal.sel >= 0 ? pal.items[pal.sel] : null;
  if (!value && !item) return;
  hidePalette();
  olive.cmd('submit', { mode: pal.mode, input: value, item, split });
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
  submitPalette(e.shiftKey);
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
olive.invoke('state').then((s) => { if (s) { S = s; render(); } });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pal.open && S?.overlay === 'peek') olive.cmd('overlay', { kind: null });
});

$('#btn-ledger').onclick = () => olive.cmd('ledger');
