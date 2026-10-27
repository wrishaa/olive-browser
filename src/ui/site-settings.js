const permissions = document.querySelector('#permissions');
const system = document.querySelector('#system');
const status = document.querySelector('#status');
const controls = new Map();
const osLabels = { microphone: 'Microphone', camera: 'Camera', screen: 'Screen recording' };
const statusLabels = { granted: 'Allowed', denied: 'Blocked', restricted: 'Restricted', 'not-determined': 'Not requested', 'not-applicable': 'Not applicable', unknown: 'Unknown' };
let pending = false;
function render(state) {
  if (!state) throw new Error('Site settings are unavailable for this page.');
  document.querySelector('#origin').textContent = state.origin;
  for (const item of state.permissions) {
    let select = controls.get(item.key);
    if (!select) {
      const row = document.createElement('div'); row.className = 'row';
      const label = document.createElement('label'); label.textContent = item.label;
      select = document.createElement('select'); select.id = `permission-${controls.size}`; label.htmlFor = select.id;
      for (const [value, text] of [['ask', 'Ask'], ['allow', 'Allow'], ['block', 'Block']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
      }
      select.addEventListener('change', async () => {
        pending = true; controls.forEach(control => { control.disabled = true; }); status.textContent = '';
        try { render(await window.siteSettings.set(item.key, select.value)); }
        catch { status.textContent = 'Could not save this change. Please try again.'; await refresh(false); }
        finally { pending = false; controls.forEach(control => { control.disabled = false; }); }
      });
      controls.set(item.key, select); row.append(label, select); permissions.append(row);
    }
    select.value = item.value;
  }
  const setup = state.screenSetup;
  document.querySelector('#screen-setup').hidden = !setup?.requested;
  if (setup?.requested) {
    document.querySelector('#app-path').textContent = setup.appPath || 'Run the installed Olive.app, not the Electron dev build.';
    document.querySelector('#screen-message').textContent = state.system.screen === 'granted'
      ? 'Screen access is enabled. Relaunch Olive to finish, then retry sharing.'
      : 'The website is allowed, but macOS must also allow Olive. This is a one-time system permission.';
  }
  system.replaceChildren();
  for (const [kind, labelText] of Object.entries(osLabels)) {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = labelText;
    const value = document.createElement('span'); value.className = 'os-status'; value.textContent = statusLabels[state.system[kind]] || 'Unknown';
    const button = document.createElement('button'); button.textContent = 'Open settings'; button.setAttribute('aria-label', `Open macOS ${labelText.toLowerCase()} settings`);
    button.disabled = state.system[kind] === 'not-applicable';
    button.onclick = async () => {
      button.disabled = true; status.textContent = '';
      try { if (kind === 'screen') showSystemWarning('screen'); else await window.siteSettings.system(kind); }
      catch { status.textContent = 'Could not open macOS settings.'; }
      finally { button.disabled = false; }
    };
    row.append(label, value, button); system.append(row);
  }
}
async function refresh(showError = true) {
  try { render(await window.siteSettings.get()); }
  catch { if (showError) status.textContent = 'Could not load site settings. Close this window and try again.'; }
}
window.addEventListener('focus', () => { if (!pending) refresh(); });
refresh();

let systemAction = null;
function showSystemWarning(action) {
  systemAction = action;
  document.querySelector('#warning-title').textContent = action === 'screen' ? 'Allow screen recording in macOS' : 'Relaunch Olive?';
  document.querySelector('#warning-copy').textContent = action === 'screen' ? 'macOS may ask for screen recording access. Enable Olive in System Settings, then return here. A relaunch may be needed; Olive will not restart without asking.' : 'Tabs and logins will be saved. Active calls and unsaved work in pages may be interrupted.';
  document.querySelector('#confirm-system').textContent = action === 'screen' ? 'Open System Settings' : 'Save and Relaunch';
  const warning = document.querySelector('#system-warning'); warning.hidden = false; warning.scrollIntoView({block:'nearest'}); document.querySelector('#cancel-system').focus();
}
document.querySelector('#cancel-system').onclick = () => { document.querySelector('#system-warning').hidden = true; systemAction = null; };
document.querySelector('#confirm-system').onclick = async () => {
  const action = systemAction; systemAction = null; document.querySelector('#system-warning').hidden = true;
  try { if (action === 'screen') render(await window.siteSettings.system('screen', true)); else if (action === 'relaunch') await window.siteSettings.relaunch(true); }
  catch { status.textContent = 'Could not complete this action. Please try again.'; }
};
document.querySelector('#screen-settings').onclick = () => showSystemWarning('screen');
document.querySelector('#relaunch').onclick = () => showSystemWarning('relaunch');
// Status-only polling: never request capture or collect thumbnails in the background.
setInterval(() => { if (!pending) refresh(false); }, 1500);
