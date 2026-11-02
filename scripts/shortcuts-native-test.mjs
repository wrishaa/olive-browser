// Launches its own throwaway Electron fixture; never targets installed Olive.
// Run: node scripts/shortcuts-native-test.mjs
// Actual Electron before-input-event keydown/up plus CDP settings controls.
// These are app-level injected events, not physical OS keyboard release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright-core';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-shortcuts-native-'));
fs.writeFileSync(path.join(dir,'onboarding.json'), JSON.stringify({version:1,step:'done',completed:true}));
const app = await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:['.'],env:{...process.env,OLIVE_USER_DATA_DIR:dir,OLIVE_PROFILE:'shortcuts-native',OLIVE_CDP:'1',OLIVE_CDP_PORT:'0',OLIVE_API_PORT:'0'},timeout:30000});
await app.evaluate(async()=>{while(!global.olive.ready||!global.olive.apiPort) await new Promise(r=>setTimeout(r,50));});
const info = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'));
const token = fs.readFileSync(info.tokenFile, 'utf8').trim();
const api = async (route, body) => {
  const res = await fetch(info.api + route, { method:body ? 'POST' : 'GET', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:body ? JSON.stringify(body) : undefined });
  const result = await res.json();
  assert.ok(res.ok, `${route}: ${JSON.stringify(result)}`);
  return result;
};
const browser = await chromium.connectOverCDP(info.cdp);
const pages = () => browser.contexts().flatMap(c => c.pages());
const wait = async (fn, label) => {
  for (let i=0;i<100;i++) { const value = await fn(); if (value) return value; await new Promise(r=>setTimeout(r,50)); }
  throw new Error(`timeout: ${label}`);
};
const before = new Set(pages());
let win, ui, settings, original, baselineChildren;
const owned = new Set();
const live = new Map();
async function active() { return (await api('/windows')).find(w=>w.id===win.id)?.activeTabId; }
async function expectActive(id) { await wait(async()=>await active()===id, `active tab ${id}`); }
async function activate(id) { await api(`/tabs/${id}/activate`,{}); }
// CDP page key injection does not reliably reach Electron before-input-event.
// sendInputEvent exercises that actual hook without global OS key synthesis.
async function key(key, code, modifiers, type='keyDown', keyCode=0) {
  assert.ok(live.has(await active()), 'input must target an owned tab');
  await wait(()=>app.evaluate((_,id)=>{const w=global.olive.windows.find(w=>w.id===id);const wc=w.tabs.get(w.activeId).wc;w.win.show();w.win.focus();wc.focus();return wc.isFocused();},win.id),'active page focus before injected input');
  if(type==='keyUp') assert.ok(await app.evaluate((_,id)=>!!global.olive.windows.find(w=>w.id===id).tabWalkHold,win.id),'walk must still be held before injected modifier release');
  const flags=[modifiers&2?'control':null,modifiers&4?'meta':null,modifiers&1?'alt':null,modifiers&8?'shift':null].filter(Boolean);
  await app.evaluate((_,{id,key,type,flags})=>{const w=global.olive.windows.find(w=>w.id===id);const wc=type==='keyUp'?w.ui.webContents:w.tabs.get(w.activeId).wc;if(type==='keyUp')wc.focus();if(!wc.shortcutTestLog){wc.shortcutTestLog=true;wc.on('before-input-event',(_,input)=>(global.shortcutTestLog ||= []).push(input));} if(type==='keyDown'&&!w.tabWalkHold) {for(const modifier of flags.filter(f=>f!=='shift'))wc.sendInputEvent({type:'keyDown',keyCode:{control:'Control',meta:'Meta',alt:'Alt'}[modifier],modifiers:flags});}wc.sendInputEvent({type,keyCode:key==='Meta'?'Meta':key,modifiers:flags});},{id:win.id,key,type,flags});
  if(type==='keyUp') {try {await wait(()=>app.evaluate((_,id)=>!global.olive.windows.find(w=>w.id===id).tabWalkHold,win.id),`${key} release commits actual Electron hook`);} catch(e){console.error(await app.evaluate((_,id)=>({log:global.shortcutTestLog,hold:global.olive.windows.find(w=>w.id===id).tabWalkHold}),win.id));throw e;}}
}
async function tab(shift=false) { await key('Tab','Tab',2 | (shift?8:0),'keyDown',9); }
async function releaseControl() { await key('Control','ControlLeft',0,'keyUp',17); }
async function newTab(name) {
  const t = await api('/tabs',{windowId:win.id,url:`data:text/html,<title>shortcuts-native-${name}</title><h1>${name}</h1>`});
  owned.add(t.id);
  const p = await wait(()=>pages().find(p=>p.url().includes(`shortcuts-native-${name}`)), `tab ${name}`);
  live.set(t.id,p); return t.id;
}
async function openSettings() {
  await ui.evaluate(()=>olive.cmd('shortcuts'));
  // Settings > Keyboard Shortcuts is a normal tab at olive://settings/shortcuts
  return wait(()=>pages().filter(p=>!p.isClosed()&&p.url()==='olive://settings/shortcuts').pop(), 'shortcut settings tab');
}
// Esc never closes the tab; cmd+w (or the sidebar row ×) does, like any tab
async function closeSettings(method='cmdw') {
  try {
    if (method==='escape') {
      await settings.locator('header p').first().click();await settings.keyboard.press('Escape');
      await new Promise(r=>setTimeout(r,300));
      assert.equal(settings.isClosed(),false,'Escape does not close the Settings tab');
      assert.equal((await structure()).settingsTab,true);
    }
    await app.evaluate((_,id)=>{const w=global.olive.windows.find(w=>w.id===id);const t=[...w.tabs.values()].find(t=>/^olive:\/\/settings/.test(t.url));w.activate(t.id);w.cmd('closeTab');},win.id);
  } catch(error) { if(!String(error).includes('has been closed')) throw error; }
  await wait(()=>settings.isClosed(),'settings closed by '+method);
  const closed=await structure();
  assert.equal(closed.settingsTab,false);assert.equal(closed.inline,false);
  assert.equal(closed.children,baselineChildren,'closing the tab removes its view');
  settings=null;
}
async function remap(id, label, chord, expected) {
  const input=settings.locator(`#${id}`);
  await input.press(chord);
  assert.equal(await input.getAttribute('data-accelerator'),expected);
  assert.equal(await input.inputValue(), await settings.evaluate(raw => shortcutDisplay(raw),expected));
  await settings.getByRole('button',{name:`save ${label}`,exact:true}).click();
  await wait(()=>settings.locator(`#${id}`).getAttribute('data-accelerator').then(v=>v===expected), `${id} live value`);
  assert.equal(await settings.locator('#status').innerText(),'');
}
async function structure() {
  return app.evaluate(({BaseWindow},id)=>{
    const w=global.olive.windows.find(w=>w.id===id);
    const t=[...w.tabs.values()].find(t=>/^olive:\/\/settings/.test(t.url));
    const {width,height}=w.win.getContentBounds();
    const x=w.sidebarHidden?8:w.sidebarWidth;
    const children=w.win.contentView.children;
    return {
      windows:BaseWindow.getAllWindows().length,
      visible:BaseWindow.getAllWindows().filter(w=>w.isVisible()).length,
      inline:!!w.inlinePage||!!w.appPanel,
      settingsTab:!!t, active:!!t&&w.activeId===t.id, url:t?.url||null,
      tabVisible:!!t?.view?.getVisible(),
      children:children.length,
      bounds:t?.view?.getBounds()||null,
      pane:w.panes[0]?.rect||null,
      otherTabsVisible:[...w.tabs.values()].some(x=>x!==t&&x.view?.getVisible()),
    };
  },win.id);
}
// Settings is the active tab: its own view in the web-content pane, no overlay
function assertTabPane(state,baseline) {
  assert.equal(state.windows,baseline.windows);assert.equal(state.visible,1);
  assert.equal(state.inline,false,'no inline page / app panel');
  assert.equal(state.settingsTab,true);assert.equal(state.active,true);assert.equal(state.url,'olive://settings/shortcuts');
  assert.equal(state.tabVisible,true);
  assert.equal(state.children,baseline.children+1,'exactly one more view: the tab');
  assert.deepEqual(state.bounds,state.pane,'the Settings tab fills the web-content pane');
  assert.equal(state.otherTabsVisible,false,'the other tabs are hidden behind it like any tab switch');
}


try {
  win = (await api('/windows'))[0];
  ui = await wait(()=>pages().find(p=>p.url().includes('/ui/index.html')), 'own window chrome');
  await app.evaluate(()=>global.olive.focusedWindow().win.setTitle('shortcuts disposable fixture'));
  const baseline=await structure();
  console.log('window baseline:',JSON.stringify(baseline));
  assert.equal(baseline.visible,1);baselineChildren=baseline.children;
  const c = await newTab('c'), b = await newTab('b'), a = await newTab('a');
  await ui.evaluate(()=>olive.cmd('overlay',{kind:null}));
  await activate(c); await activate(b); await activate(a);
  await tab(); await expectActive(b); await releaseControl();
  await tab(); await expectActive(a); await releaseControl();
  console.log('ok: A/B toggle across separate held walks');
  await activate(c); await activate(b); await activate(a);
  await tab(); await expectActive(b);
  await tab(); await expectActive(c);
  await tab(true); await expectActive(b); await releaseControl();
  console.log('ok: frozen three-tab walk and shift reverse; Electron Control keyUp commits actual input hook');
  await api(`/tabs/${b}/close`,{}); owned.delete(b); live.delete(b);
  await activate(c); await activate(a);
  await tab(); await expectActive(c); await releaseControl();
  await tab(); await expectActive(a); await releaseControl();
  console.log('ok: closed tab excluded from MRU');
  baseline.children=(await structure()).children;baselineChildren=baseline.children;
  settings = await openSettings();
  await settings.locator('#mruNext').waitFor();
  assert.equal(await settings.locator('#done, footer').count(),0,'shortcuts is a persistent page, not a Done dialog');
  assert.equal(await settings.locator('#mruNext').inputValue(),'⌃⇥');
  assert.equal(await settings.locator('#mruPrev').inputValue(),'⌃⇧⇥');
  assert.equal(await settings.locator('#nextTab').inputValue(),'⌥⌘↓');
  assert.equal(await settings.locator('#newTab').getAttribute('data-accelerator'),'Cmd+T');
  assert.equal(await settings.locator('#newTab').inputValue(),'⌘T');
  original = await settings.evaluate(()=>shortcuts.get());
  assert.ok(original.commands.some(c=>c.id==='mruNext'), 'fixture needs relaunch: current MRU catalog not loaded');
  const embedded=await structure();
  assertTabPane(embedded,baseline);
  await app.evaluate((_,id)=>{const w=global.olive.windows.find(w=>w.id===id);w.toggleSidebar();},win.id);
  assertTabPane(await structure(),baseline);
  await app.evaluate((_,id)=>{const w=global.olive.windows.find(w=>w.id===id);w.toggleSidebar();},win.id);
  assertTabPane(await structure(),baseline);
  console.log('ok: Settings is a normal tab: olive://settings/shortcuts fills the pane (sidebar shown/hidden), no overlay; BaseWindow count unchanged');
  await remap('mruNext','Next Recently Used Tab','Meta+Alt+k','Cmd+Alt+K');
  await remap('mruPrev','Previous Recently Used Tab','Meta+Alt+Shift+k','Cmd+Alt+Shift+K');
  // Conflicts are shown inline without replacing the existing binding.
  await settings.locator('#reload').press('Meta+Alt+k');
  await settings.getByRole('button',{name:'save Reload',exact:true}).click();
  await wait(()=>settings.locator('#status').innerText().then(t=>t.includes('Already used')), 'conflict feedback');
  assert.equal((await settings.evaluate(()=>shortcuts.get())).commands.find(c=>c.id==='reload').value,'Cmd+R');
  const shot = path.resolve('notes/test-shots/shortcuts.png'); fs.mkdirSync(path.dirname(shot),{recursive:true});
  await settings.screenshot({path:shot,fullPage:true});

  await closeSettings('cmdw');
  console.log('ok: cmd+w closes the Settings tab and removes its view');
  await activate(c); await activate(a);
  await key('k','KeyK',5,'keyDown',75); await expectActive(c);
  await key('k','KeyK',13,'keyDown',75); await expectActive(a);
  await key('Meta','MetaLeft',1,'keyUp',91);
  await key('k','KeyK',5,'keyDown',75); await expectActive(c);
  await key('Meta','MetaLeft',1,'keyUp',91);
  console.log('ok: CDP recorder, conflict rejection, live remap; Electron Command keyUp commits actual input hook');
  settings = await openSettings();
  await settings.locator('#mruNext').press('Control+Shift+z');
  await settings.locator('#mruNext').press('Escape');
  assert.equal(settings.isClosed(),false);
  assert.equal(await settings.locator('#mruNext').inputValue(),'⌥⌘K');
  assert.equal(await settings.locator('#mruNext').getAttribute('data-accelerator'),'Cmd+Alt+K');
  await settings.locator('#stop').press('Control+Shift+Equal');
  assert.equal(await settings.locator('#stop').inputValue(),'⌃⇧=');
  assert.equal(await settings.locator('#stop').getAttribute('data-accelerator'),'Ctrl+Shift+=');
  await settings.locator('#stop').press('Escape');
  assert.equal(await settings.locator('#stop').inputValue(),'⌘.');
  await remap('stop','Stop','Meta+ArrowLeft','Cmd+Left');
  assert.equal(await settings.locator('#stop').inputValue(),'⌘←');
  await remap('stop','Stop','Backspace','');
  assert.equal(await settings.locator('#stop').inputValue(),'');
  assert.equal((await settings.evaluate(()=>shortcuts.get())).commands.find(c=>c.id==='stop').value,'');
  await remap('stop','Stop','F6','F6');
  assert.equal((await settings.evaluate(()=>shortcuts.get())).commands.find(c=>c.id==='stop').value,'F6');
  await settings.getByRole('button',{name:'Reset all to defaults',exact:true}).click();
  await settings.keyboard.press('Escape');
  assert.equal(settings.isClosed(),false);
  assert.equal(await settings.locator('#reset-confirm').isVisible(),false);
  await settings.getByRole('button',{name:'Reset all to defaults',exact:true}).click();
  await settings.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await settings.locator('#mruNext').inputValue(),'⌥⌘K');
  assert.equal(await settings.locator('#mruNext').getAttribute('data-accelerator'),'Cmd+Alt+K');
  await settings.getByRole('button',{name:'Reset all to defaults',exact:true}).click();
  await settings.getByRole('button',{name:'Reset shortcuts',exact:true}).click();
  await wait(()=>settings.locator('#mruNext').getAttribute('data-accelerator').then(v=>v==='Ctrl+Tab'), 'reset defaults');
  assert.equal(await settings.locator('#mruNext').inputValue(),'⌃⇥');
  assert.equal(await settings.locator('#mruPrev').inputValue(),'⌃⇧⇥');
  await closeSettings('escape');
  console.log('ok: Escape outside the recorder does not close the Settings tab; cmd+w does');
  await activate(a); await tab(); await expectActive(c); await releaseControl();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'shortcuts.json'),'utf8')),{});
  console.log(`ok: reset persisted and default Ctrl+Tab works again; screenshot ${shot}`);
} finally {
  // Restore settings and close only our throwaway fixture.
  if (original && ui && !ui.isClosed()) {
    if (!settings || settings.isClosed()) settings=await openSettings();
    await settings.evaluate(async commands=>{
      await shortcuts.reset();
      if(commands.some(c=>c.value!==c.accelerator)) {
        for (const c of commands) await shortcuts.set(c.id,'');
        for (const c of commands) await shortcuts.set(c.id,c.value);
      }
    }, original.commands);
  }
  if (settings && !settings.isClosed()) await app.evaluate(()=>{for(const w of global.olive.windows)for(const t of [...w.tabs.values()])if(/^olive:/.test(t.url))w.closeTab(t.id,{force:true});});
  for (const id of owned) await api(`/tabs/${id}/close`,{}).catch(()=>{});
  if (ui && !ui.isClosed()) await ui.evaluate(()=>{olive.cmd('overlay',{kind:null});olive.cmd('closeTab');}).catch(()=>{});
  await browser.close();
  await app.close(); // only the process launched above
  fs.rmSync(dir,{recursive:true,force:true});
}
