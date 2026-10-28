// mockup | built, one pair per built shot, plus one contact sheet per theme. rendered with
// the cached playwright chromium headless shell (no install), like the prototype's
// shoot.mjs. images are inlined as data urls (a file:// page cannot load file:// images).
// run: node scripts/tab-groups-contact-sheet.mjs   (reads notes/test-shots/tab-groups-built/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'notes/test-shots/tab-groups-built');
const mockDir = path.join(repo, 'notes/test-shots/tab-groups');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function findShell() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const p = path.join(base, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const dataUrl = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');

export async function contactSheet(made) {
  const shell = findShell();
  if (!shell) return console.log('no cached headless shell: no contact sheet');
  const browser = await chromium.launch({ executablePath: shell });
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1400, height: 900 } });
  const pairs = made.filter((f) => fs.existsSync(path.join(mockDir, f)) && fs.existsSync(path.join(outDir, f))).map((f) => ({ name: f.replace(/\.png$/, ''), mock: dataUrl(path.join(mockDir, f)), built: dataUrl(path.join(outDir, f)) }));
  const cell = (p) => `<figure><div class="pair"><div><img src="${p.mock}"><figcaption>mockup</figcaption></div><div><img src="${p.built}"><figcaption>built</figcaption></div></div><h3>${p.name}</h3></figure>`;
  const css = `body{margin:0;background:#15171a;color:#ddd;font:12px -apple-system,system-ui;padding:16px}h2{font-size:14px;margin:0 0 12px;color:#fff}figure{margin:0 18px 18px 0;display:inline-block;vertical-align:top}.pair{display:flex;gap:8px}.pair img{display:block;height:380px;width:auto;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.5)}.pair div{display:flex;flex-direction:column;gap:4px}figcaption{color:#9aa;font-size:11px}h3{font-size:12px;font-weight:500;margin:6px 0 0;color:#cfd}`;
  for (const p of pairs) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.setContent(`<style>${css}</style>${cell(p)}`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    const fig = await page.locator('figure').boundingBox();
    await page.screenshot({ path: path.join(outDir, `pair-${p.name}.png`), clip: { x: 0, y: 0, width: Math.ceil(fig.x + fig.width + 16), height: Math.ceil(fig.y + fig.height + 16) } });
  }
  for (const theme of ['light', 'dark']) {
    const mine = pairs.filter((p) => p.name.includes(`-${theme}-`));
    await page.setViewportSize({ width: 2400, height: 900 });
    await page.setContent(`<style>${css}</style><h2>tab groups · ${theme} · mockup | built (${mine.length} pairs)</h2>${mine.map(cell).join('')}`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    await pause(100);
    await page.screenshot({ path: path.join(outDir, `contact-sheet-${theme}.png`), fullPage: true });
  }
  await browser.close();
  console.log(`contact sheets: ${pairs.length} pairs`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = JSON.parse(fs.readFileSync(path.join(outDir, 'SHOTS.json'), 'utf8')).made;
  await contactSheet(made);
}
