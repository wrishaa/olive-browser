// Display is deliberately one-way: only the raw accelerator goes over IPC.
function shortcutDisplay(accelerator) {
  if (!accelerator) return '';
  const parts = accelerator.split('+');
  const key = parts.pop();
  const modifiers = { Cmd:'⌘', Ctrl:'⌃', Alt:'⌥', Shift:'⇧' };
  const keys = { Up:'↑', Down:'↓', Left:'←', Right:'→', Tab:'⇥', Space:'␣', Enter:'↩', Escape:'⎋', Backspace:'⌫', Delete:'⌦', Home:'↖', End:'↘', PageUp:'⇞', PageDown:'⇟', Plus:'+' };
  // Standard macOS order, independent of the stored accelerator's order.
  return ['Ctrl','Alt','Shift','Cmd'].filter(mod => parts.includes(mod)).map(mod => modifiers[mod]).join('') + (keys[key] || key);
}
function setRecordedShortcut(input, accelerator) {
  input.dataset.accelerator = accelerator;
  input.value = shortcutDisplay(accelerator);
}
const status = document.getElementById('status');
function render(result) {
  if (!result) return;
  status.textContent = result.error || '';
  document.getElementById('commands').replaceChildren(...result.commands.map(command => {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('label'); label.textContent = command.label; label.htmlFor = command.id;
    const input = document.createElement('input'); input.id = command.id; setRecordedShortcut(input, command.value); input.readOnly = true; input.placeholder = 'disabled'; input.autocomplete = 'off';
    input.title = `Default: ${shortcutDisplay(command.accelerator) || 'disabled'}`;
    input.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.preventDefault();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { setRecordedShortcut(input, command.value); input.blur(); return; }
      if (['Meta','Control','Alt','Shift'].includes(e.key)) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey) { setRecordedShortcut(input, ''); return; }
      const keys = { ' ':'Space', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', '+':'Plus' };
      // code preserves punctuation when Shift changes its printable character.
      const codes = { Equal:'=', Minus:'-', BracketLeft:'[', BracketRight:']', Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/', Backquote:'`' };
      const key = codes[e.code] || keys[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      setRecordedShortcut(input, [...(e.metaKey ? ['Cmd'] : []), ...(e.ctrlKey ? ['Ctrl'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), key].join('+'));
    });
    const save = document.createElement('button'); save.textContent = 'save'; save.setAttribute('aria-label', `save ${command.label}`);
    save.onclick = async () => render(await window.shortcuts.set(command.id, input.dataset.accelerator));
    row.append(label,input,save); return row;
  }));
}
const resetPrompt = document.getElementById('reset-confirm');
function hideReset() { resetPrompt.hidden = true; document.getElementById('reset').setAttribute('aria-expanded', 'false'); }
document.getElementById('reset').onclick = () => {
  resetPrompt.hidden = false;
  document.getElementById('reset').setAttribute('aria-expanded', 'true');
  document.getElementById('reset-accept').focus();
};
document.getElementById('reset-cancel').onclick = () => { hideReset(); document.getElementById('reset').focus(); };
document.getElementById('reset-accept').onclick = async () => { render(await window.shortcuts.reset()); hideReset(); document.getElementById('reset').focus(); };
document.addEventListener('keydown', e => {
  // The first Escape cancels an in-progress recording; outside it Escape closes.
  if (e.key === 'Escape' && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (!resetPrompt.hidden) { hideReset(); document.getElementById('reset').focus(); }
    else window.shortcuts.close();
  }
});
window.shortcuts.get().then(render);
