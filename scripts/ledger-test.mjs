// Native Activity ledger smoke; attach only to the already-running disposable fixture.
// OLIVE_PROFILE=onboarding-fixture node scripts/ledger-test.mjs
// Does not launch/restart/quit Olive, read browsing stores, switch profiles, or delete
// other tests' tabs. Profile-switch isolation is exercised separately by the parent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const fixture = 'onboarding-fixture';
assert.equal(process.env.OLIVE_PROFILE, fixture, 'Refusing to attach: OLIVE_PROFILE must be onboarding-fixture');
const root = path.join(os.homedir(), 'Library/Application Support', `Olive-${fixture}`);
const info = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
assert.equal(info.profile, fixture, 'Wrong running fixture');
assert.equal(info.userData, root, 'Wrong fixture directory');
assert.equal(info.api, 'http://127.0.0.1:19333', 'Wrong fixture API');
assert.equal(info.cdp, 'http://127.0.0.1:19222', 'Wrong fixture CDP');
assert.equal(info.tokenFile, path.join(root, 'agent-token'), 'Token must belong to this fixture');
const token = fs.readFileSync(info.tokenFile, 'utf8').trim();
const api = async (route, body) => {
  const response = await fetch(info.api + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `API ${route}: HTTP ${response.status}`);
  return response.json();
};
const live = await api('/');
assert.equal(live.endpoints.api, info.api);
assert.equal(live.endpoints.activeProfile.id, info.activeProfile.id, 'Fixture profile changed before test');
const profileId = live.endpoints.activeProfile.id;
const run = `ledger-smoke-${Date.now().toString(36)}`;
const tabs = new Set();
const privateTabs = new Set();
let browser, ledger, privateUI, privateWindowId, originalEnabled;
let checks = 0;
const check = (ok, label) => { assert.ok(ok, label); checks++; console.log(`ok  ${label}`); };
const poll = async (fn, label) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}`);
};
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>Ledger smoke fixture</title><h1>Local ledger test</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = suffix => `http://127.0.0.1:${server.address().port}/${run}/${suffix}`;
const pages = () => browser.contexts().flatMap(context => context.pages());
const isUI = (page, name) => { try { return new URL(page.url()).pathname.endsWith(`/ui/${name}.html`); } catch { return false; } };
const chromeFor = async id => {
  for (const page of pages()) {
    if (!isUI(page, 'index')) continue;
    try {
      if ((await page.evaluate(() => window.olive.invoke('state'))).windowId === id) return page;
    } catch {}
  }
  return null;
};
const refresh = async () => {
  await ledger.locator('#refresh').click();
  await poll(async () => (await ledger.locator('#status').textContent()) === '', 'ledger refresh');
};
try {
  browser = await chromium.connectOverCDP(info.cdp);
  const normal = (await api('/windows')).find(win => !win.private);
  assert.ok(normal, 'Normal fixture window required');
  const ui = await chromeFor(normal.id);
  assert.ok(ui, 'Normal fixture chrome required');
  await ui.evaluate(() => window.olive.cmd('ledger'));
  await poll(() => { ledger = pages().find(page => isUI(page, 'ledger')); return ledger; }, 'native ledger window');
  await ledger.locator('#retention option').first().waitFor({ state: 'attached' });
  const read = filter => ledger.evaluate(filter => window.ledger.call('get', { filter }), filter || {});
  originalEnabled = (await read()).settings.enabled;
  assert.equal(originalEnabled, true, 'Recording must start enabled in the disposable fixture');
  check(await ledger.locator('h1').textContent() === 'Activity ledger', 'native review window opened through trusted chrome');

  const tab = await api('/tabs', { windowId: normal.id, background: true, url: url('first') + '?dummy=omitted-value#omitted-fragment' });
  tabs.add(tab.id);
  await api(`/tabs/${tab.id}/navigate`, { url: url('second') });
  await poll(async () => (await read({ query: run, type: 'visit' })).total >= 2, 'recorded visits');
  const state = await read({ query: run });
  check(state.events.some(e => e.type === 'tab-open') && state.events.some(e => e.type === 'navigation') && state.events.filter(e => e.type === 'visit').length >= 2, 'timeline contains tab, navigation and completed visits');
  check(state.events.every((e, i, all) => i === 0 || all[i - 1].time >= e.time), 'timeline is newest first');
  check(!JSON.stringify(state.events).includes('omitted-'), 'recorded URLs omit synthetic query and fragment values');

  await ledger.locator('#query').fill(run);
  await poll(async () => (await ledger.locator('#events tr').count()) === state.events.length, 'text filter renders fixture events');
  await ledger.locator('#type').selectOption('visit');
  await poll(async () => {
    const types = await ledger.locator('#events tr td:nth-child(2)').allTextContents();
    return types.length >= 2 && types.every(type => type === 'visit');
  }, 'type filter');
  check(true, 'native text and event-type filters narrow the timeline');
  await ledger.locator('#query').fill(`${run}-no-match`);
  await ledger.locator('#empty').waitFor({ state: 'visible' });
  check(await ledger.locator('#events tr').count() === 0, 'empty filter shows no matching activity');
  await ledger.locator('#query').fill(run);
  await ledger.locator('#type').selectOption('');
  await ledger.locator('#period').selectOption('today');
  await poll(async () => (await ledger.locator('#events tr').count()) > 0, 'today period includes fixture events');
  check(await ledger.locator('input[type=date]').count() === 0, 'period selector replaces HTML date controls');
  await ledger.locator('#period').selectOption('');
  await poll(async () => (await ledger.locator('#events tr').count()) > 0, 'period filter reset');

  // Pause only long enough for one local navigation; restore even on a failed assertion.
  await ledger.locator('#enabled').uncheck();
  await poll(async () => !(await read()).settings.enabled, 'recording paused');
  await api(`/tabs/${tab.id}/navigate`, { url: url('paused') });
  check((await read({ query: `${run}/paused` })).total === 0, 'paused recording stores no navigation or visit');
  await ledger.locator('#enabled').check();
  await poll(async () => (await read()).settings.enabled, 'recording resumed');
  await api(`/tabs/${tab.id}/navigate`, { url: url('resumed') });
  await poll(async () => (await read({ query: `${run}/resumed`, type: 'visit' })).total > 0, 'resumed visit');
  check(true, 'recording resumes without losing earlier events');

  const privateWindow = await api('/windows', { private: true, url: url('private') });
  privateWindowId = privateWindow.id;
  const pt = (await api('/tabs')).filter(t => t.windowId === privateWindowId);
  pt.forEach(t => privateTabs.add(t.id));
  assert.ok(pt.length > 0, 'Private fixture tab required');
  await api(`/tabs/${pt[0].id}/navigate`, { url: url('private-next') });
  await poll(async () => { privateUI = await chromeFor(privateWindowId); return privateUI; }, 'private chrome');
  check(await privateUI.locator('#btn-ledger').isHidden(), 'private chrome hides activity control');
  await privateUI.evaluate(() => window.olive.cmd('ledger'));
  check(pages().filter(page => isUI(page, 'ledger')).length === 1, 'private command cannot open a ledger window');
  const afterPrivate = await read({ query: run });
  check(!afterPrivate.events.some(e => e.details.windowId === privateWindowId || privateTabs.has(e.details.tabId) || Object.values(e.details).some(v => typeof v === 'string' && v.includes(`${run}/private`))), 'private tab open, activate, navigation and visits leave no events');

  await ledger.locator('#type').selectOption('');
  await ledger.locator('#query').fill(run);
  await refresh();
  await poll(async () => (await ledger.locator('#events tr').count()) === afterPrivate.events.length, 'screenshot only synthetic fixture rows');
  const screenshot = fileURLToPath(new URL('../notes/test-shots/ledger.png', import.meta.url));
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await ledger.screenshot({ path: screenshot });
  check((await api('/')).endpoints.activeProfile.id === profileId, 'fixture profile stayed unchanged; native profile-switch isolation deferred to parent');
  console.log(`screenshot: notes/test-shots/ledger.png`);
  console.log(`${checks} checks passed; no profile stores read, no profile switch, no other tabs closed`);
} finally {
  if (ledger && !ledger.isClosed() && originalEnabled !== undefined) {
    await ledger.evaluate(enabled => window.ledger.call('configure', { enabled }), originalEnabled).catch(() => {});
  }
  // Close only our own API-created tabs, never the shared fixture's existing ones.
  for (const id of [...tabs, ...privateTabs]) await api(`/tabs/${id}/close`, {}).catch(() => {});
  if (privateUI && !privateUI.isClosed()) {
    const state = await privateUI.evaluate(() => window.olive.invoke('state')).catch(() => null);
    // closeTab closes a window only after its last tab is gone. Guard against a
    // concurrent test having added any tabs to our otherwise-empty private window.
    if (state?.private && !state.activeId && !state.pinned.length && !state.unpinned.length) {
      await privateUI.evaluate(() => window.olive.cmd('closeTab')).catch(() => {});
    }
  }
  if (browser) await browser.close(); // CDP disconnect, not application quit.
  await new Promise(resolve => server.close(resolve));
}
