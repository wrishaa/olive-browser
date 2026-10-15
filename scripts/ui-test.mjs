// drive the olive chrome ui itself over CDP (sidebar drag, split, find, palette)
// usage: OLIVE_PROFILE=dev node scripts/ui-test.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile = process.env.OLIVE_PROFILE ? `Olive-${process.env.OLIVE_PROFILE}` : 'Olive';
const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support', profile, 'agent.json'), 'utf8'));
const api = async (p, body) =>
  (await fetch(info.api + p, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${fs.readFileSync(info.tokenFile, 'utf8').trim()}` }, body: body ? JSON.stringify(body) : undefined })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failures++; };

// fresh fixture: three simple tabs
for (const t of await api('/tabs')) await api(`/tabs/${t.id}/close`, {});
const mk = (n) => `data:text/html,<title>${n}</title><body style="font:20px system-ui;padding:30px">${n} <a href="https://example.com" target="_blank">new tab link</a>`;
const a = await api('/tabs', { url: mk('alpha') });
const b = await api('/tabs', { url: mk('beta') });
const c = await api('/tabs', { url: mk('gamma') }); // active

const browser = await chromium.connectOverCDP(info.cdp);
const ui = browser.contexts().flatMap((x) => x.pages()).find((p) => p.url().includes('/src/ui/index.html') || p.url().includes('/ui/index.html'));
if (!ui) throw new Error('ui page not found');
// The last test run may leave the sidebar hidden; establish a repeatable fixture.
await ui.evaluate(async () => { const s = await olive.invoke('state'); if (s.sidebarHidden) olive.cmd('toggleSidebar'); });
await sleep(300);

// 1. drag alpha's row onto the page area -> split with active (gamma)
const row = ui.locator(`.row[data-id="${a.id}"]`);
const box = await row.boundingBox();
await ui.mouse.move(box.x + 40, box.y + box.height / 2);
await ui.mouse.down();
await ui.mouse.move(box.x + 60, box.y + 30, { steps: 4 });
await ui.mouse.move(900, 400, { steps: 8 });
await ui.mouse.up();
await sleep(400);
let tabs = await api('/tabs');
const ta = tabs.find((t) => t.id === a.id);
const tc = tabs.find((t) => t.id === c.id);
check(ta.splitId && ta.splitId === tc.splitId, 'drag tab onto page makes a split');
check((await ui.locator('.split-group').count()) === 1, 'sidebar shows one split group');

// 2. drag beta to the top of the unpinned list (reorder)
const rb = await ui.locator(`.row[data-id="${b.id}"]`).boundingBox();
const first = await ui.locator('#unpinned > *').first().boundingBox();
await ui.mouse.move(rb.x + 40, rb.y + rb.height / 2);
await ui.mouse.down();
await ui.mouse.move(rb.x + 40, rb.y - 10, { steps: 3 });
await ui.mouse.move(first.x + 40, first.y + 4, { steps: 6 });
await ui.mouse.up();
await sleep(300);
const firstId = await ui.locator('#unpinned > *').first().getAttribute('data-id');
check(Number(firstId) === b.id, 'drag reorders tabs');

// 3. drag beta into the pinned area (above the divider)
const rb2 = await ui.locator(`.row[data-id="${b.id}"]`).boundingBox();
const div = await ui.locator('#divider').boundingBox();
await ui.mouse.move(rb2.x + 40, rb2.y + rb2.height / 2);
await ui.mouse.down();
await ui.mouse.move(rb2.x + 40, rb2.y - 10, { steps: 3 });
await ui.mouse.move(div.x + 40, div.y - 2, { steps: 6 });
await ui.mouse.up();
await sleep(300);
tabs = await api('/tabs');
check(tabs.find((t) => t.id === b.id).pinned, 'drag into pinned section pins');

// 4. split divider resize
const sp = ui.locator('.splitter[data-split]');
check((await sp.count()) === 1, 'split divider present');
const sb = await sp.boundingBox();
const before = await ui.evaluate(() => document.querySelector('.card').getBoundingClientRect().width);
await ui.mouse.move(sb.x + sb.width / 2, sb.y + 200);
await ui.mouse.down();
await ui.mouse.move(sb.x - 150, sb.y + 200, { steps: 6 });
await ui.mouse.up();
await sleep(300);
const after = await ui.evaluate(() => document.querySelector('.card').getBoundingClientRect().width);
check(after < before - 100, `divider drag resizes panes (${Math.round(before)} -> ${Math.round(after)})`);

// 5. palette: open via the + button, type, enter
await ui.click('#btn-new');
await sleep(200);
check(await ui.locator('#palette-scrim').isVisible(), 'palette opens');
await ui.keyboard.type('example.com');
await sleep(300);
await ui.keyboard.press('Enter');
await sleep(1500);
tabs = await api('/tabs');
check(tabs.some((t) => t.url.startsWith('https://example.com') && t.active), 'palette opens url in new active tab');

// 6. find bar via the api's active tab: use menu-equivalent cmd through the ui bridge
await ui.evaluate(() => window.olive.cmd('find'));
await sleep(300);
check(await ui.locator('#findbar').isVisible(), 'find bar shows');
await ui.keyboard.type('domain');
await sleep(500);
const count = await ui.locator('#find-count').textContent();
check(/\d+\/\d+/.test(count), `find counts matches (${count})`);
await ui.keyboard.press('Escape');
await sleep(200);
check(!(await ui.locator('#findbar').isVisible()), 'esc closes find');

// 7. sidebar toggle
await ui.evaluate(() => window.olive.cmd('toggleSidebar'));
await sleep(300);
check(await ui.evaluate(() => document.body.classList.contains('sidebar-hidden')), 'sidebar hides');
await ui.evaluate(() => window.olive.cmd('toggleSidebar'));
await sleep(200);

// 8. target=_blank opens an olive tab next to the opener
const before8 = (await api('/tabs')).length;
const ex = (await api('/tabs')).find((t) => t.url.startsWith('https://example.com'));
await api(`/tabs/${ex.id}/eval`, { expression: "window.open('https://example.org', '_blank'); 1" });
await sleep(1500);
check((await api('/tabs')).length === before8 + 1, 'window.open(_blank) becomes a tab');

// 9. Real webpage input. CDP dispatches real input events, not DOM .click().
// It bypasses native NSWindow hit-testing, so ALSO guard the actual cause:
// no UI draggable rectangle may overlap any page/devtools pane.
const wikiTab = await api('/tabs', { url: 'https://en.wikipedia.org/wiki/Olive' });
await sleep(400);
let wiki;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
  const session = await ctx.newCDPSession(p);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  await session.detach();
  if (targetInfo.targetId === wikiTab.targetId) wiki = p;
}
if (!wiki) throw new Error('real page target not found');
await wiki.waitForSelector('#firstHeading');
const guardDragRegions = async (label) => {
  const overlap = await ui.evaluate(() => {
    const panes = [...document.querySelectorAll('.card')].map(e => e.getBoundingClientRect());
    return [...document.querySelectorAll('*')].filter(e => {
      if (getComputedStyle(e).getPropertyValue('-webkit-app-region') !== 'drag') return false;
      const r = e.getBoundingClientRect();
      return r.width && r.height && panes.some(p => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top);
    }).map(e => e.id || e.className);
  });
  check(!overlap.length, `native drag regions never cover page panes (${label}: ${overlap.join(',') || 'clear'})`);
};
await guardDragRegions('normal');
await ui.click('#btn-new');
await sleep(200);
await ui.keyboard.press('Escape');
await sleep(200);
await guardDragRegions('after palette');
await wiki.evaluate(() => {
  window.__oliveInput = { click: 0, wheel: 0 };
  addEventListener('click', () => __oliveInput.click++);
  addEventListener('wheel', () => __oliveInput.wheel++);
});
const hit = await wiki.evaluate(() => document.elementFromPoint(400, 300)?.tagName);
check(!!hit, `real page elementFromPoint has a hit (${hit})`);
await wiki.mouse.click(400, 300);
await wiki.mouse.wheel(0, 800);
await sleep(500);
const input = await wiki.evaluate(() => ({ ...__oliveInput, scrollY }));
check(input.click > 0, 'real webpage receives mouse click');
check(input.wheel > 0 && input.scrollY > 100, `real webpage receives wheel and scrolls (${input.scrollY}px)`);
await api(`/tabs/${wikiTab.id}/close`, {});

const { permissionTests } = await import('./permission-test.mjs');
await permissionTests({ api, browser, ui, check });

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
