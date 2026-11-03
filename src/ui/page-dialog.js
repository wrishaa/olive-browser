// olive's page dialog popup (alert / confirm / prompt), one per window, over the tab's pane.
// main sends the dialog to show (or null); we answer with ok/cancel, the typed text and the
// "don't allow more" box. enter = ok, esc = cancel (an alert's esc is ok, like chrome).
const $ = (s) => document.querySelector(s);
const card = $('#card'), field = $('#field'), box = $('#block-box');
const drafts = new Map(); // id -> typed text, kept when the user switches tabs and back
let cur = null;

function show(d) {
  if (cur && cur.kind === 'prompt') drafts.set(cur.id, field.value);
  cur = d;
  document.body.classList.toggle('open', !!d);
  card.hidden = !d;
  if (!d) return;
  $('#title').textContent = d.title; $('#title').title = d.title;
  $('#message').textContent = d.message;
  field.hidden = d.kind !== 'prompt';
  $('#cancel').hidden = d.kind === 'alert';
  $('#ok').hidden = d.kind === 'passkey'; // only Cancel: the security key itself answers
  card.classList.toggle('passkey', d.kind === 'passkey');
  $('#block').hidden = !d.offerBlock; box.checked = false;
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  if (d.kind === 'prompt') {
    field.value = drafts.has(d.id) ? drafts.get(d.id) : d.value;
    field.focus(); field.select();
  } else (d.kind === 'passkey' ? $('#cancel') : $('#ok')).focus();
}

function answer(ok) {
  if (!cur) return;
  const d = cur; cur = null; drafts.delete(d.id);
  card.hidden = true; document.body.classList.remove('open');
  window.pageDialog.answer(d.id, ok, d.kind === 'prompt' ? field.value : '', box.checked);
}

window.pageDialog.on(show);
card.addEventListener('submit', (e) => { e.preventDefault(); answer(cur?.kind !== 'passkey'); });
$('#cancel').addEventListener('click', () => answer(false));
document.addEventListener('keydown', (e) => {
  if (!cur) return;
  if (cur.kind === 'passkey') { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); answer(false); } return; }
  if (e.key === 'Escape') { e.preventDefault(); answer(cur.kind === 'alert'); }
  else if (e.key === 'Enter' && !e.isComposing && e.target !== $('#cancel') && e.target.tagName !== 'BUTTON') { e.preventDefault(); answer(true); }
});
// clicks on the dimmed page do nothing (the dialog stays modal for its tab), but bring
// focus back to the dialog so enter / esc keep working
$('#scrim').addEventListener('mousedown', (e) => { e.preventDefault(); (cur?.kind === 'prompt' ? field : cur?.kind === 'passkey' ? $('#cancel') : $('#ok')).focus(); });
