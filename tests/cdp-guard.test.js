// src/main/cdp-guard.js: browser-wide cookie / storage clears are refused on every olive
// cdp path; per-site deletes and throwaway-context clears pass. native check:
// scripts/cdp-guard-native-test.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CdpGuard, BLOCK_MESSAGE, NESTED_MESSAGE, guardFor, sendGuarded } = require('../src/main/cdp-guard');

const blocked = (g, method, params) => assert.throws(() => g.check(method, params), (e) => e.code === 'OLIVE_CDP_BLOCKED' && e.message === BLOCK_MESSAGE, `${method} ${JSON.stringify(params)} should be blocked`);
const allowed = (g, method, params) => assert.doesNotThrow(() => g.check(method, params), `${method} ${JSON.stringify(params)} should pass`);
const wrap = (method, params, extra = {}) => ({ ...extra, message: JSON.stringify({ id: 1, method, params }) });

test('browser-wide clears are blocked, any case', () => {
  const g = new CdpGuard();
  for (const m of ['Network.clearBrowserCookies', 'network.clearbrowsercookies', 'NETWORK.CLEARBROWSERCOOKIES', ' Network.clearBrowserCookies ']) blocked(g, m, {});
  blocked(g, 'Storage.clearCookies', {});
  blocked(g, 'storage.CLEARCOOKIES', undefined);
  blocked(g, 'Storage.clearCookies', { browserContextId: 'someone-elses' });
  for (const origin of ['*', '', '  ', undefined, null, 'https://*.google.com', 'not a url', 42, 'chrome://settings']) blocked(g, 'Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  blocked(g, 'Storage.clearDataForOrigin', {});
  for (const storageKey of ['*', '', undefined, 'junk', '*^0']) blocked(g, 'Storage.clearDataForStorageKey', { storageKey, storageTypes: 'all' });
  blocked(g, 'Network.deleteCookies', { name: 'SID' }); // every site's SID
  blocked(g, 'Network.deleteCookies', { url: 'https://a.test/' });
  blocked(g, 'Network.deleteCookies', { name: 'SID', domain: '*' });
  blocked(g, 'BrowsingData.clearAll', {});
  blocked(g, 'Storage.clearAllData', {});
  blocked(g, 'Network.clearAllCookies', {});
  blocked(g, 'Storage.clearSharedStorageEntries', {});
  blocked(g, 'Storage.clearTrustTokens', { issuerOrigin: '*' });
  blocked(g, 'Storage.deleteStorageBucket', { bucket: { name: 'x' } });
  blocked(g, 'Target.exposeDevToolsProtocol', { targetId: 't', bindingName: 'cdp' });
});

test('blocked methods inside Target.sendMessageToTarget are blocked, nested too', () => {
  const g = new CdpGuard();
  blocked(g, 'Target.sendMessageToTarget', wrap('Network.clearBrowserCookies', {}, { targetId: 't' }));
  blocked(g, 'target.sendmessagetotarget', wrap('storage.clearCookies', {}, { sessionId: 's' }));
  blocked(g, 'Target.sendMessageToTarget', { sessionId: 's', message: { id: 1, method: 'Network.clearBrowserCookies' } });
  let msg = { id: 1, method: 'Storage.clearDataForOrigin', params: { origin: '*', storageTypes: 'all' } };
  for (let i = 0; i < 4; i++) msg = { id: i + 2, method: 'Target.sendMessageToTarget', params: { sessionId: 's' + i, message: JSON.stringify(msg) } };
  blocked(g, msg.method, msg.params);
  // can't read it: refuse rather than guess
  for (const message of ['{not json', '[1,2]', '"x"', undefined]) assert.throws(() => g.check('Target.sendMessageToTarget', { sessionId: 's', message }), (e) => e.code === 'OLIVE_CDP_BLOCKED' && e.message === NESTED_MESSAGE);
  let deep = { id: 1, method: 'Runtime.evaluate', params: {} };
  for (let i = 0; i < 12; i++) deep = { id: 1, method: 'Target.sendMessageToTarget', params: { sessionId: 's', message: JSON.stringify(deep) } };
  assert.throws(() => g.check(deep.method, deep.params), (e) => e.message === NESTED_MESSAGE);
  allowed(g, 'Target.sendMessageToTarget', wrap('Runtime.evaluate', { expression: '1' }, { sessionId: 's' }));
  allowed(g, 'Target.sendMessageToTarget', wrap('Network.deleteCookies', { name: 'a', url: 'https://a.test/' }, { sessionId: 's' }));
});

test('per-site deletes and ordinary commands pass', () => {
  const g = new CdpGuard();
  allowed(g, 'Network.deleteCookies', { name: 'sid', url: 'https://a.test/' });
  allowed(g, 'Network.deleteCookies', { name: 'sid', domain: '.a.test', path: '/' });
  allowed(g, 'Storage.clearDataForOrigin', { origin: 'https://a.test', storageTypes: 'all' });
  allowed(g, 'Storage.clearDataForOrigin', { origin: 'http://localhost:8080', storageTypes: 'cookies,local_storage' });
  allowed(g, 'Storage.clearDataForStorageKey', { storageKey: 'https://a.test/', storageTypes: 'all' });
  allowed(g, 'Storage.clearSharedStorageEntries', { ownerOrigin: 'https://a.test' });
  allowed(g, 'Storage.deleteStorageBucket', { bucket: { storageKey: 'https://a.test/', name: 'b' } });
  allowed(g, 'Network.clearBrowserCache', {}); // http cache only: no cookies, no site storage
  for (const m of ['Runtime.evaluate', 'Page.navigate', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Network.getCookies', 'Storage.getCookies', 'Network.setCookie', 'Network.setCookies', 'Storage.setCookies', 'IndexedDB.deleteDatabase', 'DOMStorage.clear', 'Target.getTargetInfo', 'Target.createBrowserContext']) allowed(g, m, {});
});

test('a context this session created can be cleared; disposed or foreign ones cannot', async () => {
  const sent = [];
  let n = 0;
  const dbg = { sendCommand: async (method, params, sessionId) => { sent.push([method, sessionId]); return method === 'Target.createBrowserContext' ? { browserContextId: 'ctx' + (++n) } : {}; } };
  const { browserContextId } = await sendGuarded(dbg, 'Target.createBrowserContext', {});
  assert.equal(browserContextId, 'ctx1');
  await sendGuarded(dbg, 'Storage.clearCookies', { browserContextId });
  await sendGuarded(dbg, 'Target.sendMessageToTarget', wrap('Storage.clearCookies', { browserContextId }, { sessionId: 's' }));
  // another debugger (another tab) didn't make it
  await assert.rejects(sendGuarded({ sendCommand: async () => ({}) }, 'Storage.clearCookies', { browserContextId }), { code: 'OLIVE_CDP_BLOCKED' });
  await sendGuarded(dbg, 'Target.disposeBrowserContext', { browserContextId });
  await assert.rejects(sendGuarded(dbg, 'Storage.clearCookies', { browserContextId }), { code: 'OLIVE_CDP_BLOCKED', message: BLOCK_MESSAGE });
  await assert.rejects(sendGuarded(dbg, 'Network.clearBrowserCookies', {}), { code: 'OLIVE_CDP_BLOCKED' });
  // blocked commands never reach chromium
  assert.deepEqual(sent.map((s) => s[0]), ['Target.createBrowserContext', 'Storage.clearCookies', 'Target.sendMessageToTarget', 'Target.disposeBrowserContext']);
  assert.equal(guardFor(dbg), guardFor(dbg));
  await sendGuarded(dbg, 'Runtime.evaluate', {}, 'flat-session');
  assert.deepEqual(sent.at(-1), ['Runtime.evaluate', 'flat-session']);
  await assert.rejects(sendGuarded(dbg, 'network.clearBrowserCookies', {}, 'flat-session'), { code: 'OLIVE_CDP_BLOCKED' });
});

test('every cdp sendCommand in src/main goes through the guard', () => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '../src/main');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'cdp-guard.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/\.sendCommand\s*\(/.test(src), `${f} calls sendCommand directly: use sendGuarded from cdp-guard.js`);
  }
});
