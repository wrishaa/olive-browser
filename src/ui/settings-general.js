// Settings > General: tab unloading, site permissions, agent access.
const api = window.oliveSettings;
const $ = id => document.getElementById(id);
const NUMBERS = ['unloadAfterMinutes', 'pinnedUnloadAfterMinutes', 'maxLoadedTabs'];
const section = new URLSearchParams(location.search).get('section');
let state = null;
const openSites = new Set();

function say(id, text) { $(id).textContent = text || ''; }

function renderUnloading(u) {
  for (const key of NUMBERS) {
    const input = $(key);
    if (document.activeElement === input) continue; // don't clobber typing
    input.removeAttribute('aria-invalid');
    input.max = u.limits[key];
    input.value = key === 'maxLoadedTabs' && !u.values[key] ? '' : String(u.values[key]);
  }
  const capOn = u.values.maxLoadedTabs > 0;
  $('capOn').checked = capOn;
  $('maxLoadedTabs').disabled = !capOn;
  $('exempt').textContent = `Never unloaded: tabs ${u.exempt.join(', ')}.`;
}

function renderPermissions(p) {
  const sites = $('sites');
  if (!p.sites.length) {
    const empty = document.createElement('p'); empty.className = 'empty note';
    empty.textContent = 'No saved choices yet. Sites ask the first time they want your camera, microphone, location and so on.';
    sites.replaceChildren(empty);
  } else {
    sites.replaceChildren(...p.sites.map(site => {
      const d = document.createElement('details'); d.className = 'site'; d.dataset.origin = site.origin;
      d.open = openSites.has(site.origin);
      d.addEventListener('toggle', () => { if (d.open) openSites.add(site.origin); else openSites.delete(site.origin); });
      const sum = document.createElement('summary');
      const o = document.createElement('span'); o.className = 'origin'; o.textContent = site.origin;
      const badge = document.createElement('span'); badge.className = 'badge';
      if (site.origin === p.current) { badge.classList.add('current'); badge.textContent = site.saved ? `current site · ${site.saved} saved` : 'current site'; }
      else badge.textContent = `${site.saved} saved`;
      sum.append(o, badge);
      const grid = document.createElement('div'); grid.className = 'perms';
      for (const perm of site.permissions) {
        const row = document.createElement('label'); row.className = 'perm';
        const name = document.createElement('span'); name.textContent = perm.label;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${perm.label} for ${site.origin}`);
        for (const [v, t] of [['ask', 'Ask'], ['allow', 'Allow'], ['block', 'Block']]) { const op = document.createElement('option'); op.value = v; op.textContent = t; sel.append(op); }
        sel.value = perm.value;
        sel.addEventListener('change', async () => apply(await api.permission(site.origin, perm.key, sel.value), 'permissions-status', `${perm.label} for ${site.origin}: ${sel.options[sel.selectedIndex].text}`));
        row.append(name, sel); grid.append(row);
      }
      d.append(sum, grid);
      if (site.saved) {
        const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'forget'; forget.textContent = 'Forget all choices for this site';
        forget.addEventListener('click', async () => apply(await api.forgetSite(site.origin), 'permissions-status', `Forgot ${site.origin}`));
        d.append(forget);
      }
      return d;
    }));
  }
  const labels = { microphone: 'Microphone', camera: 'Camera', screen: 'Screen recording' };
  const states = { granted: 'Allowed', denied: 'Blocked', restricted: 'Restricted', 'not-determined': 'Not requested yet', 'not-applicable': 'Not applicable', unknown: 'Unknown' };
  $('system').replaceChildren(...Object.entries(labels).map(([kind, label]) => {
    const row = document.createElement('div'); row.className = 'os';
    const left = document.createElement('span'); left.textContent = label;
    const st = document.createElement('span'); st.className = 'state'; st.textContent = states[p.system[kind]] || p.system[kind];
    left.append(st);
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Open macOS settings';
    b.addEventListener('click', async () => apply(await api.macos(kind), 'permissions-status'));
    row.append(left, b); return row;
  }));
}

function renderAgent(a) {
  for (const key of ['agentApi', 'cdp']) $(key).checked = !!a[key];
}

function render(next) {
  if (!next) return;
  state = next;
  renderUnloading(state.unload);
  renderPermissions(state.permissions);
  renderAgent(state.agent);
}

function apply(result, statusId, ok) {
  if (!result) return;
  render(result);
  say(statusId, result.error || ok || '');
  return !result.error;
}

async function saveNumber(key, raw) {
  const input = $(key);
  const value = raw.trim() === '' ? 0 : Number(raw);
  if (!Number.isInteger(value) || value < 0) { input.setAttribute('aria-invalid', 'true'); say('unload-status', 'Enter a whole number, 0 or more.'); return; }
  const result = await api.set(key, value);
  if (result?.error) { input.setAttribute('aria-invalid', 'true'); say('unload-status', result.error); return; }
  input.blur();
  apply(result, 'unload-status', 'Saved');
}

for (const key of NUMBERS) {
  const input = $(key);
  input.addEventListener('change', () => saveNumber(key, input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveNumber(key, input.value); } });
}

// the cap is off until turned on; turning it on starts at 16 (editable)
$('capOn').addEventListener('change', async () => {
  const on = $('capOn').checked;
  const result = await api.set('maxLoadedTabs', on ? state.unload.prefillMax : 0);
  apply(result, 'unload-status', on ? `Loaded tabs limited to ${state.unload.prefillMax}` : 'Limit off');
  if (on) $('maxLoadedTabs').focus();
});

$('unload-defaults').addEventListener('click', async () => {
  let result;
  for (const key of NUMBERS) result = await api.set(key, state.unload.defaults[key]);
  apply(result, 'unload-status', 'Defaults restored');
});

for (const key of ['agentApi', 'cdp']) {
  $(key).addEventListener('change', async () => apply(await api.set(key, $(key).checked), 'agent-status', 'Saved. Relaunch Olive for this to take effect.'));
}

api.onState(render);
api.get().then(s => {
  if (section === 'permissions' && s?.permissions.current) openSites.add(s.permissions.current);
  render(s);
  const target = section && $(section);
  if (target) { target.scrollIntoView({ block: 'start' }); target.classList.add('section-flash'); }
});
