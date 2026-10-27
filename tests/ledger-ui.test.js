const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = name => fs.readFileSync(path.join(__dirname, '../src/ui', name), 'utf8');

test('activity period filter preserves local day and rolling date boundaries', () => {
  const values = { '#query': 'example.org', '#type': 'visit', '#period': '' };
  const context = vm.createContext({ document: { querySelector: id => ({ value: values[id] }) } });
  vm.runInContext(ui('ledger.js').split('async function call(')[0], context);
  const filter = () => JSON.parse(JSON.stringify(vm.runInContext('filter()', context)));
  assert.deepEqual(filter(), { query: 'example.org', type: 'visit' });
  for (const days of [7, 30]) {
    values['#period'] = String(days);
    const now = Date.now(), out = filter();
    assert.ok(Math.abs(out.from - (now - days * 86400000)) < 1000);
    assert.equal(out.to, undefined);
  }
  values['#period'] = 'today';
  const start = new Date(); start.setHours(0, 0, 0, 0);
  assert.equal(filter().from, start.getTime());
});

test('profiles and activity are persistent settings pages, not dialog forms', () => {
  for (const name of ['profiles', 'ledger']) {
    const html = ui(name + '.html');
    assert.match(html, /settings-base\.css/);
    assert.doesNotMatch(html, /id="done"|data-panel-close|type="date"/);
  }
  assert.match(ui('ledger.html'), /id="period"/);
  assert.doesNotMatch(ui('ledger.js'), /details\)\.map\(\(\[k,v\]\)/);
});

test('settings pages inherit app tokens instead of fixed light-only ink', () => {
  for (const name of ['profiles', 'ledger', 'shortcuts', 'site-settings', 'capture', 'extension']) {
    assert.doesNotMatch(ui(name + '.css'), /#[0-9a-f]{3,8}\b/i);
  }
  const tokens = ui('ui.css').split('body.private')[0].trim();
  assert.ok(ui('settings-base.css').includes(tokens));
  assert.match(ui('settings-base.css'), /color: var\(--text-dim\)/);
});
