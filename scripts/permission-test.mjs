// Real HTTPS permission APIs. Never opens the user's profile: run OLIVE_PROFILE=dev.
import assert from 'node:assert/strict';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function permissionTests({ api, browser, ui, check }) {
  const t = await api('/tabs', { url: 'https://permission.site/' });
  const pages = () => browser.contexts().flatMap(c => c.pages());
  let page;
  for(let i=0;i<50;i++) { page=pages().find(p=>p.url().startsWith('https://permission.site/')); if(page) break; await sleep(100); }
  assert(page, 'real permission.site loaded');
  await ui.evaluate(() => window.olive.cmd('resetPermissions'));
  await sleep(100);
  const request = async () => page.evaluate(() => {
    window.permissionResults = {};
    Notification.requestPermission().then(v => permissionResults.notification = v);
    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); permissionResults.mic = 'allowed'; }).catch(e => permissionResults.mic = e.name);
  });
  const toaster = async () => { for(let i=0;i<50;i++) { const p=pages().find(p=>p.url().endsWith('/permissions.html')); if(p && await p.locator('.card:not(.leaving)').count() >= 2) return p; await sleep(100); } throw new Error('two permission cards never appeared'); };
  await request(); const toast = await toaster();
  check(await toast.locator('.card:not(.leaving)').count() === 2, 'notification + microphone requests stack on real HTTPS page');
  check((await toast.locator('.origin').allTextContents()).every(o => o === 'https://permission.site'), 'permission cards display requesting origin');
  await sleep(1600);
  check(await toast.locator('.card:not(.leaving)').count() === 2, 'permissions stay pending without auto-dismiss');
  await page.evaluate(() => { window.inputCount=0; addEventListener('click',()=>inputCount++); });
  await page.mouse.click(700,250); await page.mouse.wheel(0,700); await sleep(200);
  check(await page.evaluate(()=>inputCount>0 && scrollY>0), 'page receives clicks and scroll while permissions are pending');
  const notification = toast.locator('.card').filter({ hasText: 'notifications' });
  await notification.getByRole('button', { name: 'Allow', exact:true }).click();
  await toast.locator('.card:not(.leaving)').filter({ hasText:'microphone' }).getByRole('button',{name:'Block',exact:true}).click();
  await sleep(400);
  check(await page.evaluate(()=>permissionResults.notification==='granted' && permissionResults.mic==='NotAllowedError'), 'allow and deny resolve real API callbacks');
  await page.reload(); await request(); await sleep(400);
  check(await page.evaluate(()=>permissionResults.notification==='granted' && permissionResults.mic==='NotAllowedError'), 'per-origin allow and deny remembered across reload');
  const remaining=await toast.locator('.card:not(.leaving)').allTextContents();
  check(remaining.length===0, `remembered decisions do not prompt again (${remaining.join('; ')})`);
  await ui.evaluate(() => window.olive.cmd('resetPermissions')); await sleep(100);
  await page.reload(); await request(); await toaster();
  await page.goto('https://example.com/'); await sleep(400);
  check(await toast.locator('.card:not(.leaving)').count()===0, 'navigation cancels all pending requests');
  await page.goto('https://permission.site/'); await request(); await toaster();
  await api(`/tabs/${t.id}/close`, {}); await sleep(400);
  check(await toast.locator('.card:not(.leaving)').count()===0, 'closing a tab cleanly denies pending callbacks');
}
