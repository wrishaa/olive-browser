// enter-to-rename rule (src/ui/rename-keys.js, notes/tab-rename-spec.md). pure, no electron.
const test = require('node:test');
const assert = require('node:assert');
const { enterRenameId } = require('../src/ui/rename-keys.js');

const key = (o = {}) => ({ key: 'Enter', repeat: false, isComposing: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o });
const state = (o = {}) => ({ uiFocused: true, paletteOpen: false, renaming: false, editableFocused: false, selection: [7], exists: (id) => id === 7 || id === 8, ...o });

test('enter on the one selected tab, keyboard in the sidebar, renames it', () => {
  assert.strictEqual(enterRenameId(key(), state()), 7);
});

test('only a plain, fresh enter', () => {
  assert.strictEqual(enterRenameId(key({ key: 'a' }), state()), null);
  assert.strictEqual(enterRenameId(key({ repeat: true }), state()), null);
  assert.strictEqual(enterRenameId(key({ isComposing: true }), state()), null); // ime commit
  for (const m of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) assert.strictEqual(enterRenameId(key({ [m]: true }), state()), null, m);
});

test('never while the keyboard is elsewhere', () => {
  assert.strictEqual(enterRenameId(key(), state({ uiFocused: false })), null); // page has it
  assert.strictEqual(enterRenameId(key(), state({ paletteOpen: true })), null); // cmd+l
  assert.strictEqual(enterRenameId(key(), state({ editableFocused: true })), null); // find bar, rename fields
  assert.strictEqual(enterRenameId(key(), state({ renaming: true })), null);
});

test('exactly one live selected tab', () => {
  assert.strictEqual(enterRenameId(key(), state({ selection: [] })), null);
  assert.strictEqual(enterRenameId(key(), state({ selection: [7, 8] })), null);
  assert.strictEqual(enterRenameId(key(), state({ selection: [99] })), null);
});
