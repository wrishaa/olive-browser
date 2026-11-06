// src/main/cdp-proxy.js frame handling: masked client frames, fragmentation, split chunks,
// 16/64-bit lengths. the end-to-end proxy check is in scripts/cdp-guard-native-test.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MessageReader, textFrame, rewritePorts } = require('../src/main/cdp-proxy');

const masked = (opcode, fin, data) => {
  const mask = Buffer.from([1, 2, 3, 4]), len = data.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  return Buffer.concat([head, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]);
};

test('reads masked, fragmented and split messages; control frames pass alone', () => {
  const r = new MessageReader();
  const a = Buffer.from(JSON.stringify({ id: 1, method: 'Network.clearBrowserCookies' }));
  const wire = Buffer.concat([masked(1, false, a.subarray(0, 10)), masked(9, true, Buffer.from('p')), masked(0, true, a.subarray(10))]);
  const got = [];
  for (let i = 0; i < wire.length; i += 3) got.push(...r.push(wire.subarray(i, i + 3)));
  assert.equal(got.length, 2);
  assert.equal(got[0].control, true);
  assert.equal(got[1].data.toString(), a.toString());
  assert.equal(Buffer.concat(got[1].raws).length + got[0].raw.length, wire.length);
});

test('16- and 64-bit lengths, server frames round-trip', () => {
  for (const n of [125, 126, 70000]) {
    const s = 'x'.repeat(n);
    assert.equal(new MessageReader().push(masked(1, true, Buffer.from(s)))[0].data.toString(), s);
    assert.equal(new MessageReader().push(textFrame(s))[0].data.toString(), s);
  }
  assert.throws(() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(2n ** 40n, 2); new MessageReader().push(h); }, /too large/);
});

test('rewrites the upstream port in json', () => {
  assert.equal(rewritePorts('{"u":"ws://127.0.0.1:555/devtools/browser/x","f":"localhost:555"}', 555, 9222), '{"u":"ws://127.0.0.1:9222/devtools/browser/x","f":"localhost:9222"}');
});
