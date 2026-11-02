// Launch ONLY our own disposable Electron fixture. Never attach to installed Olive.
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-ledger-panel-'));
const shots = path.resolve('notes/test-shots'); fs.mkdirSync(shots, { recursive: true });
let app, checks = 0;
const check = (value, message) => { assert.ok(value, message); console.log(`ok  ${message}`); checks++; };
const poll = async fn => { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 75)); } throw new Error('Fixture condition timed out'); };
const renderer = async name => {
  let found;
  // these pages are tabs now: olive://ledger, olive://profiles, olive://settings/shortcuts
  const url = name === 'shortcuts' ? 'olive://settings/shortcuts' : `olive://${name}`;
  await poll(async () => { found = (await app.windows()).filter(p => !p.isClosed() && p.url().replace(/\/$/, '') === url).pop(); return found; });
  return found;
};
const structure = () => app.evaluate(({BaseWindow}) => {
  const w=global.olive.focusedWindow(),t=w.tabs.get(w.activeId);
  return {count:BaseWindow.getAllWindows().filter(v=>v.isVisible()).length,
    // the active tab is an olive:// page in the web-content pane; no inline page / app panel
    embedded:!!t && /^olive:/.test(t.url) && !w.inlinePage && !w.appPanel && !!t.view?.getVisible() && w.win.contentView.children.includes(t.view),
    url:t?.url||null, bounds:t?.view?.getBounds(), expected:w.panes[0]?.rect};
});
const inlineContract = async (page,name) => {
  const state=await structure(); assert.deepEqual(state.bounds,state.expected,`${name}: exact browser pane bounds`);
  check(state.count===1 && state.embedded,`${name} is a normal tab filling the browser pane, no overlay or extra visible window`);
  for(const theme of ['light','dark']){
    await page.emulateMedia({colorScheme:theme});
    const result=await page.evaluate(()=>{
      const body=getComputedStyle(document.body),html=getComputedStyle(document.documentElement);
      const rgb=s=>{const values=(s.match(/[\d.]+/g)||[]).map(Number);return s.startsWith('color(srgb')?values.map((v,i)=>i<3?v*255:v):values;};
      const over=(fg,bg)=>{const a=fg.length>3?fg[3]:1;return fg.slice(0,3).map((v,i)=>v*a+bg[i]*(1-a));};
      const lum=c=>c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);
      const background=el=>{const chain=[];for(let n=el;n;n=n.parentElement)chain.unshift(n);return chain.reduce((bg,n)=>over(rgb(getComputedStyle(n).backgroundColor),bg),[255,255,255]);};
      const failures=[],clipped=[];
      for(const el of document.querySelectorAll('body *')){
        if(!el.getClientRects().length || el.matches('option,script,style') || el.closest('[hidden]') || el.disabled)continue;
        const cs=getComputedStyle(el),r=el.getBoundingClientRect();
        if(cs.visibility==='hidden'||cs.display==='none')continue;
        const text=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim() || (el.matches('input,select,button')?el.value:'');
        if(text){const bg=background(el),fg=over(rgb(cs.color),bg),l=[lum(fg),lum(bg)].sort((a,b)=>b-a),ratio=(l[0]+.05)/(l[1]+.05);if(ratio<4.5)failures.push({element:el.id||el.tagName,ratio,text:text.slice(0,50)});}
        if(el.matches('button,input,select,h1,p,label,.profile') && (r.x<-.5 || r.right>innerWidth+.5 || r.top<-.5 || r.bottom>innerHeight+.5))clipped.push(el.id||el.tagName);
      }
      const debug=/\b(?:undefined|NaN|DEBUG|apiPort|cdpPort|OLIVE_PROFILE|agent-token)\b/.test(document.body.innerText);
      return {failures,clipped,debug,width:document.documentElement.scrollWidth,viewport:innerWidth,height:document.documentElement.scrollHeight,viewportHeight:innerHeight,bg:body.backgroundColor,htmlBg:html.backgroundColor,maxWidth:body.maxWidth};
    });
    assert.deepEqual(result.failures,[],`${name}/${theme} text contrast >=4.5`);assert.deepEqual(result.clipped,[],`${name}/${theme} controls and copy not clipped`);
    assert.equal(result.debug,false,`${name}/${theme} has no debug strings`);assert.ok(result.width<=result.viewport && result.height<=result.viewportHeight,`${name}/${theme} page fits the pane`);
    assert.equal(result.bg,result.htmlBg);assert.equal(result.maxWidth,'960px');
    check(true,`${name}/${theme}: opaque page, 960px column, contrast >=4.5, no clipping or debug strings`);
  }
  await page.emulateMedia({colorScheme:'light'});
};
const responsiveContract=async(page,name)=>{
  const saved=await app.evaluate(()=>{const w=global.olive.focusedWindow();return {bounds:w.win.getBounds(),hidden:w.sidebarHidden};});
  for(const hidden of [false,true]){
    await app.evaluate((_,hidden)=>{const w=global.olive.focusedWindow();w.win.setSize(1000,740);w.sidebarHidden=hidden;w.layout();},hidden);
    await inlineContract(page,`${name}/1000x740/sidebar-${hidden?'hidden':'shown'}`);
  }
  await app.evaluate((_,saved)=>{const w=global.olive.focusedWindow();w.win.setBounds(saved.bounds);w.sidebarHidden=saved.hidden;w.layout();},saved);
};
const pollShot=async file=>{for(let n=0;n<1800;n++){if(fs.existsSync(file))return;await new Promise(r=>setTimeout(r,100));}throw new Error('CUA screenshot timed out: '+file);};
const shot = async (name, filename) => {
  await (await renderer(name)).screenshot({path:path.join(shots, filename)});
  // Query metadata only, then capture this fixture's own native window by ID.
  try {
  const source=`import CoreGraphics
import Foundation
let pid=Int(CommandLine.arguments.last!)!
let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as! [[String:Any]]
for w in windows { let b=w[kCGWindowBounds as String] as? [String:Any]; if (w[kCGWindowOwnerPID as String] as? Int)==pid && (w[kCGWindowLayer as String] as? Int)==0 && (b?["Width"] as? Double ?? 0)>600 {print(w[kCGWindowNumber as String]!);break} }`;
  const id=execFileSync('/usr/bin/swift',['-e',source,String(app.process().pid)],{encoding:'utf8',timeout:60000}).trim();
  assert.match(id,/^\d+$/, 'fixture native window ID');
  execFileSync('/usr/sbin/screencapture',['-x','-o','-l',id,path.join(shots,filename.replace('-embedded-native','-inline-full-window'))],{timeout:15000,stdio:'pipe'});
  } catch { console.log(`note: native window capture unavailable; retained actual inline page screenshot ${filename}`); }
};
try {
  let executablePath=path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if(process.argv.includes('--cua-shots')){
    const clone=path.join(root,'Olive Settings Visual.app');execFileSync('/bin/cp',['-cR',path.resolve('node_modules/electron/dist/Electron.app'),clone]);
    const plist=path.join(clone,'Contents/Info.plist');execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier com.reframe.olive.settings-visual',plist]);execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Olive Settings Visual',plist]);
    executablePath=path.join(clone,'Contents/MacOS/Electron');
  }
  app = await _electron.launch({ executablePath, args:['.'], env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'ledger-panel-fixture',OLIVE_CDP:'0',OLIVE_API_PORT:'0'}, timeout:30000 });
  await app.evaluate(async () => { while(!global.olive.ready || !global.olive.apiPort) await new Promise(r => setTimeout(r,50)); const ui=global.olive.focusedWindow().ui.webContents;if(ui.isLoading())await new Promise(resolve=>ui.once('did-finish-load',resolve));global.olive.onboarding.close(); });
  await app.evaluate(() => { const m=global.olive; m.ledger.record('visit',{url:'https://example.org/reading?synthetic=omitted#omitted'});m.ledger.record('permission',{permission:'camera',allowed:false});m.ledgerUI.show(); });
  const ledger = await renderer('ledger');
  await ledger.locator('#retention option').first().waitFor({state:'attached'});
  let state = await structure();
  await inlineContract(ledger,'activity');await responsiveContract(ledger,'activity');
  check((await ledger.evaluate(() => window.ledger.call('get'))).events.some(e=>e.type==='visit'), 'ledger tab authenticates its own main frame and loads timeline');
  await ledger.locator('#query').fill('example.org');
  await poll(async () => (await ledger.locator('#events tr').count())===1);
  check(!(await ledger.locator('#events').textContent()).includes('omitted'), 'embedded filter and URL redaction work');
  await ledger.locator('#period').selectOption('today');
  await poll(async()=>(await ledger.locator('#events tr').count())===1);
  check(await ledger.locator('input[type=date]').count()===0,'activity uses a compact period selector, never HTML date fields');
  await ledger.locator('#period').selectOption('');
  await ledger.locator('#enabled').uncheck();
  await poll(async () => !(await ledger.evaluate(() => window.ledger.call('get'))).settings.enabled);
  await app.evaluate(() => global.olive.ledger.record('visit',{url:'https://paused-fixture.invalid/'}));
  check((await ledger.evaluate(() => window.ledger.call('get',{filter:{query:'paused-fixture.invalid'}}))).total===0, 'embedded pause control prevents recording');
  await ledger.locator('#enabled').check();
  await poll(async () => (await ledger.evaluate(() => window.ledger.call('get'))).settings.enabled);
  // Dialogs must be native sheets parented to the BaseWindow, not the AppPanel.
  await app.evaluate(({dialog}) => { global.panelDialogOriginal=dialog.showMessageBox; dialog.showMessageBox=async parent=>{global.panelDialogParentOK=parent===global.olive.focusedWindow().win;return {response:0};}; });
  try { await ledger.evaluate(() => window.ledger.call('delete',{filter:{query:'nonexistent-fixture'}})); check(await app.evaluate(()=>global.panelDialogParentOK),'ledger confirmation uses its owner BaseWindow as dialog parent'); }
  finally { await app.evaluate(({dialog}) => {dialog.showMessageBox=global.panelDialogOriginal;delete global.panelDialogOriginal;}); }
  await shot('ledger','ledger-embedded-native.png');
  await app.evaluate(()=>global.olive.profileControls.show());
  const profiles=await renderer('profiles'); await profiles.getByRole('heading',{name:'Profiles',exact:true}).waitFor(); await profiles.getByText('Separate tabs, sign-ins and site settings.',{exact:true}).waitFor(); await profiles.locator('#list .profile').first().waitFor();
  state=await structure();
  const both=await app.evaluate(()=>[...global.olive.focusedWindow().tabs.values()].map(t=>t.url).filter(u=>/^olive:/.test(u)));
  check(state.count===1 && state.embedded && state.url==='olive://profiles' && !ledger.isClosed() && both.includes('olive://ledger'), 'profiles open in their own tab next to the ledger tab (both stay, like sites)');
  const data=await profiles.evaluate(()=>window.oliveProfiles.get());check(data.profiles.length===1 && data.profiles[0].active,'embedded profiles trusted IPC works');
  await profiles.locator('#list input').first().fill('Fixture renamed');
  await profiles.getByRole('button',{name:'rename',exact:true}).click();
  await poll(async ()=>(await profiles.evaluate(()=>window.oliveProfiles.get())).profiles[0].name==='Fixture renamed');
  check(true,'embedded profile rename updates fixture only');
  await inlineContract(profiles,'profiles');await responsiveContract(profiles,'profiles');
  await shot('profiles','profiles-embedded-native.png');
  await app.evaluate(()=>{const w=global.olive.focusedWindow(),t=w.tabs.get(w.activeId);t.wc.focus();t.wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});t.wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});});
  await new Promise(r=>setTimeout(r,300));
  check(!profiles.isClosed() && (await structure()).url==='olive://profiles','Escape does not close the profiles tab');
  const why=await app.evaluate(()=>{const w=global.olive.focusedWindow();const r={overlay:w.overlay,find:w.find.open};w.setOverlay(null);w.cmd('closeTab');return r;});
  await poll(()=>profiles.isClosed()).catch(e=>{throw new Error('profiles tab not closed '+JSON.stringify(why));});
  check((await structure()).count===1,'cmd+w closes the profiles tab and leaves the native window alive');
  await app.evaluate(()=>global.olive.ledgerUI.show());
  const reopened=await renderer('ledger'); await reopened.locator('#retention option').first().waitFor({state:'attached'});
  assert.equal(await reopened.locator('#done, input[type=date]').count(),0,'activity has no dialog Done or HTML date controls');
  check(reopened===ledger || !ledger.isClosed(),'Activity Event Log… focuses the open ledger tab');
  const closedLedger=await app.evaluate(()=>{const w=global.olive.focusedWindow();const t=[...w.tabs.values()].find(t=>t.url==='olive://ledger');w.closeTab(t.id);return {id:t.id,left:[...w.tabs.values()].map(x=>x.url)};});
  if(closedLedger.left.includes('olive://ledger'))throw new Error('ledger tab still open '+JSON.stringify(closedLedger));
  await poll(()=>reopened.isClosed());
  check(reopened.isClosed() && !(await app.evaluate(()=>!!global.olive.focusedWindow().appPanel)),'activity tab closes and reopens without a dialog footer');
  // Creating a profile through the embedded UI closes its owner during switching.
  await app.evaluate(()=>global.olive.profileControls.show());
  const create=await renderer('profiles'); await create.locator('#name').fill('Panel isolation');
  await create.locator('#create button').click();
  await poll(async()=>await app.evaluate(()=>global.olive.profileInfo.id!=='default' && !global.olive.switchingProfile));
  const isolated=await app.evaluate(()=>({events:global.olive.ledger.events,tabs:global.olive.windows.flatMap(w=>[...w.tabs.values()].map(t=>t.url))}));
  check(!isolated.events.some(e=>e.details.url?.includes('example.org')) && !isolated.tabs.includes('olive://profiles') && create.isClosed(), 'profile creation/switch closes the old profile\'s tabs (profiles page too) and isolates ledger');
  await app.evaluate(async()=>{await global.olive.switchProfile('default');const ui=global.olive.focusedWindow().ui.webContents;if(ui.isLoading())await new Promise(resolve=>ui.once('did-finish-load',resolve));global.olive.onboarding.close();global.olive.profileControls.show();});
  const restored=await renderer('profiles');await restored.locator('#list .profile').first().waitFor();
  check((await restored.evaluate(()=>window.oliveProfiles.get())).profiles.length===2 && (await structure()).count===1,'profiles reopen in restored profile with no detached native windows');
  assert.equal(await restored.locator('#done').count(),0,'profiles is a persistent page without a Done button');
  await app.evaluate(()=>{const w=global.olive.focusedWindow();const t=[...w.tabs.values()].find(t=>t.url==='olive://profiles');w.closeTab(t.id);});
  await poll(()=>restored.isClosed());
  check(!(await app.evaluate(()=>!!global.olive.focusedWindow().appPanel)) && (await structure()).count===1,'leaving profiles keeps the app window alive');
  if(process.argv.includes('--cua-shots')){
    for(const theme of ['light','dark']) for(const name of (process.env.OLIVE_SETTINGS_SHOT_PAGES || 'profiles,ledger,shortcuts').split(',')){
      await app.evaluate((_,{theme,name})=>{const m=global.olive,w=m.focusedWindow();process.mainModule.require('electron').nativeTheme.themeSource=theme;w.win.setSize(1360,880);w.setSidebarWidth(252);w.win.show();w.win.focus();w.setOverlay(null);if(name==='profiles')m.profileControls.show();else if(name==='ledger')m.ledgerUI.show();else m.shortcuts.showSettings();},{theme,name});
      const page=await renderer(name);for(const view of await app.windows())await view.emulateMedia({colorScheme:theme});
      await page.locator(name==='shortcuts'?'#commands .row':name==='profiles'?'#list .profile':'#retention option').first().waitFor({state:'attached'});
      await page.evaluate(()=>document.activeElement.blur());
      await page.screenshot({path:path.join(shots,`settings-${name}-${theme}-page.png`)});
      const file=path.join(shots,`settings-${name}-${theme}-full-window.png`);fs.rmSync(file,{force:true});
      fs.writeFileSync('/tmp/olive-settings-shot-request.json',JSON.stringify({file,name,theme,bundle:'com.reframe.olive.settings-visual',title:'Olive',pid:app.process().pid}));
      console.log('CUA_SHOT_REQUEST:',name,theme);
      await pollShot(file);execFileSync('/usr/bin/sips',['-s','format','png',file,'--out',file],{stdio:'ignore'});
      fs.rmSync('/tmp/olive-settings-shot-request.json',{force:true});
    }
  }
  console.log(`${checks} checks passed; own fresh fixture only; screenshots notes/test-shots/{ledger,profiles}-embedded-native.png`);
} finally { if(app)await app.close();fs.rmSync(root,{recursive:true,force:true}); }
