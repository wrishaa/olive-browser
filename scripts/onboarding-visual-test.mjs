// Real Olive chrome + InlinePage, disposable userData, OS/importer traps installed
// before main is loaded. Never attaches to an installed app or a shared fixture.
// Run: node scripts/onboarding-visual-test.mjs
// Screenshots are renderer diagnostics; full native/CUA captures remain a separate check.
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const cuaMode = process.env.OLIVE_VISUAL_CUA === '1';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-onboarding-visual-'));
const output = path.join(project, 'notes/test-shots/onboarding-visual');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cdp: false, agentApi: false }));
const wrapper = path.join(root, 'fixture.cjs');
fs.writeFileSync(wrapper, `
const electron = require('electron');
const { app, systemPreferences, desktopCapturer, shell, dialog } = electron;
app.setPath('userData', ${JSON.stringify(root)});
global.visualCalls = [];
global.visualMedia = { microphone:'not-determined', camera:'not-determined', screen:'denied' };
const forbidden = name => (...args) => { global.visualCalls.push({ name, args }); throw new Error('Forbidden fixture side effect: ' + name); };
systemPreferences.getMediaAccessStatus = kind => global.visualMedia[kind] || 'not-determined';
systemPreferences.askForMediaAccess = forbidden('askForMediaAccess');
desktopCapturer.getSources = forbidden('desktopCapturer.getSources');
shell.openExternal = forbidden('shell.openExternal');
app.relaunch = forbidden('app.relaunch');
dialog.showMessageBox = forbidden('dialog.showMessageBox');
const importerPath = require.resolve(${JSON.stringify(path.join(project, 'src/main/browser-import.js'))});
require.cache[importerPath] = { id:importerPath, filename:importerPath, loaded:true, exports:{
  discoverBrowsers:async()=>[
    { id:'chrome',name:'Google Chrome',supported:true,profiles:[
      {id:'chrome:Default',name:'Personal',supported:true},
      {id:'chrome:Profile 1',name:'Work',supported:true}] },
    { id:'arc',name:'Arc',supported:true,profiles:[{id:'arc:Default',name:'Personal',supported:true}] },
    { id:'safari',name:'Safari',supported:false,profiles:[{id:'safari:Default',name:'Default',supported:false,reason:'Not supported yet'}] },
    { id:'firefox',name:'Firefox',supported:false,profiles:[{id:'firefox:Default',name:'Default',supported:false,reason:'Not supported yet'}] }
  ],
  importSelected:forbidden('importSelected')
} };
require(${JSON.stringify(path.join(project, 'src/main/main.js'))});
`);
const failures = [], records = [];
let app, checks = 0;
function check(ok, message, details) {
  checks++;
  if (!ok) failures.push({ message, details });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && details ? ': ' + JSON.stringify(details) : ''}`);
}
async function poll(fn, label) {
  for (let n = 0; n < 150; n++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}
async function renderer(name) {
  return poll(async () => (await app.windows()).find(page => {
    try { return new URL(page.url()).pathname.endsWith(`/ui/${name}.html`); } catch { return false; }
  }), name);
}
async function structure() {
  return app.evaluate(({ BaseWindow }) => {
    const m = global.olive, w = m.focusedWindow(), page = m.onboarding.view;
    const frame = w.win.getContentBounds(), x = w.sidebarHidden ? 8 : w.sidebarWidth;
    return {
      visibleWindows: BaseWindow.getAllWindows().filter(win => win.isVisible()).map(win => ({ title: win.getTitle(), bounds: win.getBounds() })),
      expected: { x, y: 8, width: frame.width - x - 8, height: frame.height - 16 },
      actual: page?.content?.getBounds(), pane: w.panes[0]?.rect,
      embedded: !!page && page.owner === w && page === w.inlinePage && w.win.contentView.children.includes(page.content),
      setupOnTop: !!page && w.win.contentView.children.at(-1) === page.content,
      sidebarWidth: w.sidebarWidth, frame: { width: frame.width, height: frame.height },
      hiddenTabs: [...w.tabs.values()].every(tab => !tab.view || !tab.view.getVisible()),
      normal: !w.isPrivate, overlay: w.overlay,
    };
  });
}
// Browser-computed foreground/background colours, alpha-composited in sRGB,
// then WCAG relative luminance. Every visible text node is tested, including
// footnotes, statuses and disabled button labels. Dots/SVGs have no text nodes.
// This page has solid backgrounds; unsupported images/gradients fail explicitly.
async function audit(page, { sidebar = false } = {}) {
  return page.evaluate(({ sidebar }) => {
    const visible = element => {
      if (!element || !element.getClientRects().length) return false;
      for (let e = element; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false;
      }
      return true;
    };
    const rgb = value => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) throw new Error('Unsupported computed colour: ' + value);
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const over = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return [...front.slice(0, 3).map((c, i) => alpha ? (c * front[3] + back[i] * back[3] * (1 - front[3])) / alpha : 0), alpha];
    };
    const background = element => {
      const chain = [];
      for (let e = element; e; e = e.parentElement) chain.push(e);
      let result = [255, 255, 255, 1];
      for (const e of chain.reverse()) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== 'none') throw new Error('Unmodelled background image: ' + e.id);
        result = over(rgb(s.backgroundColor), result);
      }
      return result;
    };
    const luminance = colour => colour.slice(0, 3).map(v => {
      v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const clipped = (element, rect) => {
      const reasons = [];
      if (rect.left < -0.5 || rect.top < -0.5 || rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5) reasons.push('viewport');
      for (let e = element.parentElement; e; e = e.parentElement) {
        const style = getComputedStyle(e), r = e.getBoundingClientRect();
        if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (rect.left < r.left - 0.5 || rect.right > r.right + 0.5)) reasons.push((e.id || e.tagName) + ':x');
        if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (rect.top < r.top - 0.5 || rect.bottom > r.bottom + 0.5)) reasons.push((e.id || e.tagName) + ':y');
      }
      return reasons;
    };
    const interactive = [...document.querySelectorAll(sidebar ? '#sidebar button, #setup-row, #setup-close' : 'button, input, select, a[href], [role=button]')]
      .filter(visible).map(element => {
        const r = element.getBoundingClientRect(), reasons = clipped(element, r);
        // Sample within the painted capsule, not its transparent rounded corners.
        for (const [x, y] of [[r.left+r.width/2,r.top+r.height/2],[r.left+Math.min(9,r.width/3),r.top+r.height/2],[r.right-Math.min(9,r.width/3),r.top+r.height/2]]) {
          const hit = document.elementFromPoint(x, y);
          if (hit !== element && !element.contains(hit)) reasons.push('occluded:' + (hit?.id || hit?.tagName || 'none'));
        }
        return { id: element.id || element.outerHTML.slice(0, 80), rect: { x:r.x,y:r.y,width:r.width,height:r.height }, reasons, pointerEvents:getComputedStyle(element).pointerEvents, disabled:element.disabled, styles:element.getAttribute('style') };
      });
    const text = [], walker = document.createTreeWalker(sidebar ? document.querySelector('#sidebar') : document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent.trim(), element = node.parentElement;
      if (!value || !visible(element) || ['SCRIPT', 'STYLE'].includes(element.tagName)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue;
      const entry = { id: element.id || element.className || element.tagName, text: value, reasons: [...new Set([...range.getClientRects()].flatMap(r => clipped(element, r)))] };
      // Sidebar's translucent native vibrancy/gradient cannot be inferred from
      // computed CSS alone; audit its text/layout/leaks, not a made-up contrast.
      if (!sidebar) {
        try {
          const bg = background(element), fg = rgb(getComputedStyle(element).color);
          let opacity = 1;
          for (let e = element; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
          fg[3] *= opacity;
          const a = luminance(over(fg, bg)), b = luminance(bg);
          entry.contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          entry.foreground = getComputedStyle(element).color;
          entry.background = bg;
          entry.disabled = !!element.closest(':disabled');
        } catch (error) { entry.error = error.message; }
      }
      text.push(entry);
    }
    const content = document.querySelector('#content')?.getBoundingClientRect(), footer = document.querySelector('footer')?.getBoundingClientRect();
    return { interactive, text, uiText: (sidebar ? document.querySelector('#sidebar') : document.body).innerText,
      viewport: { width:innerWidth,height:innerHeight },
      footnoteVisible: sidebar || visible(document.querySelector('.pane:not([hidden]) .footnote')),
      contentFooterOverlap: !!(content && footer && content.bottom > footer.top),
      scroll: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth };
  }, { sidebar });
}
const leakPattern = /\b(?:api|cdp|ports?)\b|(?:localhost|127\.0\.0\.1)(?::\d+)?|:\d{4,5}\b/i;
try {
  let executablePath = path.join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if(cuaMode){
    const clone=path.join(root,'Olive Onboarding Visual.app');
    execFileSync('/bin/cp',['-cR',path.join(project,'node_modules/electron/dist/Electron.app'),clone]);
    const plist=path.join(clone,'Contents/Info.plist');
    execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier com.reframe.olive.onboarding-visual',plist]);
    execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Olive Onboarding Visual',plist]);
    executablePath=path.join(clone,'Contents/MacOS/Electron');
  }
  app = await _electron.launch({
    executablePath, args: [wrapper], cwd: project,
    env: { ...process.env, OLIVE_USER_DATA_DIR: root, OLIVE_PROFILE: 'onboarding-visual', OLIVE_CDP: '0', OLIVE_API_PORT: '0' }, timeout: 30000,
  });
  app.process().stdout.on('data', data => process.stdout.write('[fixture] '+data));
  app.process().stderr.on('data', data => process.stderr.write('[fixture] '+data));
  await app.evaluate(async () => { while (!global.olive?.ready) await new Promise(r => setTimeout(r, 25)); });
  console.log('startup', await app.evaluate(()=>({profile:global.olive.profileInfo,saved:global.olive.onboarding.saved,view:!!global.olive.onboarding.view,apiPort:global.olive.apiPort})));
  const chrome = await renderer('index');
  let page = await renderer('onboarding');
  await page.locator('#welcome-title').waitFor();
  // A real tab row lets us exercise chrome hit-testing during inline setup.
  await app.evaluate(() => {
    const w = global.olive.focusedWindow();
    const tab = w.createTab({ url: '', title: 'Fixture tab', activate: false });
    tab.title = 'Fixture tab'; w.sendState();
  });
  const steps = ['welcome', 'calls', 'screen', 'import', 'done'];
  for (const [width, height] of cuaMode ? [[1280,800]] : [[1280,800],[1360,880]]) {
    for (const appearance of ['light','dark']) {
      await app.evaluate(({nativeTheme}, {width,height,appearance}) => {
        nativeTheme.themeSource = appearance;
        const w = global.olive.focusedWindow(); w.win.setSize(width,height); w.setSidebarWidth(252); w.layout();
      }, {width,height,appearance});
      await chrome.emulateMedia({colorScheme:appearance});
      await page.emulateMedia({colorScheme:appearance});
      check(await page.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches)===(appearance==='dark'), `${width}x${height}-${appearance}: requested appearance is actually active`);
      for (const step of cuaMode ? ['welcome','calls','import','done'] : steps) {
        const label = `${width}x${height}-${appearance}-${step}`;
        await app.evaluate(({}, step) => { const o=global.olive.onboarding; o.saved.step=step; o.push(); global.olive.focusedWindow().sendState(); }, step);
        await page.locator(`#${step}-title`).waitFor();
        if (step === 'import') await page.locator('#sources input').first().waitFor();
        await page.waitForTimeout(180); // allow the intentional 140ms pane animation to finish
        const state = await structure(), result = await audit(page), sidebar = await audit(chrome, {sidebar:true});
        check(state.visibleWindows.length === 1 && state.embedded && state.setupOnTop && state.hiddenTabs, `${label}: sole visible BaseWindow, setup is top child view; tabs hidden`, state);
        check(JSON.stringify(state.actual) === JSON.stringify(state.expected) && JSON.stringify(state.pane) === JSON.stringify(state.expected), `${label}: exact live page/pane bounds`, state);
        check(state.frame.width === width && state.frame.height === height && result.viewport.width === state.expected.width && result.viewport.height === state.expected.height, `${label}: exact requested window and renderer dimensions`, {state, viewport:result.viewport});
        check(!result.scroll && !result.contentFooterOverlap && result.footnoteVisible, `${label}: no page scroll/overlap and disclosure visible`, result);
        const clipped = [...result.interactive,...sidebar.interactive].filter(item=>item.reasons.length);
        check(clipped.length === 0, `${label}: all visible interactive controls unclipped and hit-testable`, clipped);
        const clippedText = result.text.filter(item=>item.reasons.length);
        check(clippedText.length === 0, `${label}: visible text not clipped`, clippedText);
        const contrast = result.text.filter(item=>item.error || item.contrast < 4.5);
        check(contrast.length === 0, `${label}: every visible text node contrast >=4.5 (footnotes and disabled labels included)`, contrast);
        check(!leakPattern.test(result.uiText+'\n'+sidebar.uiText), `${label}: no API/CDP/port strings in visible UI`, {page:result.uiText,sidebar:sidebar.uiText});
        check(await chrome.locator('#setup-row.active').isVisible(), `${label}: sidebar shows active setup row`);
        if (step==='import') check(await page.locator('#sources input:checked').count()===0 && await page.locator('#next').isDisabled(), `${label}: cookie import defaults unchecked/disabled`);
        await page.screenshot({path:path.join(output, `${label}-page.png`)});
        await chrome.screenshot({path:path.join(output, `${label}-chrome.png`)});
        records.push({label,state,page:result,sidebar, screenshots:[`${label}-page.png`,`${label}-chrome.png`]});
        if (process.env.OLIVE_VISUAL_CUA === '1') {
          // The caller captures the foreground native window with CUA, then
          // removes the handshake file. Never substitutes renderer shots.
          const pending = path.join(output, 'cua-pending.json');
          await app.evaluate(() => { const w=global.olive.focusedWindow(); w.win.show(); w.win.focus(); });
          fs.writeFileSync(pending,JSON.stringify({label,pid:app.process().pid,root,bundleId:'com.reframe.olive.onboarding-visual',file:path.join(output,`${label}-full-window.jpg`)}));
          const deadline=Date.now()+600000;
          while(fs.existsSync(pending)) {
            if(Date.now()>deadline) throw new Error('Timed out waiting for CUA capture '+label);
            await new Promise(resolve=>setTimeout(resolve,100));
          }
        }
      }
    }
  }
  // Test actual renderer -> IPC -> host chrome. No direct command stand-ins.
  await app.evaluate(() => { const o=global.olive.onboarding; o.saved.step='screen'; o.push(); });
  await page.locator('#screen-title').waitFor();
  await chrome.locator('#setup-row').hover();
  await chrome.locator('#setup-close').click();
  await poll(async()=>!(await app.evaluate(()=>!!global.olive.onboarding.view)), 'sidebar Set Up Later');
  check(await app.evaluate(()=>global.olive.onboarding.saved.paused), 'sidebar close pauses inline setup');
  await chrome.locator('#setup-row').click();
  page = await renderer('onboarding'); await page.locator('#screen-title').waitFor();
  check((await structure()).visibleWindows.length===1, 'sidebar setup row reopens same step without detached windows');
  await chrome.locator('#btn-sidebar').click();
  await poll(async()=>await app.evaluate(()=>global.olive.focusedWindow().sidebarHidden), 'sidebar hide');
  let state=await structure();
  check(JSON.stringify(state.actual)===JSON.stringify(state.expected) && state.actual.x===8, 'live sidebar hide expands setup to exact page bounds',state);
  await app.evaluate(()=>global.olive.focusedWindow().cmd('toggleSidebar'));
  await chrome.locator('#newtab').click();
  await poll(async()=>await app.evaluate(()=>global.olive.focusedWindow().overlay==='palette'), 'live New Tab');
  check(await chrome.locator('#palette').isVisible() && !(await app.evaluate(()=>!!global.olive.onboarding.view)), 'live sidebar New Tab closes setup and opens actual palette');
  check((await app.evaluate(()=>global.visualCalls)).length===0, 'no macOS/media/screen/Keychain/import/relaunch/dialog call occurred', await app.evaluate(()=>global.visualCalls));
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),root);
} catch (error) {
  failures.push({message:error.message,stack:error.stack}); console.error(error);
} finally {
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks, failures, records, note:'Own disposable Electron. Page/chrome diagnostic screenshots are separate WebContents captures, not full native window captures. Sidebar contrast is not inferred from translucent vibrancy; page contrast uses actual computed solid backgrounds.'},null,2));
  if(app)await app.close();
  fs.rmSync(root,{recursive:true,force:true});
}
console.log(`onboarding visual contract: ${checks} checks, ${failures.length} failures; report/screenshots ${path.relative(project,output)}`);
if(failures.length)process.exitCode=1;
