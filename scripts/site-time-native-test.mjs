// Disposable fixture only. No real profile, installed app, OS input or network dependencies.
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-site-time-native-'));
const shots = path.resolve('notes/test-shots'); fs.mkdirSync(shots,{recursive:true});
const cue = '/tmp/olive-site-time-shot-request.json';
const singleShot = process.argv.includes('--cua-light-populated-only');
const cua = process.argv.includes('--cua-shots') || singleShot;
let app, checks = 0, appPath;
const check = (value, label) => { assert.ok(value,label); ++checks; console.log('ok:',label); };
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const poll = async (fn, label='condition', count=120) => { for(let n=0;n<count;n++){if(await fn())return;await wait(50);}throw new Error('Timed out: '+label); };
const renderer = async () => { let page; await poll(async()=>{page=(await app.windows()).find(p=>p.url().endsWith('/ui/site-time.html'));return page;},'activities renderer'); await page.locator('#seg-week[aria-selected=true]').waitFor(); return page; };
const state = () => app.evaluate(()=>global.olive.siteTime.state('all'));
function clearOwnCue() {
  if (!cua || !app) return;
  try { if (JSON.parse(fs.readFileSync(cue, 'utf8')).pid === app.process().pid) fs.rmSync(cue, { force: true }); } catch (_) {}
}
const server=http.createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>site time fixture</title><h1>local foreground fixture</h1>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
fs.writeFileSync(path.join(root,'onboarding.json'),JSON.stringify({version:1,completed:true,step:'done'}));
async function show() { await app.evaluate(()=>global.olive.siteTime.show()); return renderer(); }
async function seed() {
  await app.evaluate(()=>{
    const m=global.olive,t=m.siteTime.tracker;t.reset();
    for(let back=6;back>=0;back--){const d=new Date();d.setDate(d.getDate()-back);d.setHours(12,0,0,0);const from=d.getTime();for(const [site,seconds] of [['github.com',420+back*84],['developer.apple.com',180+back*44],['example.org',74+back*20],['wikipedia.org',38+back*7]])t.add(site,from,from+seconds*1000);}
    t.flush();
  });
}
async function cueShot(file,theme,range) {
  fs.rmSync(file,{force:true});fs.writeFileSync(cue,JSON.stringify({appPath,file,theme,range,pid:app.process().pid}));
  console.log('CUA_SHOT_REQUEST:',JSON.stringify({appPath,file,theme,range}));
  await poll(()=>fs.existsSync(file),'CUA full-window capture '+file,6000);clearOwnCue();
}
try {
  let executablePath=path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if(cua){appPath=path.join(root,'Olive Site Time Visual.app');execFileSync('/bin/cp',['-cR',path.resolve('node_modules/electron/dist/Electron.app'),appPath]);const plist=path.join(appPath,'Contents/Info.plist');execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier com.reframe.olive.site-time-visual',plist]);execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Olive Site Time Visual',plist]);executablePath=path.join(appPath,'Contents/MacOS/Electron');}
  app=await _electron.launch({executablePath,args:['.'],env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'site-time-fixture',OLIVE_CDP:'0',OLIVE_API_PORT:'0'},timeout:30000});
  await app.evaluate(async()=>{while(!global.olive?.ready)await new Promise(r=>setTimeout(r,25));global.olive.onboarding.close();const w=global.olive.focusedWindow();w.setOverlay(null);w.win.show();w.win.focus();});
  // createTab/ensureView owns the initial navigation. A second loadURL here
  // races it and can reject with ERR_FAILED even though the server is healthy.
  const fixtureURL=`http://127.0.0.1:${port}/private-path?secret=omitted`;
  const tabId=await app.evaluate((_,url)=>{const t=global.olive.focusedWindow().createTab({url,activate:true});global.siteTimeNavigation=[];for(const name of ['did-fail-load','did-navigate','did-finish-load'])t.wc.on(name,(_, ...args)=>global.siteTimeNavigation.push({name,args}));return t.id;},fixtureURL);
  try { await poll(async()=>await app.evaluate((_,{id,url})=>{const wc=global.olive.focusedWindow().tabs.get(id)?.wc;return wc && !wc.isLoading() && wc.getURL()===url && wc.getTitle()==='site time fixture';},{id:tabId,url:fixtureURL}),'local fixture finished its single navigation'); }
  catch(error) { console.error('navigation diagnostics:',await app.evaluate((_,id)=>{const w=global.olive.focusedWindow(),t=w.tabs.get(id);return {events:global.siteTimeNavigation,url:t?.wc?.getURL(),tabURL:t?.url,title:t?.wc?.getTitle(),loading:t?.wc?.isLoading(),activeId:w.activeId};},tabId));throw error; }
  await poll(async()=>(await state()).currentSite==='127.0.0.1','native foreground starts');
  await app.evaluate(({app})=>{app.focus({steal:true});global.olive.focusedWindow().win.focus();global.olive.siteTime.refresh();});
  try { await poll(async()=>await app.evaluate(({app})=>{const m=global.olive,w=m.focusedWindow();if(!w.win.isFocused()){app.focus({steal:true});w.win.focus();}m.siteTime.refresh();return m.siteTime.state('all').totalSeconds>=1;}),'one second of native foreground HTTP time'); }
  catch(error) { console.error('foreground diagnostics:',await app.evaluate(()=>{const m=global.olive,w=m.focusedWindow();return {state:m.siteTime.state('all'),suspended:m.siteTime.suspended,locked:m.siteTime.locked,overlay:w?.overlay,inline:w?.inlinePage?.kind,focused:w?.win.isFocused(),visible:w?.win.isVisible(),minimized:w?.win.isMinimized(),activeURL:w?.tabs.get(w.activeId)?.wc?.getURL()};}));throw error; }
  check(true,'real focused visible HTTP page accrues time');
  let page=await show(); const before=(await state()).totalSeconds; await wait(1200);
  check((await state()).totalSeconds===before,'inline activities excludes underlying page time');
  const layout=await app.evaluate(({BaseWindow})=>{const w=global.olive.focusedWindow(),p=w.inlinePage,{width,height}=w.win.getContentBounds();return {count:BaseWindow.getAllWindows().filter(w=>w.isVisible()).length,embedded:w.win.contentView.children.includes(p.content),bounds:p.content.getBounds(),expected:{x:w.sidebarWidth,y:8,width:width-w.sidebarWidth-8,height:height-16}};});
  assert.deepEqual(layout.bounds,layout.expected);check(layout.count===1&&layout.embedded,'activities is full browser-pane inline view, never a popup');
  check(await app.evaluate(()=>global.olive.focusedWindow().snapshot().appPage?.title==='Settings'),'activities (Settings > Activities) snapshot exposes inline title and close row');
  check((await page.evaluate(()=>window.oliveSiteTime.get('all'))).siteCount===1,'trusted renderer main-frame IPC returns host-only data');
  check(!(await page.locator('#time-rows').innerText()).includes('private-path'),'UI never contains a path or query');
  await page.locator('#seg-today').click();await poll(async()=>await page.locator('#seg-today').getAttribute('aria-selected')==='true');
  check((await page.locator('#average-note').innerText())==='over 1 calendar day','today denominator is one');
  await page.locator('#seg-week').click();await poll(async()=>await page.locator('#average-note').innerText()==='over 7 calendar days');check(true,'seven-day denominator stays seven');
  await page.locator('#seg-week').press('ArrowRight');await poll(async()=>await page.locator('#seg-all').getAttribute('aria-selected')==='true');check(true,'segmented control supports keyboard arrow navigation');
  await app.evaluate(({dialog})=>{global.siteTimeDialog=dialog.showMessageBox;dialog.showMessageBox=async(parent,options)=>{global.siteTimeDialogCheck={parent:parent===global.olive.focusedWindow().win,options};return {response:0};};});
  await page.evaluate(()=>window.oliveSiteTime.reset('all'));
  const dialogCheck=await app.evaluate(()=>global.siteTimeDialogCheck);check(dialogCheck.parent&&dialogCheck.options.defaultId===0&&dialogCheck.options.cancelId===0,'reset is a native attached confirmation with Cancel default');check((await state()).totalSeconds===before,'cancel preserves all tracked time');
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await page.evaluate(()=>window.oliveSiteTime.reset('all'));check((await state()).totalSeconds===0,'confirmed reset clears site time only');
  await app.evaluate(({dialog})=>{dialog.showMessageBox=global.siteTimeDialog;delete global.siteTimeDialog;});
  await app.evaluate(()=>{const m=global.olive,w=m.focusedWindow();w.openPalette('new');m.siteTime.refresh();});const palette=(await state()).totalSeconds;await wait(1100);check((await state()).totalSeconds===palette,'palette overlay excludes page time');
  await app.evaluate(()=>{const w=global.olive.focusedWindow();w.overlay=null;w.win.minimize();global.olive.siteTime.refresh();});const minimized=(await state()).totalSeconds;await wait(1100);check((await state()).totalSeconds===minimized,'minimized native window excludes page time');
  await app.evaluate(()=>{const m=global.olive,w=m.focusedWindow();w.win.restore();w.win.show();w.win.focus();m.siteTime.refresh();process.mainModule.require('electron').powerMonitor.emit('suspend');});const suspend=(await state()).totalSeconds;await wait(1100);check((await state()).totalSeconds===suspend,'suspend excludes foreground time');
  await app.evaluate(()=>{process.mainModule.require('electron').powerMonitor.emit('resume');const m=global.olive,w=m.focusedWindow();w.isPrivate=true;m.siteTime.refresh();});const priv=(await state()).totalSeconds;await wait(1100);check((await state()).totalSeconds===priv,'private owner never contributes time');
  await app.evaluate(()=>{const m=global.olive,w=m.focusedWindow();w.isPrivate=false;m.siteTime.show();});page=await renderer();await seed();
  await page.locator('#seg-week').click();await poll(async()=>await page.locator('.site-row').count()===4);check(true,'synthetic seven-day chart and ranked site list render');
  await app.evaluate(()=>{const w=global.olive.focusedWindow();w.win.setSize(1280,800);w.layout();});
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
        const text=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
        if(text){const bg=background(el),fg=over(rgb(cs.color),bg),l=[lum(fg),lum(bg)].sort((a,b)=>b-a),ratio=(l[0]+.05)/(l[1]+.05);if(ratio<4.5)failures.push({element:el.id||el.className||el.tagName,ratio,text:text.slice(0,50)});}
        // Ranked rows may scroll. Fixed header/summary/chart controls must fit.
        if(el.matches('.page-header,.summary,.chart-section,.site-head,.segments button') && (r.x<-.5||r.right>innerWidth+.5||r.top<-.5||r.bottom>innerHeight+.5))clipped.push(el.id||el.className||el.tagName);
      }
      return {failures,clipped,width:document.documentElement.scrollWidth,viewport:innerWidth,debug:/\b(?:undefined|NaN|DEBUG|apiPort|cdpPort|OLIVE_PROFILE|agent-token)\b/.test(document.body.innerText),bars:document.querySelectorAll('.day').length,background:body.backgroundColor,root:html.backgroundColor,footer:document.querySelector('footer').getBoundingClientRect().toJSON(),height:innerHeight};
    });
    assert.deepEqual(result.failures,[],`${theme} alpha-composited text contrast >=4.5`);
    assert.deepEqual(result.clipped,[],`${theme} header, summary, chart and range controls fit at 1280x800`);
    check(result.width<=result.viewport&&!result.debug&&result.bars===7&&result.background===result.root,`${theme} layout is opaque, unclipped and has seven bars without debug strings`);
    check(true,`${theme} alpha-composited text contrast >=4.5; header and controls fit at 1280x800 (ranked list may scroll)`);
    console.log('footer:',theme,JSON.stringify({top:result.footer.top,bottom:result.footer.bottom,viewportHeight:result.height,scrolls:result.footer.bottom>result.height}));
    await page.screenshot({path:path.join(shots,`site-time-${theme}-page.png`)});
  }
  const file=path.join(root,'site-time.json');check(fs.statSync(file).mode%512===0o600,'persistent file is mode 0600');check(!fs.readFileSync(file,'utf8').includes('://'),'persistent data has no URLs');
  if(cua){
    for(const theme of ['light','dark'])for(const range of ['populated7day','empty','sidebar-hidden']){
      if(singleShot && (theme!=='light' || range!=='populated7day'))continue;
      await seed();
      await app.evaluate((_,{theme,range})=>{const m=global.olive,w=m.focusedWindow();process.mainModule.require('electron').nativeTheme.themeSource=theme;w.win.setSize(1360,880);w.sidebarHidden=range==='sidebar-hidden';w.setSidebarWidth(252);w.setOverlay(null);if(range==='empty')m.siteTime.tracker.reset();m.siteTime.show();w.win.show();w.win.focus();w.layout();},{theme,range});
      page=await renderer();for(const p of await app.windows())await p.emulateMedia({colorScheme:theme});await page.locator('#seg-week').click();await poll(async()=>range==='empty'?await page.locator('#time-empty').isVisible():await page.locator('.site-row').count()===4);await page.evaluate(()=>document.activeElement.blur());
      await cueShot(path.join(shots,`site-time-${theme}-${range}-full-window.png`),theme,range);
    }
    // Leave the actual native sheet open for a whole-window CUA capture. No OS automation.
    if(!singleShot){
    await seed();await app.evaluate(()=>{const m=global.olive,w=m.focusedWindow();process.mainModule.require('electron').nativeTheme.themeSource='light';w.sidebarHidden=false;w.layout();});for(const p of await app.windows())await p.emulateMedia({colorScheme:'light'});
    page=await renderer();await page.locator('#seg-week').click();await poll(async()=>await page.locator('.site-row').count()===4);
    await page.locator('#btn-reset').click();await wait(300);
    await cueShot(path.join(shots,'site-time-light-reset-sheet-full-window.png'),'light','reset-sheet');
    }
  }
  console.log(`${checks} site time native checks passed; temporary fixture only`);
} finally {clearOwnCue();if(app)await app.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
