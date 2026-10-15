// Native DNR + real CNN requests. Dev profile only; no auth/cookie access.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
assert.equal(process.env.OLIVE_PROFILE, 'dev', 'run in the dev profile');
const info=JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/Olive-dev/agent.json')));
const token=fs.readFileSync(info.tokenFile,'utf8').trim();
const api=async(p,method='GET',data)=>{const r=await fetch(info.api+p,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return r.json()};
const b=await chromium.connectOverCDP(info.cdp);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pages=()=>b.contexts().flatMap(c=>c.pages());
const ui=pages().find(p=>p.url().includes('/ui/index.html'));
let tab,control;
try {
  await ui.evaluate(async()=>{if((await olive.invoke('state')).sidebarHidden)olive.cmd('toggleSidebar')});
  await ui.locator('#btn-ublock').click();
  for(let i=0;i<30;i++){control=pages().find(p=>p.url().endsWith('/ui/extension.html'));if(control)break;await sleep(100)}
  assert(control,'toolbar opens controls');
  await control.locator('#status').filter({hasText:'Blocking on'}).waitFor();
  assert.match(await control.locator('#gap').innerText(),/not working/);
  await control.locator('#toggle').click();
  await control.locator('#status').filter({hasText:'Blocking off'}).waitFor();
  console.log('ok toolbar, popup, honest compatibility warning, native rule disable');
  tab=await api('/tabs','POST',{url:'about:blank'});
  let page;
  for(let i=0;i<30;i++){
    for(const p of pages())if(p.url()==='about:blank'){
      const c=await p.context().newCDPSession(p);const t=await c.send('Target.getTargetInfo');await c.detach();if(t.targetInfo.targetId===tab.targetId)page=p;
    }
    if(page)break;await sleep(100);
  }
  assert(page,'test news tab found');
  const c=await page.context().newCDPSession(page);
  await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});
  const results=[];
  for(const enabled of [false,true]){
    if(enabled){await control.locator('#toggle').click();await control.locator('#status').filter({hasText:'Blocking on'}).waitFor()}
    let requests=new Map(),blocked=[];
    const listener=(p)=>requests.set(p.requestId,p.request.url);
    const failed=(p)=>{if(p.errorText==='net::ERR_BLOCKED_BY_CLIENT'){const u=requests.get(p.requestId);if(u)blocked.push(new URL(u).hostname)}};
    c.on('Network.requestWillBeSent',listener);c.on('Network.loadingFailed',failed);
    await page.goto('https://www.cnn.com/',{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
    await sleep(10000);
    assert.match(await page.title(),/CNN/i,'real news document');
    c.off('Network.requestWillBeSent',listener);c.off('Network.loadingFailed',failed);
    const row={enabled,requests:requests.size,blocked:blocked.length,blockedHosts:[...new Set(blocked)]};results.push(row);console.log(JSON.stringify(row));
    await page.goto('about:blank',{timeout:10000});
  }
  assert.equal(results[0].blocked,0,'no extension filtering when off');
  assert(results[1].blocked>0,'DNR blocks real CNN requests');
  assert(results[1].blockedHosts.some(h=>/rubiconproject|adsafeprotected|stickyadstv|imasdk|doubleclick|amazon-adsystem|googlesyndication/.test(h)),'real ad/auction requests blocked, not only analytics');
  console.log('ok native ad blocking on CNN; no simulated APIs or patched package');
  await control.locator('#original').click();await sleep(700);
  assert(pages().some(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('/popup.html')),'official popup opens');
  console.log('ok official popup resource opens; full controls remain unsupported');
} finally {
  if(control&&!control.isClosed()){
    if((await control.locator('#status').innerText()).includes('off'))await control.locator('#toggle').click();
    await control.close();
  }
  if(tab)await api(`/tabs/${tab.id}/close`,'POST');
  await b.close();
}
