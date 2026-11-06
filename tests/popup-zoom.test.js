const test = require('node:test');
const assert = require('node:assert/strict');
const { edgeAt, EDGE } = require('../src/main/popup-zoom');

test('popup border band: outermost EDGE px on every side, nothing inside or outside', () => {
  const size = [500, 400];
  assert.equal(EDGE, 6);
  assert.equal(edgeAt(250, 0, size), 'top');
  assert.equal(edgeAt(250, 5, size), 'top');
  assert.equal(edgeAt(250, 6, size), null);
  assert.equal(edgeAt(250, 399, size), 'bottom');
  assert.equal(edgeAt(250, 394, size), 'bottom');
  assert.equal(edgeAt(250, 393, size), null);
  assert.equal(edgeAt(0, 200, size), 'left');
  assert.equal(edgeAt(499, 200, size), 'right');
  assert.equal(edgeAt(250, 200, size), null);
  assert.equal(edgeAt(10, 10, size), null);
  assert.equal(edgeAt(-1, 200, size), null);
  assert.equal(edgeAt(250, 400, size), null);
});
