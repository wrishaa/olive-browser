// Safe installed-app cache diagnosis: unique synthetic URLs, no cache/cookie clearing.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
const profile = process.env.OLIVE_PROFILE ? `Olive-${process.env.OLIVE_PROFILE}` : 'Olive';
const dir = `${os.homedir()}/Library/Application Support/${profile}`;
const info = JSON.parse(fs.readFileSync(`${dir}/agent.json`));
const token = fs.readFileSync(`${dir}/agent-token`, 'utf8').trim();
const base = info.api || `http://127.0.0.1:${info.apiPort || 9333}`;
async function api(route, body) {
 const res = await fetch(base + route, {method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
 const data=await res.json();if(!res.ok)throw new Error(data.error);return data;
}
const counts={};const run=Date.now();
const server=http.createServer((req,res)=>{
 if(req.url.startsWith(`/${run}/`)) counts[req.url]=(counts[req.url]||0)+1;
 const page=req.url.includes('/page');
 const data=page ? `<html><head><script src="/${run}/asset.js"></script><link rel="stylesheet" href="/${run}/asset.css"></head><body>olive cache probe</body></html>` : req.url.endsWith('.js') ? '/*'+ 'x'.repeat(512*1024)+'*/' : '/*'+'x'.repeat(512*1024)+'*/';
 setTimeout(()=>{res.writeHead(200,{'Cache-Control':'public, max-age=3600','Content-Type':page?'text/html':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(data);},150);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/${run}/page`;
const timing=`(()=>{const n=performance.getEntriesByType('navigation')[0];const r=performance.getEntriesByType('resource').filter(x=>['script','link'].includes(x.initiatorType));return {ttfbMs:Math.round(n.responseStart-n.requestStart),domMs:Math.round(n.domContentLoadedEventEnd),loadMs:Math.round(n.loadEventEnd),bytes:n.transferSize+r.reduce((s,x)=>s+x.transferSize,0),cachedAssets:r.filter(x=>x.transferSize===0&&x.decodedBodySize>0).length,resources:r.length};})()`;
let tab;
try {
 tab=await api('/tabs',{url});
 const cold=(await api(`/tabs/${tab.id}/eval`,{expression:timing})).result;
 const first=Object.values(counts).reduce((a,b)=>a+b,0);
 await api(`/tabs/${tab.id}/navigate`,{url:'about:blank'});
 await api(`/tabs/${tab.id}/navigate`,{url});
 const warm=(await api(`/tabs/${tab.id}/eval`,{expression:timing})).result;
 const second=Object.values(counts).reduce((a,b)=>a+b,0);
 console.log(JSON.stringify({fixture:{cold,warm,coldRequests:first,warmExtraRequests:second-first}},null,2));
 assert.equal(warm.cachedAssets,2);assert.equal(second,first,'warm navigation must not hit server');
 await api(`/tabs/${tab.id}/reload`,{});
 console.log(JSON.stringify({normalReload:(await api(`/tabs/${tab.id}/eval`,{expression:timing})).result,serverRequests:Object.values(counts).reduce((a,b)=>a+b,0)},null,2));
 if(process.argv.includes('--public')) {
  const out=[];
  for(let i=0;i<2;i++) {
   await api(`/tabs/${tab.id}/navigate`,{url:'https://en.wikipedia.org/wiki/Olive',timeout:15000});
   out.push((await api(`/tabs/${tab.id}/eval`,{expression:`(()=>{const n=performance.getEntriesByType('navigation')[0];const r=performance.getEntriesByType('resource');return {ttfbMs:Math.round(n.responseStart-n.requestStart),responseEndMs:Math.round(n.responseEnd),domMs:Math.round(n.domContentLoadedEventEnd),loadMs:Math.round(n.loadEventEnd),resources:r.length,cached:r.filter(x=>x.transferSize===0&&x.decodedBodySize>0).length,scriptMs:Math.round(n.domContentLoadedEventStart-n.responseEnd),navBytes:n.transferSize};})()`})).result);
   await api(`/tabs/${tab.id}/navigate`,{url:'about:blank'});
  }
  console.log(JSON.stringify({wikipedia:out},null,2));
 }
}finally{if(tab)await api(`/tabs/${tab.id}/close`,{}).catch(()=>{});server.close();}
