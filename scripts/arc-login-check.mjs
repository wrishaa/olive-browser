// Checks account UI only; never reads/prints cookies, account names, or passwords.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const profile = process.env.OLIVE_PROFILE ? `Olive-${process.env.OLIVE_PROFILE}` : 'Olive';
const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support', profile, 'agent.json'), 'utf8'));
const token = fs.readFileSync(info.tokenFile, 'utf8').trim();
async function api(route, body) {
  const res = await fetch(info.api + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`agent request failed: ${res.status}`);
  return res.json();
}
const checks = [
  ['github', 'https://github.com/', `({signedIn: !!document.querySelector('meta[name="user-login"]')?.content || document.body.classList.contains('logged-in'), signIn: !!document.querySelector('a[href="/login"]')})`],
  ['google', 'https://www.google.com/', `({signedIn: !!document.querySelector('a[href*="SignOutOptions"],a[aria-label^="Google Account"],a[aria-label^="Google account"]'), signIn: !!document.querySelector('a[href*="ServiceLogin"]')})`],
  ['x', 'https://x.com/home', `({signedIn: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="AppTabBar_Profile_Link"]'), signIn: location.pathname.includes('/flow/login') || !!document.querySelector('[data-testid="loginButton"]')})`],
];
for (const [site, url, expression] of checks) {
  const tab = await api('/tabs', { url, background: false });
  let state = {};
  for (let n = 0; n < 12; n++) {
    state = (await api(`/tabs/${tab.id}/eval`, { expression })).result || {};
    if (state.signedIn || state.signIn) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log(JSON.stringify({ site, tab: tab.id, status: state.signedIn ? 'logged in' : state.signIn ? 'sign-in required' : 'unconfirmed' }));
}
