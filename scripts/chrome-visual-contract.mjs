// Disposable Electron fixture only. Does not attach to or restart installed Olive.
// Run: node scripts/chrome-visual-contract.mjs
// On macOS without desktopCapturer permission: --cua-shots pauses at each
// native capture for the authorized CUA viewer; all contracts remain automated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'olive-chrome-contract-'));
const shots=path.resolve('notes/test-shots');fs.mkdirSync(shots,{recursive:true});
fs.writeFileSync(path.join(root,'onboarding.json'),JSON.stringify({version:1,step:'done',completed:true}));
let app,ui;const results=[],failures=[];
const check=(ok,message,detail)=>{const row={ok,message,...(detail===undefined?{}:{detail})};results.push(row);if(!ok){failures.push(row);console.error('FAIL:',message,JSON.stringify(detail));}else console.log('ok:',message);};
const poll=async(fn,label)=>{for(let n=0;n<100;n++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw new Error('timeout: '+label);};
const fixtureTitle='Olive visual contract synthetic fixture';
async function renderer(name){return poll(async()=>(await app.windows()).find(p=>p.url().endsWith('/ui/'+name+'.html')||p.url().includes('/ui/'+name+'.html?')),name+' renderer');}
async function settle(){await ui.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await new Promise(r=>setTimeout(r,120));}
async function chromeMetrics(){
  return ui.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return r.width>0&&r.height>0&&s.visibility!=='hidden'&&Number(s.opacity)>0&&!e.closest('[hidden]');};
    const debug=[];for(const e of document.querySelectorAll('body *')){if(!visible(e))continue;const text=[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim();if(/\b(?:api|cdp)\s*(?:[:=]|\d)|\b(?:apiPort|cdpPort|OLIVE_PROFILE|DEBUG|agent-token)\b|\b(?:localhost|127\.0\.0\.1):\d+|\bports?\s*[:=]\s*\d+/i.test(text))debug.push({id:e.id,text});}
    const sidebar=document.querySelector('#sidebar'),footer=document.querySelector('.footer'),sr=rect(sidebar),fr=rect(footer),clipped=[],buttons=[];
    for(const e of footer.querySelectorAll('button')){
      const r=rect(e),entry={id:e.id,rect:r,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};buttons.push(entry);
      if(!visible(e)||r.width<=0||r.height<=0||r.x<sr.x-.5||r.right>sr.right+.5||r.y<fr.y-.5||r.bottom>Math.min(fr.bottom,innerHeight)+.5||r.x<0||r.right>innerWidth||e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1)clipped.push(entry);
      const svg=e.querySelector('svg');if(svg){const v=rect(svg);if(v.x<r.x-.5||v.right>r.right+.5||v.y<r.y-.5||v.bottom>r.bottom+.5)clipped.push({id:e.id,svg:v,button:r});}
    }
    for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i].rect,b=buttons[j].rect;if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.5)clipped.push({overlap:[buttons[i].id,buttons[j].id]});}
    if(footer.scrollWidth>footer.clientWidth+1||footer.scrollHeight>footer.clientHeight+1)clipped.push({footerOverflow:true,scrollWidth:footer.scrollWidth,clientWidth:footer.clientWidth});
    const e=document.querySelector('#btn-ublock'),s=getComputedStyle(e),r=rect(e);let opacity=1;for(let p=e;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);
    // Let the browser resolve every supported CSS color format, including alpha.
    const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=s.color;x.fillRect(0,0,1,1);const foreground=[...x.getImageData(0,0,1,1).data];foreground[3]=foreground[3]/255*opacity;
    return {debug,clipped,buttons,sidebar:sr,footer:fr,ublock:{rect:r,foreground,color:s.color,background:s.backgroundColor,opacity},viewport:{width:innerWidth,height:innerHeight},pageOverflow:document.documentElement.scrollWidth>innerWidth+1};
  });
}
async function contrast(metric){
  // Capture padding pixels, not glyphs. Chromium resolves CSS alpha backgrounds,
  // gradients and inherited colors; composite remaining screenshot alpha against
  // BOTH black and white so translucent vibrancy never yields a false pass.
  return app.evaluate(async(_,m)=>{
    const w=global.olive.focusedWindow(),img=await w.ui.webContents.capturePage(),size=img.getSize(),buf=img.toBitmap(),bounds=w.ui.getBounds();
    const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const ratios=[],samples=[];for(const pos of [[3,3],[3,m.rect.height/2],[m.rect.width-4,m.rect.height/2],[m.rect.width/2,m.rect.height-3]]){
      const x=Math.min(size.width-1,Math.round((m.rect.x+pos[0])*size.width/bounds.width)),y=Math.min(size.height-1,Math.round((m.rect.y+pos[1])*size.height/bounds.height)),i=(y*size.width+x)*4;
      const rgba=[buf[i+2],buf[i+1],buf[i],buf[i+3]/255];samples.push(rgba);
      for(const base of [0,255]){const bg=rgba.slice(0,3).map(v=>v*rgba[3]+base*(1-rgba[3])),fg=m.foreground.slice(0,3).map((v,i)=>v*m.foreground[3]+bg[i]*(1-m.foreground[3]));ratios.push((Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05));}
    }return {minimum:Math.min(...ratios),maximum:Math.max(...ratios),samples,color:m.color,background:m.background,opacity:m.opacity};
  },metric.ublock);
}
async function structure(){return app.evaluate(({BaseWindow})=>{
  const w=global.olive.focusedWindow(),p=w.appPanel,{width,height}=w.win.getContentBounds(),x=w.sidebarHidden?8:w.sidebarWidth;
  return {windows:BaseWindow.getAllWindows().map(v=>v.id).sort(),visible:BaseWindow.getAllWindows().filter(v=>v.isVisible()).map(v=>v.id).sort(),inline:!!p&&w.inlinePage===p&&p.owner===w,hasShell:!!p?.shell,attached:!!p&&w.win.contentView.children.includes(p.content),bounds:p?.content.getBounds(),expected:{x,y:8,width:Math.max(100,width-x-8),height:Math.max(100,height-16)},pane:w.panes[0]?.rect,webVisible:[...w.tabs.values()].some(t=>t.view?.getVisible())};
});}
async function settingsContract(label){
  const before=await structure();await ui.evaluate(()=>olive.cmd('shortcuts'));const page=await renderer('shortcuts');await page.emulateMedia({colorScheme:label.split('/')[0]});await page.locator('#mruNext').waitFor();await settle();
  const after=await structure();check(JSON.stringify(before.windows)===JSON.stringify(after.windows)&&JSON.stringify(before.visible)===JSON.stringify(after.visible),label+': settings opens no extra native window',{before,after});
  check(after.inline&&after.attached&&!after.hasShell&&!after.webVisible&&JSON.stringify(after.bounds)===JSON.stringify(after.expected)&&JSON.stringify(after.bounds)===JSON.stringify(after.pane),label+': app page exact pane bounds, no shell or visible web tab',after);
  try { await page.keyboard.press('Escape'); } catch (error) { if (!page.isClosed()) throw error; }
  await poll(()=>page.isClosed(),'Escape removes settings page');await settle();
}
async function fullWindowShot(filename){
  if(process.argv.includes('--cua-shots')){
    const file=path.join(shots,filename),cue=path.join(shots,'chrome-visual-shot-request.json');
    fs.rmSync(file,{force:true});
    await app.evaluate((_,title)=>{const w=global.olive.focusedWindow();w.win.setTitle(title);w.win.show();w.win.focus();},fixtureTitle);
    fs.writeFileSync(cue,JSON.stringify({file,title:fixtureTitle,pid:app.process().pid,appPath:path.join(root,'Olive Visual Contract.app')}));
    console.log('CUA_SHOT_REQUEST:',cue);
    for(let n=0;n<1800;n++){if(fs.existsSync(file)){
      // CUA can return JPEG bytes even when the requested destination is PNG.
      // Normalize the saved artifact, without re-capturing or changing pixels.
      execFileSync('/usr/bin/sips',['-s','format','png',file,'--out',file]);
      assert.equal(fs.readFileSync(file).subarray(1,4).toString(),'PNG');
      fs.rmSync(cue,{force:true});console.log('saved native CUA window:',filename);return;}await new Promise(r=>setTimeout(r,100));}
    throw new Error('CUA native screenshot timeout: '+filename);
  }
  // The default run is metrics-only and must never request screen-recording
  // permission. Whole-window artifacts are refreshed only by the explicit
  // --cua-shots path above; renderer captures are not visual acceptance.
  console.log('metrics only; use --cua-shots to refresh full-window artifact:',filename);
}
try{
  let executablePath=path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if(process.argv.includes('--cua-shots')){
    // A private clone gives CUA an unambiguous bundle target when another
    // development Electron process is running. Never edit the installed app.
    const clone=path.join(root,'Olive Visual Contract.app');
    execFileSync('/bin/cp',['-cR',path.resolve('node_modules/electron/dist/Electron.app'),clone]);
    const plist=path.join(clone,'Contents/Info.plist');
    execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier com.reframe.olive.chrome-visual-contract',plist]);
    execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Olive Visual Contract',plist]);
    executablePath=path.join(clone,'Contents/MacOS/Electron');
  }
  app=await _electron.launch({executablePath,args:['.'],env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'chrome-visual-contract',OLIVE_CDP:'1',OLIVE_CDP_PORT:'0',OLIVE_API_PORT:'0'},timeout:30000});
  await app.evaluate(async()=>{while(!global.olive?.ready||!global.olive.apiPort)await new Promise(r=>setTimeout(r,50));global.olive.onboarding.close();
    // The uBO sidebar button is hidden by default; opt in so its contrast contract still runs.
    if(global.olive.extensions?.status.installed)global.olive.extensions.setShowInToolbar(true);});
  ui=await renderer('index');
  const synthetic='data:text/html,'+encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Reading room</title><style>:root{color-scheme:light dark}body{margin:0;background:light-dark(#fafbf8,#202522);color:light-dark(#26332a,#e4ece4);font:17px/1.65 system-ui}main{max-width:660px;margin:100px auto;padding:40px}small{letter-spacing:.16em;color:light-dark(#526b49,#b4ceab)}h1{font-size:42px;line-height:1.15;letter-spacing:-1.5px}p{max-width:570px}hr{border:0;border-top:1px solid light-dark(#dce4d7,#3c483f);margin:32px 0}</style><main><small>OLIVE / READING ROOM</small><h1>A quieter place to browse.</h1><p>A synthetic page for checking browser chrome. No browsing history, account details, or private content.</p><hr><p>Keep the useful things close. Leave a little room to think.</p></main>`);
  await app.evaluate(async(_,url)=>{const m=global.olive,w=m.focusedWindow();for(const t of [...w.tabs.values()])w.closeTab(t.id,{force:true});const t=w.createTab({url,activate:true});w.setOverlay(null);w.win.setTitle('Olive visual contract synthetic fixture');await new Promise(r=>t.wc.once('did-finish-load',r));},synthetic);
  for(const theme of ['light','dark']){
    await app.evaluate(({nativeTheme},theme)=>{nativeTheme.themeSource=theme;},theme);
    // Playwright's default browser context forces light media independently of
    // nativeTheme. Override both chrome and the synthetic web renderer.
    for(const page of await app.windows())await page.emulateMedia({colorScheme:theme});
    for(const [width,height] of [[1280,800],[1360,880]])for(const sidebar of [252,180]){
      const label=`${theme}/${width}x${height}/sidebar-${sidebar}`;
      await app.evaluate((_,{width,height,sidebar})=>{const w=global.olive.focusedWindow();w.win.setSize(width,height);w.setSidebarWidth(sidebar);w.win.show();w.win.focus();w.setOverlay(null);w.layout();w.sendState();},{width,height,sidebar});await settle();
      check(await ui.evaluate(theme=>matchMedia('(prefers-color-scheme: dark)').matches===(theme==='dark'),theme),label+': renderer is actually using '+theme+' media');
      const metric=await chromeMetrics();check(metric.debug.length===0,label+': no visible API/CDP/port/debug text',metric.debug);check(metric.clipped.length===0&&!metric.pageOverflow,label+': footer buttons including <> devtools are unclipped',metric.clipped);
      const ratio=await contrast(metric);check(ratio.minimum>=4.5,label+': uBO foreground/background contrast >=4.5 with alpha',ratio);
      await settingsContract(label);
      if(width===1360&&sidebar===252)await fullWindowShot(`main-${theme}-after.png`);
    }
  }
} catch(error){failures.push({ok:false,message:'fixture/test exception',detail:String(error.stack||error)});console.error(error);}
finally{
  fs.writeFileSync(path.join(shots,'chrome-visual-contract.json'),JSON.stringify({results,failures},null,2));
  if(app)await app.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});
}
console.log(`${results.length-failures.filter(f=>f.message!=='fixture/test exception').length}/${results.length} visual contracts passed; ${failures.length} failures`);
if(failures.length)process.exitCode=1;
