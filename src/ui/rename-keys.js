// enter-to-rename rule (notes/tab-rename-spec.md), pure so tests can load it in node.
// returns the tab id enter should rename, or null.
// k: { key, repeat, isComposing, shiftKey, metaKey, ctrlKey, altKey }
// s: { uiFocused, paletteOpen, renaming, editableFocused, selection: [ids], exists(id) }
function enterRenameId(k, s) {
  if (k.key !== 'Enter' || k.repeat || k.isComposing) return null;
  if (k.shiftKey || k.metaKey || k.ctrlKey || k.altKey) return null;
  if (!s.uiFocused || s.paletteOpen || s.renaming || s.editableFocused) return null;
  const sel = s.selection || [];
  if (sel.length !== 1 || !s.exists(sel[0])) return null;
  return sel[0];
}
if (typeof module === 'object') module.exports = { enterRenameId };
