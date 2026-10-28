// Isolated fixture only; no installed app, user profile or OS input.
import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'olive-omnibar-commands-'));
fs.writeFileSync(path.join(root,'onboarding.json'),JSON.stringify({version:1,completed:true,step:'done'}));
let app; let checks=0;
const check=(ok,label)=>{assert.ok(ok,label);console.log('ok:',label);checks++;};
try {
  app=await _electron.launch({args:['.'],env:{...process.env,OLIVE_USER_DATA_DIR:root,OLIVE_PROFILE:'omnibar-commands-fixture',OLIVE_API_PORT:'0',OLIVE_CDP:'0'}});
  await app.evaluate(async()=>{while(!global.olive?.ready)await new Promise(r=>setTimeout(r,25));global.olive.onboarding.close();});
  let ui;
  for(let i=0;i<100;i++){ui=(await app.windows()).find(p=>p.url().includes('/ui/index.html'));if(ui)break;await new Promise(r=>setTimeout(r,30));}
  assert.ok(ui,'browser chrome loaded');
  await ui.waitForFunction(()=>window.olive && document.querySelector('#palette-input'));
  const baseline=await app.evaluate(()=>global.olive.focusedWindow().tabs.size);
  for(const [word,pageName] of [['shortcuts','shortcuts'],['settings','shortcuts'],['activities','site-time']]){
    await app.evaluate(()=>global.olive.focusedWindow().cmd('openLocation'));
    await ui.locator('#palette-input').fill(word);
    await ui.locator('.sug').first().filter({hasText:word==='activities'?'Site Time':'Keyboard Shortcuts'}).waitFor();
    check(await ui.locator('.sug').first().getAttribute('class').then(v=>v.includes('sel')),word+' command is selected before web search');
    await ui.locator('#palette-input').press('Enter');
    let dest;
    for(let i=0;i<100;i++){dest=(await app.windows()).find(p=>p.url().includes('/ui/'+pageName+'.html'));if(dest)break;await new Promise(r=>setTimeout(r,30));}
    check(!!dest,word+' opens inline '+pageName);
    check(await app.evaluate(()=>global.olive.focusedWindow().tabs.size)===baseline,word+' does not navigate/create a web tab');
    check(await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows().filter(w=>w.isVisible()).length)===1,word+' creates no popup window');
  }
  const menu=await app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.map(x=>x.label));
  check(menu.some(x=>x.includes('Site Time')),'activities reachable from native menu');
  console.log('omnibar native checks:',checks);
}finally{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});}
