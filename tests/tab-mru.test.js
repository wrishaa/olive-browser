// TabMRU + hold/release detection. Spec: notes/tab-mru-spec.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TabMRU } = require('../src/main/tab-mru');
const { holdForInput, holdReleased, holdRepressed, cancelsWalk } = require('../src/main/shortcut-input');

// drive TabMRU the way window.js does: active follows previews, finish commits
function harness(ids, active) {
  const m = new TabMRU();
  m.order = [...ids];
  const h = { m, ids: [...ids], active };
  h.press = (dir = 1) => { const id = m.step(h.ids, h.active, dir); if (id != null) h.active = id; return h.active; };
  h.release = () => m.finish(h.active);
  h.tap = (dir = 1) => { h.press(dir); h.release(); return h.active; };
  h.activate = id => { m.finish(h.active); h.active = id; m.touch(id); };
  h.cancel = () => { const start = m.cancel(); if (start != null) h.active = start; return start; };
  return h;
}

test('a: a tap goes to the previous tab, a second tap comes back', () => {
  const h = harness([1, 2, 3, 4], 1);
  assert.equal(h.tap(), 2);
  assert.deepEqual(h.m.order, [2, 1, 3, 4]);
  assert.equal(h.tap(), 1);
  assert.deepEqual(h.m.order, [1, 2, 3, 4]);
});

test('b: hold walks the frozen list, release commits, next tap returns', () => {
  const h = harness([1, 2, 3, 4], 1);
  assert.equal(h.press(), 2);
  assert.equal(h.press(), 3);
  assert.equal(h.press(), 4);
  assert.deepEqual(h.m.order, [1, 2, 3, 4], 'previews never reorder');
  h.release();
  assert.deepEqual(h.m.order, [4, 1, 2, 3]);
  assert.equal(h.tap(), 1);
});

test('c: many taps never drift', () => {
  const h = harness([1, 2, 3, 4], 1);
  for (let i = 0; i < 50; i++) assert.equal(h.tap(), i % 2 ? 1 : 2);
});

test('d: an outside activation ends a walk and becomes most recent', () => {
  const h = harness([1, 2, 3, 4], 1);
  h.press(); // previewing 2
  h.activate(4); // sidebar click mid-walk
  assert.equal(h.m.walk, null);
  assert.deepEqual(h.m.order, [4, 2, 1, 3]);
  assert.equal(h.tap(), 2);
});

test('e: random activations, taps and holds match a reference model', () => {
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const h = harness(ids, 1);
  let ref = [...ids];
  const touch = id => { ref = [id, ...ref.filter(x => x !== id)]; };
  for (let i = 0; i < 2000; i++) {
    const r = rnd(3);
    if (r === 0) { const id = ids[rnd(10)]; h.activate(id); touch(id); }
    else {
      const n = r === 1 ? 1 : 1 + rnd(12);
      const dir = rnd(4) === 0 ? -1 : 1;
      for (let k = 0; k < n; k++) h.press(dir);
      h.release();
      const want = ref[(((dir * n) % 10) + 10) % 10];
      assert.equal(h.active, want, `step ${i}`);
      touch(want);
    }
    assert.deepEqual(h.m.order, ref, `step ${i}`);
  }
});

test('f: shift walks from the end; changing direction stays in one snapshot', () => {
  const h = harness([1, 2, 3, 4], 1);
  assert.equal(h.press(-1), 4);
  assert.equal(h.press(-1), 3);
  assert.equal(h.press(1), 4);
  h.release();
  assert.deepEqual(h.m.order, [4, 1, 2, 3]);
});

test('f: closing tabs mid-walk is safe', () => {
  const h = harness([1, 2, 3, 4, 5], 1);
  h.press(); h.press(); // at 3
  h.ids = h.ids.filter(x => x !== 2); h.m.remove(2); // close another tab
  assert.equal(h.press(), 4);
  h.ids = h.ids.filter(x => x !== 4); h.m.remove(4); h.active = 3; // close the previewed one, olive picks a neighbour
  assert.equal(h.press(), 5);
  h.release();
  assert.deepEqual(h.m.order, [5, 1, 3]);
  h.ids = []; h.m.order = [];
  assert.equal(new TabMRU().step([], null, 1), null);
});

test('unknown tabs join the walk after the known ones', () => {
  const m = new TabMRU();
  m.order = [2, 1];
  assert.equal(m.step([1, 2, 3], 2, 1), 1);
  assert.equal(m.step([1, 2, 3], 1, 1), 3);
});

test('hold detection: release, re-press and shift', () => {
  const down = { type: 'keyDown', key: 'Tab', code: 'Tab', control: true, shift: false, meta: false, alt: false };
  const hold = holdForInput(down);
  assert.deepEqual(hold.modifiers, ['control']);
  assert.equal(holdReleased(hold, { ...down, type: 'keyUp' }), false, 'tab keyUp with ctrl held');
  assert.equal(holdReleased(hold, { type: 'keyUp', key: 'Control', control: true }), true, 'ctrl keyUp, even if still flagged');
  assert.equal(holdReleased(hold, { type: 'keyDown', key: 'a', control: false }), true, 'key without ctrl: released elsewhere');
  assert.equal(holdReleased(hold, { type: 'keyDown', key: 'Shift', control: true, shift: true }), false, 'shift does not commit');
  assert.equal(holdRepressed(hold, { type: 'keyDown', key: 'Control', control: true }), true, 'fresh ctrl press: missed release');
  assert.equal(holdRepressed(hold, { type: 'keyDown', key: 'Shift', control: true, shift: true }), false);
  assert.equal(holdRepressed(hold, { type: 'keyUp', key: 'Control', control: false }), false);
  assert.equal(holdRepressed(holdForInput({ type: 'keyDown', key: 'F5' }), { type: 'keyDown', key: 'Control', control: true }), false);
});

test('a5: esc cancels a walk back to its start, recency untouched', () => {
  const h = harness([1, 2, 3, 4], 1);
  h.press(); h.press();
  assert.equal(h.active, 3);
  assert.equal(h.cancel(), 1, 'cancel returns the start tab');
  assert.equal(h.active, 1);
  assert.equal(h.m.walk, null);
  assert.deepEqual(h.m.order, [1, 2, 3, 4], 'mru unchanged');
  assert.equal(h.m.cancel(), null, 'no walk: nothing to cancel');
  assert.equal(h.tap(), 2, 'next tap toggles normally');
  // after a commit, a later cancel goes back to the new start
  h.press(); h.press();
  assert.equal(h.cancel(), 2);
  assert.deepEqual(h.m.order, [2, 1, 3, 4]);
  // reversed (shift) walk cancels the same way
  h.press(-1);
  assert.equal(h.active, 4);
  assert.equal(h.cancel(), 2);
  // start tab closed mid-walk: no start to go back to
  h.press();
  h.ids = h.ids.filter(x => x !== 2); h.m.remove(2);
  assert.equal(h.m.cancel(), null);
  assert.equal(h.m.walk, null);
});

test('a5: esc keyDown cancels, whatever modifiers are down', () => {
  assert.equal(cancelsWalk({ type: 'keyDown', key: 'Escape', code: 'Escape', control: true }), true);
  assert.equal(cancelsWalk({ type: 'keyDown', key: 'Escape', code: 'Escape', meta: true, alt: true }), true);
  assert.equal(cancelsWalk({ type: 'keyUp', key: 'Escape', code: 'Escape', control: true }), false);
  assert.equal(cancelsWalk({ type: 'keyDown', key: 'Tab', code: 'Tab', control: true }), false);
});
