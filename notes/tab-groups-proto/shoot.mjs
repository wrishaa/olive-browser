// renders the prototype scenes to notes/test-shots/tab-groups/ at 2x with the cached
// playwright chromium headless shell. usage: node notes/tab-groups-proto/shoot.mjs [scene…]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../test-shots/tab-groups');
fs.mkdirSync(out, { recursive: true });
const html = 'file://' + path.join(here, 'index.html');

function findShell() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort();
  for (const d of dirs.reverse()) {
    const p = path.join(base, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no cached chromium headless shell');
}

const SIDEBAR_H = 760;
const WIDE = new Set(['context-menu', 'group-menu']); // native menus pop over the page
// scene -> widths to render in sidebar mode
const scenes = {
  basic: [252, 180],
  'collapsed-active': [252, 180],
  multiselect: [252],
  'context-menu': [252],
  'group-menu': [252],
  'drag-into': [252],
  'drag-reorder': [252],
  rename: [252],
  'agent-working': [252, 180],
  'agent-expanded': [252],
  'agent-done': [252],
  'agent-hover': [252],
  'agent-hover-done': [252],
  'agent-emptied': [252],
  'many-groups-w500': [252],
  'basic-w500': [252],
  'agent-active': [252],
  'two-agents': [252, 180],
  'agent-starting': [252],
  empty: [252],
  'empty-named': [252],
  'long-names': [252, 180],
  'many-groups': [252],
  'split-in-group': [252],
  'no-groups': [252],
};
// full 1280x800 window renders: every scene at 252, the width-sensitive ones at 180 too
const full = Object.entries(scenes).map(([scene, widths]) => [scene, widths]);

const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: findShell() });
const shots = [];
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const shoot = async (scene, w, mode, vw, vh) => {
    if (only.length && !only.includes(scene)) return;
    await page.setViewportSize({ width: vw, height: vh });
    await page.goto(`${html}?scene=${scene}&w=${w}&mode=${mode}&shot`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(60);
    const name = `${scene}-${scheme}-${w}${mode === 'full' ? '-window' : ''}.png`;
    await page.screenshot({ path: path.join(out, name) });
    shots.push(name);
  };
  for (const [scene, widths] of Object.entries(scenes)) for (const w of widths) await shoot(scene, w, 'sidebar', w + (WIDE.has(scene) ? 380 : 56), SIDEBAR_H);
  for (const [scene, widths] of full) for (const w of widths) await shoot(scene, w, 'full', 1280, 800);
  await ctx.close();
}
await browser.close();
console.log(shots.join('\n'));
