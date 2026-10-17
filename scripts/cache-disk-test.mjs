// Electron restart/cache check in a brand-new temporary profile. Never opens user data.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const electron=require('electron');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'olive-cache-probe-'));
const script=path.join(dir,'probe.cjs');
fs.writeFileSync(script,`
const {app,session,BrowserWindow}=require('electron');
app.setPath('userData',process.env.CACHE_PROBE_DIR);
app.whenReady().then(async()=>{
 const ses=session.fromPartition('persist:olive');
 const win=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true}});
 await win.loadURL(process.env.CACHE_PROBE_URL);
 console.log(JSON.stringify({persistent:ses.isPersistent(),cacheBytes:await ses.getCacheSize(),timing:await win.webContents.executeJavaScript(\`(()=>{const n=performance.getEntriesByType('navigation')[0];const r=performance.getEntriesByType('resource');return {loadMs:Math.round(n.loadEventEnd),bytes:n.transferSize+r.reduce((s,x)=>s+x.transferSize,0),cached:r.filter(x=>x.transferSize===0&&x.decodedBodySize>0).length}})()\`)}));
 setTimeout(()=>app.quit(),500);
}).catch(e=>{console.error(e);app.exit(1)});
`);
let requests=0;
const server=http.createServer((req,res)=>{
 if(req.url!=='/'&&req.url!=='/asset.js'){res.writeHead(404);res.end();return;}
 requests++;
 const page=req.url==='/';
 setTimeout(()=>{res.writeHead(200,{'Cache-Control':'public, max-age=3600','Content-Type':page?'text/html':'text/javascript'});res.end(page?'<script src="/asset.js"></script><body>disk cache test</body>':'/*'+'x'.repeat(512*1024)+'*/');},150);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 for(let i=0;i<2;i++) {
  const before=requests;
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(electron,[script],{env:{...process.env,CACHE_PROBE_DIR:path.join(dir,'profile'),CACHE_PROBE_URL:`http://127.0.0.1:${server.address().port}/`},stdio:['ignore','pipe','pipe']});
   let out='',err='';
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('cache probe timed out'));},20000);
   child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
   child.on('error',e=>{clearTimeout(timer);reject(e)});
   child.on('exit',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(err||`exit ${code}`));try{resolve(JSON.parse(out.trim()))}catch(e){reject(e)}});
  });
  console.log(JSON.stringify({run:i+1,newRequests:requests-before,...result}));
  assert(result.persistent);
  if(i===1){assert.equal(requests-before,0);assert.equal(result.timing.bytes,0);assert.equal(result.timing.cached,1);}
 }
} finally {server.close();fs.rmSync(dir,{recursive:true,force:true});}
