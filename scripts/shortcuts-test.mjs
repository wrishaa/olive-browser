// Isolated unit + window/menu integration checks. No running app or real profiles.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { Shortcuts, COMMANDS, normalize } = require('../src/main/shortcuts');
const { TabMRU } = require('../src/main/tab-mru');
const { matchesInput, holdForInput, holdReleased } = require('../src/main/shortcut-input');
// The display formatter never parses glyphs back into accelerators.
const rendererSource=readFileSync(new URL('../src/ui/shortcuts.js',import.meta.url),'utf8');
const displayContext=vm.createContext({});
vm.runInContext(rendererSource.split("const status =")[0],displayContext);
for(const [raw,display] of [
  ['Cmd+T','⌘T'],['Ctrl+Tab','⌃⇥'],['Ctrl+Shift+Tab','⌃⇧⇥'],
  ['Cmd+Ctrl+Alt+Shift+Down','⌃⌥⇧⌘↓'],['Cmd+Alt+Up','⌥⌘↑'],
  ['Cmd+Left','⌘←'],['Cmd+Right','⌘→'],['Ctrl+Shift+=','⌃⇧='],
  ['Cmd+Plus','⌘+'],['Cmd+Enter','⌘↩'],['Cmd+Escape','⌘⎋'],
  ['Cmd+Backspace','⌘⌫'],['Cmd+Delete','⌘⌦'],['Cmd+Space','⌘␣'],
  ['Cmd+Home','⌘↖'],['Cmd+End','⌘↘'],['Cmd+PageUp','⌘⇞'],
  ['Cmd+PageDown','⌘⇟'],['F6','F6'],['',''],
]) {
  assert.equal(displayContext.shortcutDisplay(raw),display);
  const input={dataset:{}};displayContext.setRecordedShortcut(input,raw);
  assert.equal(input.value,display);assert.equal(input.dataset.accelerator,raw);
}
const rendererHtml=readFileSync(new URL('../src/ui/shortcuts.html',import.meta.url),'utf8');
assert.ok(!/<footer|id="done"/.test(rendererHtml),'settings persists as a page without Done');

assert.equal(normalize('command + shift + k'), 'Cmd+Shift+K');
assert.equal(normalize('Control+option+Down'), 'Ctrl+Alt+Down');
for (const bad of ['Cmd', 'Cmd+Cmd+K', 'Cmd+A+B', 'K', 'Alt+K', null, 'Cmd+notakey']) assert.throws(() => normalize(bad));
const dir = mkdtempSync(path.join(tmpdir(), 'olive-shortcuts-test-'));
try {
  let changes = 0;
  const s = new Shortcuts({ dataPath:dir }, { onChange: () => changes++ });
  assert.equal(s.state().length, COMMANDS.length);
  s.set('newTab','Command+K'); assert.equal(s.accelerator('newTab'),'Cmd+K');
  assert.throws(() => s.set('reload','Cmd+K'), /Already used/);
  for (const key of ['Cmd+1','Cmd+9','Cmd+C','Cmd+Q','Cmd+Shift+]']) assert.throws(() => s.set('reload',key), /reserved/);
  assert.throws(() => s.set('reload','Ctrl+Tab'), /Already used/);
  s.set('mruNext','Cmd+Alt+K'); s.set('mruPrev','Cmd+Alt+Shift+K');
  assert.equal(s.accelerator('mruNext'),'Cmd+Alt+K');
  s.set('reload','Ctrl+Tab'); assert.equal(s.accelerator('reload'),'Ctrl+Tab');
  assert.throws(() => s.set('unknown','Cmd+K'), /Unknown/);
  s.set('reload',''); assert.equal(s.accelerator('reload'),'');
  assert.equal(JSON.parse(readFileSync(path.join(dir,'shortcuts.json'),'utf8')).reload,'');
  const loaded = new Shortcuts({dataPath:dir}, {onChange:()=>{}});
  assert.equal(loaded.accelerator('newTab'),'Cmd+K'); assert.equal(loaded.accelerator('reload'),'');
  // Swapped defaults must survive reloading, not be rejected in catalog order.
  s.set('newTab',''); s.set('newWindow','Cmd+T'); s.set('newTab','Cmd+N');
  const swapped = new Shortcuts({dataPath:dir},{onChange:()=>{}});
  assert.equal(swapped.accelerator('newTab'),'Cmd+N'); assert.equal(swapped.accelerator('newWindow'),'Cmd+T');
  const corrupt = new Shortcuts({}, {store:{data:{newTab:'Cmd+N',reload:'broken',find:4,extra:'Cmd+Y'}},onChange:()=>{}});
  assert.equal(corrupt.accelerator('newTab'),'Cmd+T'); assert.equal(corrupt.accelerator('reload'),'Cmd+R');
  s.reset(); assert.equal(s.accelerator('newTab'),'Cmd+T'); assert.equal(s.accelerator('reload'),'Cmd+R'); assert.ok(changes >= 6);

  const profileMgr = {dataPath:dir};
  const profileShortcuts = new Shortcuts(profileMgr, {onChange:()=>{}});
  profileShortcuts.set('reload','Cmd+K');
  profileMgr.dataPath = path.join(dir,'second-profile');
  profileShortcuts.reload(); assert.equal(profileShortcuts.accelerator('reload'),'Cmd+R');
  profileShortcuts.set('reload','Cmd+Y');
  profileMgr.dataPath = dir; profileShortcuts.reload(); assert.equal(profileShortcuts.accelerator('reload'),'Cmd+K');

  const m = new TabMRU(); m.touch('c'); m.touch('b'); m.touch('a');
  assert.equal(m.step(['a','b','c'],'a'), 'b');
  assert.deepEqual(m.order,['a','b','c']);
  assert.equal(m.step(['a','b','c'],'b'), 'c');
  assert.equal(m.step(['a','b','c'],'c',-1),'b');
  m.finish('b'); assert.deepEqual(m.order,['b','a','c']);
  assert.equal(m.step(['a','b','c'],'b'),'a'); m.finish('a');
  assert.equal(m.step(['a','b','c'],'a'),'b'); m.finish('b'); // A/B toggle
  assert.equal(m.step(['a','b','c'],'b',-1),'c'); m.finish('c');
  assert.equal(m.step(['a','c'],'c'),'a'); m.finish('a');
  assert.equal(new TabMRU().step([],null),null);
  assert.equal(new TabMRU().step([1],1),1);

  // Load real window/menu code with Electron mocked, never launch or touch app data.
  const Module = require('module'); const oldLoad = Module._load;
  let menu; const electron = { Menu:{buildFromTemplate:x=>x,setApplicationMenu:x=>{menu=x;}}, shell:{} };
  Module._load = function(id,...args) { return id === 'electron' ? electron : oldLoad.call(this,id,...args); };
  let OliveWindow, buildMenu;
  try { ({OliveWindow} = require('../src/main/window')); ({buildMenu} = require('../src/main/menu')); } finally { Module._load = oldLoad; }
  const w = Object.create(OliveWindow.prototype);
  Object.assign(w,{mgr:{},tabs:new Map(),tabMRU:new TabMRU(),activeId:null,find:{open:false},overlay:null,ensureView(){},layout(){},changed(){},pinned:[],unpinned:[1,2,3]});
  for (const id of w.unpinned) w.tabs.set(id,{id,lastActive:0,wc:{focus(){}}});
  w.activate(3); w.activate(2); w.activate(1);
  const wc = new EventEmitter(); w.wireTabKeys(wc);
  let prevented = 0;
  const input = (key,options={}) => wc.emit('before-input-event',{preventDefault(){prevented++;}}, {type:'keyDown',key,control:true,...options});
  const before = w.tabs.get(2).lastActive;
  input('Tab'); assert.equal(w.activeId,2); assert.equal(w.tabs.get(2).lastActive,before);
  input('Tab'); assert.equal(w.activeId,3);
  input('Tab',{shift:true}); assert.equal(w.activeId,2); assert.equal(prevented,3);
  input('Control',{type:'keyUp',control:false}); assert.equal(w.tabMRU.walk,null); assert.deepEqual(w.tabMRU.order,[2,1,3]);
  input('Tab'); assert.equal(w.activeId,1); input('Control',{type:'keyUp',control:false});
  input('Tab'); assert.equal(w.activeId,2); input('Control',{type:'keyUp',control:false});
  // missed ctrl keyUp (chromium drops keyUps after a handled keyDown): a fresh ctrl press ends the stale walk,
  // and a menu-dispatched step never continues one
  { const start = w.activeId; input('Tab'); const prev = w.activeId; input('Control'); input('Tab'); assert.equal(w.activeId,start); input('Control',{type:'keyUp',control:false});
    input('Tab'); assert.equal(w.activeId,prev); input('Control',{control:true,isAutoRepeat:true}); assert.ok(w.tabMRU.walk); w.cmd('mruNext'); assert.equal(w.activeId,start); assert.equal(w.tabMRU.walk,null);
    w.cmd('mruNext'); assert.equal(w.activeId,prev); w.cmd('mruNext'); assert.equal(w.activeId,start); }
  // esc with ctrl held cancels the walk: back to the start tab, mru unchanged, esc swallowed, the release is a no-op
  { const start = w.activeId, order = [...w.tabMRU.order]; input('Tab'); input('Tab'); assert.notEqual(w.activeId,start);
    const p0 = prevented; input('Escape'); assert.equal(prevented,p0+1); assert.equal(w.activeId,start); assert.equal(w.tabMRU.walk,null); assert.deepEqual(w.tabMRU.order,order);
    input('Escape',{type:'keyUp'}); assert.equal(prevented,p0+2); input('Control',{type:'keyUp',control:false}); assert.equal(w.activeId,start); assert.deepEqual(w.tabMRU.order,order);
    input('Escape',{control:false}); assert.equal(prevented,p0+2,'esc outside a walk is not swallowed'); }
  const active = w.activeId; input('Tab',{meta:true}); assert.equal(w.activeId,active);
  w.mgr.shortcuts = s;
  s.set('mruNext','Cmd+Alt+K'); s.set('mruPrev','Cmd+Alt+Shift+K');
  input('Tab'); assert.equal(w.activeId,active); // old binding no longer walks
  input('k',{control:false,meta:true,alt:true}); assert.equal(w.activeId,1);
  input('k',{control:false,meta:true,alt:true}); assert.equal(w.activeId,3);
  input('k',{control:false,meta:true,alt:true,shift:true}); assert.equal(w.activeId,1);
  input('Shift',{type:'keyUp',control:false,meta:true,alt:true}); assert.ok(w.tabMRU.walk);
  input('Meta',{type:'keyUp',control:false,meta:true,alt:true}); assert.equal(w.tabMRU.walk,null);
  s.set('mruNext','F6');
  input('F6',{control:false}); assert.equal(w.activeId,2); assert.ok(w.tabMRU.walk);
  input('F6',{type:'keyUp',control:false}); assert.equal(w.tabMRU.walk,null);
  s.reset();
  assert.ok(matchesInput('Ctrl+Shift+=',{control:true,shift:true,code:'Equal',key:'+'}));
  assert.ok(!matchesInput('Ctrl+Tab',{control:true,shift:true,key:'Tab'}));
  assert.ok(holdReleased(holdForInput({control:true,key:'Tab'}),{type:'keyUp',key:'Control',control:true}));
  w.cycle(1); assert.equal(w.activeId,3); w.selectIndex(1); assert.equal(w.activeId,1); w.selectIndex(9); assert.equal(w.activeId,3);
  const other = new TabMRU(); other.touch(9); assert.deepEqual(other.order,[9]);
  const mgr = {shortcuts:s,settings:{},focusedWindow:()=>w};
  buildMenu(mgr);
  const items = menu.flatMap(x=>Array.isArray(x.submenu)?x.submenu:[]);
  assert.equal(items.find(x=>x.label==='New Tab').accelerator,'Cmd+T');
  s.onChange = () => buildMenu(mgr); s.set('newTab','Cmd+K');
  assert.equal(menu.flatMap(x=>x.submenu || []).find(x=>x.label==='New Tab').accelerator,'Cmd+K');
  assert.equal(items.find(x=>x.label==='Next Recently Used Tab').accelerator,'Ctrl+Tab');
  assert.ok(items.some(x=>x.accelerator==='Cmd+Alt+Down'));
  assert.ok(items.some(x=>x.accelerator==='Cmd+9'));
  // menu: Olive > Settings… owns Cmd+, (command id 'settings'); Keyboard Shortcuts… has no accelerator
  assert.equal(items.find(x=>x.label==='Settings…').accelerator,'Cmd+,');
  assert.equal(items.find(x=>x.label==='Keyboard Shortcuts…').accelerator,undefined);
  assert.equal(COMMANDS.find(c=>c.id==='settings').label,'Settings');
  assert.equal(items.filter(x=>x.accelerator==='Cmd+,').length,1,'nothing else on Cmd+,');
  // The remapping UI is the Shortcuts tab of the one Settings page: an AppPanel in the owner window.
  const handlers = new Map();
  const ipcMain = {handle:(key,fn)=>{ if(handlers.has(key)) throw new Error('second handler for '+key); handlers.set(key,fn); },removeHandler:key=>handlers.delete(key)};
  let panelCount=0;
  class Panel extends EventEmitter {
    constructor(owner,options) {
      super(); this.owner=owner;this.options=options;panelCount++;
      this.webContents=Object.assign(new EventEmitter(),{id:900+panelCount,mainFrame:{},setIgnoreMenuShortcuts(value){this.ignoreMenus=value;},setWindowOpenHandler(fn){this.openHandler=fn;},loadFile:(file)=>{this.file=file;return Promise.resolve();},isDestroyed:()=>!!this.closed});
    }
    isDestroyed(){return !!this.closed;}
    show(){this.shown=true;}
    focus(){this.focused=true;}
    close(){this.closed=true;this.emit('closed');}
  }
  const pmgr = {dataPath:dir,windows:[w],settings:{},focusedWindow:()=>w};
  const panelShortcuts = new Shortcuts(pmgr,{onChange:()=>{}});
  pmgr.shortcuts = panelShortcuts;
  w.sendState = () => {};
  Module._load=function(id,...args){
    if(id==='electron')return {ipcMain,shell:{}};
    if(id==='./app-panel')return {AppPanel:Panel};
    return oldLoad.call(this,id,...args);
  };
  let panel;
  try {
    const { SettingsPage } = require('../src/main/settings-page');
    pmgr.settingsPage = new SettingsPage(pmgr);
    panel=panelShortcuts.showSettings();
  } finally {Module._load=oldLoad;}
  await Promise.resolve();
  assert.equal(panel.owner,w);assert.equal(panelCount,1);
  assert.ok(panel.options.captureEscape);assert.ok(panel.webContents.ignoreMenus);
  assert.ok(panel.file.endsWith('/shortcuts.html'));
  assert.equal(panelShortcuts.showSettings(w),panel);assert.equal(panelCount,1);assert.ok(panel.shown&&panel.focused);
  const handle=handlers.get('olive:shortcuts');
  assert.equal(handle({sender:{},senderFrame:{}},'reset'),null);
  assert.equal(handle({sender:panel.webContents,senderFrame:{}},'reset'),null);
  const event={sender:panel.webContents,senderFrame:panel.webContents.mainFrame};
  assert.equal(handle(event,'set',{id:'mruNext',value:'Cmd+Alt+K'}).commands.find(c=>c.id==='mruNext').value,'Cmd+Alt+K');
  assert.match(handle(event,'set',{id:'reload',value:'Cmd+Alt+K'}).error,/Already used/);
  assert.match(handle(event,'set',{id:'reload',value:'Cmd+,'}).error,/Already used by Settings/);
  assert.equal(handle(event,'reset').commands.find(c=>c.id==='mruNext').value,'Ctrl+Tab');
  // other tabs of the same page keep menu shortcuts and let Escape close the page
  pmgr.settingsPage.show(w,'extensions');
  assert.ok(panel.file.endsWith('/extensions.html'));assert.equal(panel.webContents.ignoreMenus,false);assert.equal(panel.options.captureEscape,false);assert.equal(panelCount,1);
  pmgr.settingsPage.show(w,'shortcuts');
  assert.equal(handle({sender:{},senderFrame:{}},'close'),null);assert.equal(panel.closed,undefined);
  assert.equal(handle(event,'close'),null);assert.equal(panelShortcuts.view,null);assert.equal(handlers.has('olive:shortcuts'),false);
  assert.equal(pmgr.settingsPage.view,null);
  console.log('shortcuts + MRU tests passed (isolated profiles, live menu, real window input hooks, embedded settings panel + IPC guards)');
} finally { rmSync(dir,{recursive:true,force:true}); }
