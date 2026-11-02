(() => {
  const api = window.oliveSiteTime;
  const $ = id => document.getElementById(id);
  const ranges = ['today', 'week', 'all'];
  let range = 'week', expanded = false, busy = false, request = 0;
  function duration(seconds) {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  }
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function error(message) { $('time-error').textContent = message || ''; $('time-error').hidden = !message; }
  function render(state) {
    if (!state || state.range !== range) return;
    $('time-total').textContent = duration(state.totalSeconds);
    $('time-sites').textContent = `${state.siteCount} ${state.siteCount === 1 ? 'site' : 'sites'}`;
    $('time-avg').textContent = duration(state.averageSeconds);
    $('average-note').textContent = `over ${state.dayCount} calendar ${state.dayCount === 1 ? 'day' : 'days'}`;
    error(state.error);
    const chart = document.createDocumentFragment();
    const peak = Math.max(1, ...state.daily.map(day => day.seconds));
    for (const day of state.daily) {
      const date = new Date(`${day.day}T12:00:00`);
      const label = date.toLocaleDateString(undefined, { weekday: 'short' });
      const full = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const item = element('div', `day${day.isToday ? ' today' : ''}`);
      item.setAttribute('aria-label', `${full}: ${duration(day.seconds)}`);
      item.title = `${full} · ${duration(day.seconds)}`;
      const track = element('div', 'bar-track'), bar = element('div', 'bar');
      bar.style.height = `${Math.max(0, day.seconds / peak * 100)}%`;
      track.append(bar); item.append(track, element('span', 'day-label', label)); chart.append(item);
    }
    $('time-chart').replaceChildren(chart);
    const rows = document.createDocumentFragment();
    for (const entry of state.entries.slice(0, expanded ? undefined : 50)) {
      const row = element('li', 'site-row'), button = element('button', 'site-button');
      button.type = 'button';
      button.setAttribute('aria-label', `Open ${entry.site}, ${duration(entry.seconds)}, ${Math.round(entry.share * 100)} percent`);
      const icon = element('span', 'site-icon'); icon.setAttribute('aria-hidden', 'true');
      if (entry.favicon) { const image = element('img'); image.src = entry.favicon; image.alt = ''; icon.append(image); }
      else icon.textContent = entry.site.replace(/^\[/, '').slice(0, 1).toUpperCase();
      const info = element('span', 'site-info'), track = element('span', 'site-bar-track'), bar = element('span', 'site-bar');
      bar.style.display = 'block'; bar.style.width = `${Math.min(100, Math.max(0, entry.fraction * 100))}%`;
      track.append(bar); info.append(element('span', 'site-name', entry.site), track);
      button.append(icon, info, element('span', 'site-share', `${Math.round(entry.share * 100)}%`), element('span', 'site-duration', duration(entry.seconds)));
      button.addEventListener('click', () => api.open(entry.site).catch(() => error('Could not open this site.')));
      row.append(button); rows.append(row);
    }
    $('time-rows').replaceChildren(rows);
    $('time-empty').hidden = state.siteCount > 0;
    $('time-show-all').hidden = expanded || state.entries.length <= 50;
    $('time-show-all').textContent = `Show all ${state.siteCount} sites`;
    $('btn-reset').disabled = busy || !state.siteCount;
  }
  async function load() {
    const seq = ++request;
    try { const state = await api.get(range); if (seq === request) render(state); }
    catch { error('Could not load site time.'); }
  }
  function select(next, focus = false) {
    if (!ranges.includes(next)) return;
    range = next; expanded = false;
    for (const button of $('time-range').querySelectorAll('button')) {
      const selected = button.dataset.range === range;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    load();
  }
  $('time-range').addEventListener('click', event => { const button = event.target.closest('[data-range]'); if (button) select(button.dataset.range); });
  $('time-range').addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (ranges.indexOf(range) + 1) % ranges.length;
    if (event.key === 'ArrowLeft') next = (ranges.indexOf(range) + ranges.length - 1) % ranges.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = ranges.length - 1;
    if (next !== undefined) { event.preventDefault(); select(ranges[next], true); }
  });
  $('time-show-all').addEventListener('click', () => { expanded = true; load(); });
  $('btn-reset').addEventListener('click', async () => {
    if (busy) return;
    busy = true; $('btn-reset').disabled = true; ++request;
    try { await api.reset(range); } catch { error('Could not reset site time.'); }
    finally { busy = false; load(); }
  });
  select('week');
  setInterval(() => { if (!document.hidden && !busy) load(); }, 5000);
})();
