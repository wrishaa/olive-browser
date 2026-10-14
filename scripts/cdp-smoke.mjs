// end-to-end check that an ai agent can drive olive:
// 1. open a tab with the olive agent api  2. attach playwright over CDP to that exact tab
// 3. click/type/evaluate  4. read network events  5. screenshot via the api
// usage: node scripts/cdp-smoke.mjs   (olive must be running)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile = process.env.OLIVE_PROFILE ? `Olive-${process.env.OLIVE_PROFILE}` : 'Olive';
const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support', profile, 'agent.json'), 'utf8'));
const api = (p, body) =>
  fetch(info.api + p, { method: body ? 'POST' : 'GET', headers: { 'X-Olive-Agent': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const page0 = `data:text/html,<title>smoke</title><input id=q><button id=b onclick="document.title='clicked:'+q.value">go</button>`;
const tab = await (await api('/tabs', { url: page0 })).json();
console.log('api opened tab', tab.id, tab.targetId);

const browser = await chromium.connectOverCDP(info.cdp);
let page = null;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    const s = await ctx.newCDPSession(p);
    const { targetInfo } = await s.send('Target.getTargetInfo');
    await s.detach();
    if (targetInfo.targetId === tab.targetId) page = p;
  }
}
if (!page) throw new Error('tab not found over CDP');
const requests = [];
page.on('request', (r) => requests.push(r.url()));
await page.fill('#q', 'olive');
await page.click('#b');
await page.waitForFunction(() => document.title.startsWith('clicked:'));
console.log('playwright title:', await page.title());
await page.evaluate(() => fetch('https://example.com/?agent=1').catch(() => {}));
await page.waitForTimeout(800);
console.log('network seen by agent:', requests.filter((u) => u.startsWith('http')));

const ev = await (await api(`/tabs/${tab.id}/eval`, { expression: 'document.title' })).json();
console.log('api eval:', ev.result);
const cdp = await (await api(`/tabs/${tab.id}/cdp`, { method: 'Runtime.evaluate', params: { expression: '1+1' } })).json();
console.log('api cdp Runtime.evaluate 1+1 =', cdp.result.result.value);
const png = Buffer.from(await (await api(`/tabs/${tab.id}/screenshot`)).arrayBuffer());
fs.writeFileSync('/tmp/olive-smoke.png', png);
console.log('screenshot bytes', png.length, '-> /tmp/olive-smoke.png');
await api(`/tabs/${tab.id}/close`, {});
await browser.close(); // disconnects; does not quit olive
console.log('ok');
