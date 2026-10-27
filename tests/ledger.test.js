const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger, redactUrl, sanitize } = require('../src/core/ledger');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-ledger-'));
  const file = path.join(dir, 'activity.json');
  let now = Date.UTC(2026, 0, 1);
  const ledger = new Ledger(file, { now: () => now });
  t.after(() => { clearTimeout(ledger.timer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ledger, file, tick: days => { now += days * 86400000; } };
}
test('URL metadata strips credentials, all query values, fragments and auth paths', () => {
  assert.equal(redactUrl('https://alice:password@example.com/a?q=secret&new_key=token#private'), 'https://example.com/a');
  assert.equal(redactUrl('file:///Users/person/private.txt'), '');
  assert.equal(redactUrl('data:text/html,secret'), '');
  assert.equal(redactUrl('not a URL'), '');
  assert.ok(!redactUrl('https://example.com/reset/my-secret').includes('my-secret'));
  assert.ok(!redactUrl('https://example.com/u/person%40example.com').includes('person'));
});
test('allowlists discard page/form/search content, passwords and arbitrary payloads', () => {
  const clean = sanitize('download', { url: 'https://example.com/?token=abc', title: 'secret', query: 'secret', password: 'secret', cookies: 'secret', headers: { Authorization: 'secret' }, path: '/secret', bytes: 12, state: 'completed' });
  assert.deepEqual(clean, { url: 'https://example.com/', bytes: 12, state: 'completed' });
  assert.equal(sanitize('visit', { private: true }), null);
  assert.equal(sanitize('visit', { isPrivate: true }), null);
  assert.equal(sanitize('form', {}), null);
});
test('persistent per-profile store uses 0600 and reloads sanitized metadata', t => {
  const { ledger, file } = fixture(t);
  ledger.record('visit', { url: 'https://user:pass@example.com/a?password=bad#secret', tabId: 1 });
  assert.equal(ledger.flush(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('password'));
  const loaded = new Ledger(file, { now: ledger.now });
  assert.equal(loaded.list().length, 1);
  assert.equal(loaded.list()[0].details.url, 'https://example.com/a');
  assert.equal(new Ledger(path.join(path.dirname(file), 'other.json')).list().length, 0);
});
test('retention, pause and deletion leave unrelated history untouched', t => {
  const { ledger, file, tick } = fixture(t);
  const history = path.join(path.dirname(file), 'history.json'); fs.writeFileSync(history, 'existing history');
  ledger.record('visit', { url: 'https://old.example/' }); tick(8);
  ledger.record('search', { url: 'https://www.google.com/search?q=private', engine: 'google' });
  ledger.configure({ retentionDays: 7 });
  assert.equal(ledger.list().length, 1);
  ledger.configure({ enabled: false });
  assert.equal(ledger.record('visit', {}), null);
  ledger.configure({ enabled: true });
  ledger.record('permission', { origin: 'https://example.com', permission: 'camera', allowed: true });
  assert.equal(ledger.remove({ type: 'search' }), 1);
  assert.equal(ledger.list()[0].type, 'permission');
  assert.equal(fs.readFileSync(history, 'utf8'), 'existing history');
});
test('filtered JSON and CSV exports contain all matches, with no query secrets', t => {
  const { ledger } = fixture(t);
  ledger.record('visit', { url: 'https://example.com/a?token=hidden' });
  ledger.record('download', { url: 'https://example.com/b', bytes: 123, state: 'completed' });
  const json = ledger.export('json', { type: 'download' });
  assert.equal(JSON.parse(json).events.length, 1);
  assert.ok(ledger.export('csv').startsWith('id,time,type,url,'));
  assert.ok(!ledger.export('csv').includes('hidden'));
  assert.equal(ledger.matching({ query: 'example.com' }).length, 2);
  assert.throws(() => ledger.export('html'));
});
test('read errors and write errors are surfaced without throwing during browsing', t => {
  const { file } = fixture(t); fs.writeFileSync(file, 'corrupt');
  const ledger = new Ledger(file); assert.ok(ledger.error);
  const invalid = new Ledger(path.join(file, 'nested.json'));
  invalid.record('visit', {}); assert.equal(invalid.flush(), false); assert.ok(invalid.error);
});
