const list = document.querySelector('#list');
const status = document.querySelector('#status');
const notices = new Map();
let busy = false, last = [];
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function lock(on) { busy = on; list.querySelectorAll('input,button').forEach(c => { c.disabled = on || c.dataset.available !== 'true'; }); }
function setting(row, key, label, hint) {
  const line = el('label', 'setting');
  const text = el('span', 'label', label);
  if (hint) text.append(el('span', 'hint', hint));
  const input = document.createElement('input');
  input.type = 'checkbox'; input.className = 'switch'; input.setAttribute('role', 'switch');
  input.dataset.key = key; input.dataset.available = String(!!row.installed);
  input.checked = !!row[key]; input.disabled = busy || !row.installed;
  input.addEventListener('change', async () => {
    lock(true); status.textContent = '';
    try { last = await window.extensionSettings.set(row.id, key, input.checked); }
    catch { status.textContent = 'Could not save this change. Please try again.'; last = await window.extensionSettings.get().catch(() => last); }
    finally { busy = false; render(last); }
  });
  line.append(text, input);
  return line;
}
function render(rows) {
  if (!Array.isArray(rows)) return;
  last = rows;
  list.replaceChildren();
  if (!rows.length) { list.append(el('p', 'note', 'No extensions installed.')); return; }
  for (const row of rows) {
    const item = el('section', 'ext'); item.dataset.id = row.id || '';
    item.setAttribute('aria-label', row.name);
    const head = el('div', 'head');
    const icon = document.createElement('img'); icon.className = 'icon'; icon.alt = '';
    if (row.icon && /^data:image\/png;base64,/.test(row.icon)) icon.src = row.icon;
    const body = el('div', 'body');
    const title = el('div', 'title'); title.append(el('span', 'name', row.name), el('span', 'version', row.version ? `Version ${row.version}` : ''));
    body.append(title);
    if (row.description) body.append(el('p', 'description', row.description));
    const options = el('button', 'options', 'Options…');
    options.title = `Open ${row.name}’s own options page`;
    options.dataset.available = String(!!row.hasOptions);
    options.disabled = busy || !row.hasOptions;
    options.onclick = async () => {
      lock(true); options.textContent = 'Opening…'; notices.delete(row.id); status.textContent = '';
      let result = null;
      try { result = await window.extensionSettings.options(row.id); }
      catch { result = { ok: false, message: 'Could not open the extension options.' }; }
      // On success the options page replaces this one; otherwise explain why.
      if (result && !result.ok && result.message) notices.set(row.id, result.message);
      busy = false; render(last);
    };
    head.append(icon, body, options);
    const group = el('div', 'group');
    group.append(setting(row, 'enabled', 'Enabled'), setting(row, 'showInToolbar', 'Show in sidebar toolbar', 'A button above the sidebar footer. Hiding it doesn’t turn the extension off.'));
    item.append(head, group);
    if (notices.get(row.id)) { const n = el('p', 'notice', notices.get(row.id)); n.setAttribute('role', 'status'); item.append(n); }
    // the notice already explains the limits; don't say it twice
    if (row.limits && !notices.get(row.id)) item.append(el('p', 'note limits', row.limits));
    if (row.error) item.append(el('p', 'error', row.error));
    list.append(item);
  }
}
async function refresh() {
  try { render(await window.extensionSettings.get()); }
  catch { status.textContent = 'Could not load extensions.'; }
}
window.extensionSettings.onState(rows => { if (!busy) render(rows); });
window.addEventListener('focus', () => { if (!busy) refresh(); });
refresh();
