const $ = s => document.querySelector(s);
let initialized = false;
let request = 0;
function filter() {
  const out = { query: $('#query').value, type: $('#type').value };
  const period = $('#period').value;
  if (period === 'today') { const start = new Date(); start.setHours(0, 0, 0, 0); out.from = start.getTime(); }
  else if (period) out.from = Date.now() - Number(period) * 86400000;
  return out;
}
async function call(action = 'get', extra = {}) {
  const seq = ++request;
  try {
    const state = await window.ledger.call(action, { filter: filter(), ...extra });
    if (seq !== request || !state) return;
    $('#status').textContent = state.error || '';
    if (!state.events) return;
    if (!initialized) {
      for (const type of state.types) $('#type').add(new Option(type, type));
      for (const days of state.retention) $('#retention').add(new Option(`${days} days`, days));
      initialized = true;
    }
    $('#enabled').checked = state.settings.enabled;
    $('#retention').value = state.settings.retentionDays;
    $('#count').textContent = `${state.total} matching · showing ${state.events.length}`;
    $('#events').replaceChildren();
    $('#empty').hidden = state.events.length > 0;
    for (const event of state.events) {
      const row = document.createElement('tr');
      for (const text of [new Date(event.time).toLocaleString(), event.type, [event.details.url || event.details.origin, event.details.permission, event.details.allowed === undefined ? '' : event.details.allowed ? 'allowed' : 'blocked', event.details.state].filter(Boolean).join(' · ')]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      $('#events').append(row);
    }
  } catch { $('#status').textContent = 'could not load activity'; }
}
let timer;
$('#query').oninput = () => { clearTimeout(timer); timer = setTimeout(() => call(), 180); };
for (const id of ['type', 'period']) $('#' + id).onchange = () => call();
$('#enabled').onchange = () => call('configure', { enabled: $('#enabled').checked });
$('#retention').onchange = () => call('configure', { retentionDays: Number($('#retention').value) });
$('#refresh').onclick = () => call();
$('#json').onclick = () => call('export', { format: 'json' });
$('#csv').onclick = () => call('export', { format: 'csv' });
$('#delete').onclick = () => call('delete');
$('#clear').onclick = () => call('delete', { filter: {} });
call();
