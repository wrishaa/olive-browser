// Launches its OWN throwaway Electron process; never targets installed Olive or DJ.
import {_electron,chromium} from 'playwright-core';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import http from 'node:http';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'olive-native-profiles-'));
const shots=path.resolve('notes/test-shots');fs.mkdirSync(shots,{recursive:true});
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<title>Profile fixture</title><body>Local profile test only</body>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let app,browser;
// uBOL may restart once after load() resolves. Wait for its automatic recovery
// broadcast, not a delay or another enable command. A completed profile switch
// alone does not guarantee that the current extension generation has rules yet.
async function waitForBlocker() {
 const recovery=await app.evaluate(async()=>{
  const m=global.olive,x=m.extensions;
  const initial={...x.status,pending:x.context?.pending,liveHelper:x.helperContext===x.context};
  const events=[];
  const onReady=(_event,ext)=>events.push({event:'extension-ready',id:ext.id});
  const onUnload=(_event,ext)=>events.push({event:'extension-unloaded',id:ext.id});
  const ready=()=>x.status.installed&&x.status.enabled&&!x.context?.pending&&x.helperContext===x.context&&x.status.rulesets?.length===x.defaultRules?.length;
  if(ready())return {status:{...x.status}};
  const original=m.broadcast,ses=x.ses;
  ses.extensions.on('extension-ready',onReady);
  ses.extensions.on('extension-unloaded',onUnload);
  let timer;
  try {
   await new Promise((resolve,reject)=>{
    m.broadcast=function(...args){
     const result=original.apply(this,args);
     if(ready())resolve();
     else if(x.status.error)reject(new Error('Blocker recovery failed: '+JSON.stringify(x.status)));
     return result;
    };
    timer=setTimeout(()=>reject(new Error('Blocker recovery timed out: '+JSON.stringify({status:x.status,pending:x.context?.pending,liveHelper:x.helperContext===x.context}))),15000);
    if(ready())resolve();
   });
   return {status:{...x.status},initial,events,recovered:{...x.status,pending:x.context?.pending,liveHelper:x.helperContext===x.context}};
  } finally {clearTimeout(timer);m.broadcast=original;ses.extensions.removeListener('extension-ready',onReady);ses.extensions.removeListener('extension-unloaded',onUnload);}
 });
 if(recovery.initial)console.log('blocker startup recovery: '+JSON.stringify(recovery));
 return recovery.status;
}
try{
 app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:['.'],env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'native-profiles',OLIVE_CDP:'1',OLIVE_CDP_PORT:'19223',OLIVE_API_PORT:'19334'},timeout:30000});
 await app.evaluate(async()=>{while(!global.olive.ready||!global.olive.apiPort)await new Promise(r=>setTimeout(r,50));});
 const info=JSON.parse(fs.readFileSync(path.join(root,'agent.json'),'utf8'));assert.equal(info.apiPort,19334);
 browser=await chromium.connectOverCDP(info.cdp);
 // setup and profiles are tabs now: olive://onboarding/<step>, olive://profiles
 const page=async suffix=>{const match=u=>suffix==='/onboarding.html'?u.startsWith('olive://onboarding'):suffix==='/profiles.html'?/^olive:\/\/profiles\/?$/.test(u):u.endsWith(suffix);for(let i=0;i<100;i++){const p=browser.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed()&&match(p.url())).pop();if(p)return p;await new Promise(r=>setTimeout(r,50));}throw new Error('Missing page '+suffix);};
 let onboarding=await page('/onboarding.html');await onboarding.locator('#welcome-title').waitFor({state:'visible'});await onboarding.screenshot({path:path.join(shots,'onboarding-welcome-native.png')});
 assert.equal((await waitForBlocker()).enabled,true);
 await app.evaluate(()=>{const o=global.olive.onboarding;o.saved.step='screen';o.save();o.push();});await onboarding.locator('#screen-title').waitFor({state:'visible'});await onboarding.locator('#screen-footnote').waitFor({state:'visible'});assert.match(await onboarding.locator('#screen-footnote').innerText(),/System Settings/);await onboarding.screenshot({path:path.join(shots,'onboarding-screen-warning-native.png')});
 // Do not click Continue: OS calls require a person. Later preserves the exact saved step.
 {const old=onboarding;await app.evaluate(()=>global.olive.onboarding.command('later'));if(!old.isClosed())await old.waitForEvent('close',{timeout:5000}).catch(()=>{});}await app.evaluate(()=>global.olive.onboarding.show());onboarding=await page('/onboarding.html');await onboarding.locator('#screen-title').waitFor({state:'visible'});
 await app.evaluate(()=>global.olive.onboarding.close());
 await app.evaluate(async({app},{origin,root})=>{const m=global.olive;app.setPath('downloads',root);const w=m.focusedWindow();w.setOverlay(null);w.createTab({url:origin+'/default'});await m.session.cookies.set({url:origin,name:'fixture',value:'default-only'});m.perms.data[origin+'|notifications']=true;m.perms.flush();m.shortcuts.set('newTab','Cmd+Shift+K');m.history.add(origin+'/default','Default fixture');m.history.flush();m.ledger.record('visit',{url:origin+'/default?secret=not-kept'});m.ledger.flush();}, {origin,root});
 const id=await app.evaluate(async()=>{const m=global.olive,p=m.profiles.create('Isolated Work');await m.switchProfile(p.id);return p.id;});
 const second=await app.evaluate(async(_,{origin})=>{const m=global.olive;return {id:m.profileInfo.id,cookies:await m.session.cookies.get({url:origin}),permissions:m.perms.data,shortcut:m.shortcuts.accelerator('newTab'),history:m.history.search('default'),ledger:m.ledger.events,onboarding:m.onboarding.saved,blocking:{...m.extensions.status,pending:m.extensions.context?.pending,liveHelper:m.extensions.helperContext===m.extensions.context}};},{origin});
 if(!second.blocking.enabled)console.log('post-switch transient blocker state: '+JSON.stringify(second.blocking));
 const blocking=await waitForBlocker();
 assert.equal(second.id,id);assert.equal(second.cookies.length,0);assert.deepEqual(second.permissions,{});assert.equal(second.shortcut,'Cmd+T');assert.equal(second.history.length,0);assert.equal(second.ledger.some(e=>e.details.url?.includes('/default')),false);assert.equal(second.onboarding.step,'welcome');assert.equal(blocking.enabled,true);assert.equal(blocking.rulesets.length,6);
 await app.evaluate(async(_,{origin})=>{const m=global.olive;m.onboarding.close();m.focusedWindow().createTab({url:origin+'/work'});await m.session.cookies.set({url:origin,name:'fixture',value:'work-only'});m.perms.data[origin+'|notifications']=false;m.perms.flush();m.ledger.record('visit',{url:origin+'/work'});await m.switchProfile('default');},{origin});
 const first=await app.evaluate(async(_,{origin})=>{const m=global.olive;return {cookies:await m.session.cookies.get({url:origin}),permission:m.perms.data[origin+'|notifications'],shortcut:m.shortcuts.accelerator('newTab'),urls:m.allTabs().map(x=>x.tab.url),ledger:m.ledger.events,onboarding:m.onboarding.saved};},{origin});
 assert.equal(first.cookies[0].value,'default-only');assert.equal(first.permission,true);assert.equal(first.shortcut,'Cmd+Shift+K');assert(first.urls.includes(origin+'/default'));assert(!first.urls.includes(origin+'/work'));assert.equal(first.onboarding.step,'screen');assert.equal(first.ledger.some(e=>e.details.url?.includes('/work')),false);assert.equal(JSON.stringify(first.ledger).includes('not-kept'),false);
 // Native profiles settings is reachable from browser chrome, not a test-only component.
 await app.evaluate(()=>{const m=global.olive;m.onboarding.close();m.profileControls.show();});const profiles=await page('/profiles.html');await profiles.getByRole('heading',{name:'Profiles',exact:true}).waitFor();await profiles.screenshot({path:path.join(shots,'profiles-native.png')});
 const data=await profiles.evaluate(()=>window.oliveProfiles.get());assert.equal(data.profiles.length,2);
 const duplicate=await profiles.evaluate(()=>window.oliveProfiles.create('Isolated Work'));assert(duplicate.error);assert.equal(duplicate.profiles.length,2);
 const blocked=await app.evaluate(async()=>{const m=global.olive;m.downloads.push({state:'progressing'});try{await m.switchProfile(m.profiles.list().find(p=>p.id!=='default').id);return false;}catch{return true;}finally{m.downloads=[];}});assert.equal(blocked,true);
 assert.equal(fs.statSync(path.join(root,'activity.json')).mode&0o777,0o600);
 console.log('ok: native fresh onboarding, bundled blocker, warning/no auto prompts, later/resume; two profiles isolate cookies, tabs, permissions, history, shortcuts, activity and setup; switch restores default; duplicate/error and active-download guards; screenshots saved');
}finally{if(browser)await browser.close();if(app)await app.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
