import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
// Disposable Electron fixture only; never attaches to installed Olive.
// Run: node scripts/sidebar-native-test.mjs [--cua-shots]
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shots=path.join(repo,'notes/test-shots');fs.mkdirSync(shots,{recursive:true});
const cuaShots=process.argv.includes('--cua-shots');
const cue=path.join(shots,'sidebar-shot-request.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'olive-sidebar-fixture-'));
fs.writeFileSync(path.join(root,'onboarding.json'),JSON.stringify({version:1,step:'done',completed:true}));
let app,ui;const results=[];
const check=(yes,label,detail)=>{results.push({ok:!!yes,label,detail});console.log((yes?'PASS ':'FAIL ')+label+(yes?'':' '+JSON.stringify(detail)));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const poll=async fn=>{for(let i=0;i<100;i++){const v=await fn();if(v)return v;await pause(50);}throw new Error('poll timeout');};
const pollShot=async file=>{for(let i=0;i<2400;i++){if(fs.existsSync(file)){execFileSync('/usr/bin/sips',['-s','format','png',file,'--out',file]);assert.equal(fs.readFileSync(file).subarray(1,4).toString(),'PNG');return;}await pause(100);}throw new Error('CUA screenshot timeout: '+file);};
const state=()=>app.evaluate(()=>{const w=global.olive.focusedWindow();return {hidden:w.sidebarHidden,overlay:w.overlay,lights:w.windowButtonsVisible,history:w.__nativeLights,panes:w.panes,fullscreen:w.win.isFullScreen()};});
const move=async(x,y,ms=220)=>{await app.evaluate((_,point)=>{global.olive.focusedWindow().__testPointer=point;},{x,y});await ui.mouse.move(x,y);await pause(ms);};
const hidden=async(v=true)=>{await app.evaluate((_,v)=>{const w=global.olive.focusedWindow();if(w.sidebarHidden!==v)w.toggleSidebar();w.setOverlay(null);w.sendState();},v);await pause(100);};
let appPath=path.join(repo,'node_modules/electron/dist/Electron.app');
try {
 if(cuaShots){
  const clone=path.join(root,'Olive Sidebar Fixture.app');execFileSync('/bin/cp',['-cR',appPath,clone]);appPath=clone;
  const plist=path.join(clone,'Contents/Info.plist');
  execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier com.reframe.olive.sidebar-fixture',plist]);
  execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Olive Sidebar Fixture',plist]);
 }
 app=await _electron.launch({executablePath:path.join(appPath,'Contents/MacOS/Electron'),args:[repo],cwd:repo,env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'sidebar-regression',OLIVE_CDP:'1',OLIVE_CDP_PORT:'0',OLIVE_API_PORT:'0'},timeout:30000});
 await app.evaluate(async()=>{while(!global.olive?.ready)await new Promise(r=>setTimeout(r,50));global.olive.onboarding.close();const w=global.olive.focusedWindow();w.win.setTitle('Olive sidebar synthetic regression fixture');const native=w.win.setWindowButtonVisibility.bind(w.win);w.__nativeLights=[];
 // Several agents can use the desktop concurrently. Ignore unrelated native
 // pointer coordinates in THIS disposable chrome only; Playwright still sends
 // real Chromium mouse input, not dispatched DOM hover events.
 w.ui.webContents.on('before-mouse-event',(event,mouse)=>{const p=w.__testPointer;if(p&&(mouse.x!==p.x||mouse.y!==p.y))event.preventDefault();});w.win.setWindowButtonVisibility=v=>{w.__nativeLights.push(v);native(v);};for(const t of [...w.tabs.values()])w.closeTab(t.id,{force:true});w.createTab({url:'data:text/html,<title>synthetic reading page</title><body style="background:%23ffffff"><h1>synthetic reading page</h1></body>',pinned:true});w.setOverlay(null);w.win.setSize(1280,800);w.win.focus();});
 ui=await poll(async()=>(await app.windows()).find(p=>p.url().includes('/ui/index.html')));
 await ui.locator('#pinned .row').waitFor();
 for(const theme of ['light','dark']) for(const width of [252,180]) {
  const label=`${theme}/${width}`;
  await app.evaluate(({nativeTheme},{theme,width})=>{nativeTheme.themeSource=theme;global.olive.focusedWindow().setSidebarWidth(width);},{theme,width});await ui.emulateMedia({colorScheme:theme});
  await hidden(false);
  check((await state()).lights===true,label+' pinned sidebar shows native lights');
  let rect=await ui.evaluate(()=>{const r=s=>{const a=document.querySelector(s).getBoundingClientRect();return {x:a.x,y:a.y,right:a.right,bottom:a.bottom};};return {reserve:r('.traffic-space'),nav:r('.nav-buttons'),first:r('#pinned .row'),top:r('.topbar')};});
  check(rect.reserve.x<=16&&rect.reserve.right>=70&&rect.reserve.y<=18&&rect.reserve.bottom>=34&&rect.first.y>=46&&!(rect.nav.x<72&&rect.nav.y<34),label+' pinned header reserves native lights (also at minimum width)',rect);
  await move(500,300,20);await hidden();
  let s=await state();check(s.lights===false&&s.panes[0].page.x===8&&s.panes[0].page.y===8,label+' hidden lights absent and page retains full card bounds',s);
  await move(1,1);s=await state();check(s.overlay==='peek'&&s.lights===true,label+' very top-left edge reveals sidebar + native lights',s);
  rect=await ui.evaluate(()=>{const r=document.querySelector('#sidebar').getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom};});
  check(rect.x===0&&rect.y===0&&rect.bottom===800,label+' no top/left inset gap in hover envelope',rect);
  for(const [x,y] of [[50,1],[100,1],[100,24],[50,25],[width-10,24],[12,44]]) {await move(x,y);s=await state();check(s.overlay==='peek'&&s.lights===true,label+` pointer (${x},${y}) does not collapse header`,s);}
  rect=await ui.evaluate(()=>{const r=s=>{const a=document.querySelector(s).getBoundingClientRect();return {x:a.x,y:a.y,right:a.right,bottom:a.bottom};};return {reserve:r('.traffic-space'),nav:r('.nav-buttons'),first:r('#pinned .row'),region:getComputedStyle(document.querySelector('.topbar')).webkitAppRegion};});
  check(rect.first.y>=46&&rect.reserve.right>=70&&rect.region==='no-drag'&&!(rect.nav.x<72&&rect.nav.y<34),label+' peek keeps full reserve and header receives pointer events',rect);
  await move(width+60,150,50);await move(width-10,150,230);check((await state()).overlay==='peek',label+' short page crossing cancels delayed collapse');
  await move(width+80,150,260);s=await state();check(s.overlay===null&&s.lights===false,label+' deliberate page crossing hides sidebar + native lights',s);
  await move(1,300);check((await state()).overlay==='peek',label+' left edge reopens after collapse');
  await ui.keyboard.press('Escape');await pause(120);s=await state();check(s.overlay===null&&s.lights===false,label+' escape hides sidebar and native lights',s);
  await app.evaluate(()=>{const w=global.olive.focusedWindow();w.openPalette('new');});await pause(150);await move(1,1);s=await state();check(s.overlay==='palette'&&s.lights===false,label+' hidden-sidebar palette does not expose lights or activate peek',s);
  await ui.keyboard.press('Escape');await pause(100);
 }
 await hidden(true);await app.evaluate(()=>{const w=global.olive.focusedWindow();w.htmlFullscreenId=w.activeId;w.layout();w.sendState();});await pause(120);await move(500,100,20);await move(1,1);let s=await state();check(s.lights===false&&s.overlay===null,'html fullscreen disables lights and hover reveal',s);
 await app.evaluate(()=>{const w=global.olive.focusedWindow();w.htmlFullscreenId=null;w.layout();w.sendState();});await hidden(false);
 await app.evaluate(()=>global.olive.focusedWindow().win.setFullScreen(true));await poll(async()=>(await state()).fullscreen);await pause(500);check((await state()).lights===false,'native fullscreen suppresses custom inset native lights');
 await app.evaluate(()=>global.olive.focusedWindow().win.setFullScreen(false));await poll(async()=>!(await state()).fullscreen);await pause(500);check((await state()).lights===true,'leaving native fullscreen restores visible-sidebar native lights');
 s=await state();check(s.history.includes(true)&&s.history.includes(false),'actual native setWindowButtonVisibility called for both states',s.history);
 if(cuaShots) for(const theme of ['light','dark']) for(const mode of ['hidden','peek']) {
  await app.evaluate(({nativeTheme},theme)=>{nativeTheme.themeSource=theme;const w=global.olive.focusedWindow();w.setSidebarWidth(252);w.win.setTitle('Olive sidebar synthetic regression fixture');w.win.show();w.win.focus();},theme);
  await ui.emulateMedia({colorScheme:theme});await move(500,300,20);await hidden(true);
  if(mode==='peek')await move(1,1);
  const file=path.join(shots,`sidebar-${mode}-${theme}.png`);fs.rmSync(file,{force:true});
  fs.writeFileSync(cue,JSON.stringify({appPath,file,title:'Olive sidebar synthetic regression fixture',pid:app.process().pid,mode,theme},null,2));
  console.log('CUA_SHOT_REQUEST: '+cue+' '+mode+'/'+theme);
  await pollShot(file);fs.rmSync(cue,{force:true});
 }

} catch(error) {results.push({ok:false,label:'test exception',detail:String(error.stack||error)});console.error(error);}
finally {fs.writeFileSync(path.join(shots,'sidebar-native-test.json'),JSON.stringify(results,null,2));fs.rmSync(cue,{force:true});if(app)await app.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);if(results.some(r=>!r.ok))process.exitCode=1;
