const $ = id => document.getElementById(id);
const steps = ['welcome', 'calls', 'screen', 'import', 'done'];
const labels = { granted: 'Allowed', denied: 'Not allowed', restricted: 'Not allowed', 'not-determined': 'Not requested', 'not-applicable': 'Not needed', unknown: 'Not requested' };
let state, pending = false, discovering = false, discovered = false, callsRequested = false, sourceKey = '';
const selectedProfiles = new Set();
const browserSymbol = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M6 6.5h1m2 0h1"/></svg>';
function selections() {
  return (state?.browsers || []).flatMap(browser => browser.profiles.filter(profile => selectedProfiles.has(profile.id) && profile.available?.cookies !== false).map(profile => ({ browserId: browser.id, profileId: profile.id, cookies: true })));
}
function callsAnswered() { return callsRequested || state?.callsRequested || ['microphone', 'camera'].every(kind => ['granted', 'denied', 'restricted', 'not-applicable'].includes(state?.system[kind])); }
function controls() {
  if (!state) return;
  const step = state.step;
  $('back').hidden = !['calls', 'screen', 'import'].includes(step);
  $('later').hidden = step === 'done';
  $('later').textContent = step === 'welcome' ? 'Set Up Later' : 'Skip';
  $('next').textContent = step === 'done' ? 'Start Browsing' : step === 'screen' && state.screenRequested ? 'Quit and Reopen Olive…' : step === 'import' && !state.result && !isEmptyImport() ? 'Import' : 'Continue';
  $('next').disabled = pending || !!state.busy || (step === 'import' && !state.result && (!discovered || (!isEmptyImport() && !selections().length)));
  $('later').disabled = pending || !!state.busy;
  $('back').disabled = pending || !!state.busy;
  document.querySelectorAll('#sources input').forEach(input => { input.disabled = pending || !!state.busy || !!state.result; });
}
function isEmptyImport() { return discovered && !(state?.browsers || []).some(b => b.profiles.some(p => p.available?.cookies !== false)); }
function renderSources() {
  const browsers = state.browsers || [];
  const key = JSON.stringify([browsers, state.result, discovering, discovered, state.busy]);
  if (key === sourceKey) return;
  sourceKey = key;
  $('sources').replaceChildren();
  if (discovering || !discovered) {
    const row = document.createElement('div'); row.className = 'source-row';
    row.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="source-title">Looking for browsers…</span>'; $('sources').append(row); return;
  }
  let count = 0;
  for (const browser of browsers) for (const profile of browser.profiles) {
    if (profile.available?.cookies === false) continue;
    count++;
    const row = document.createElement('label'); row.className = 'source-row'; row.innerHTML = browserSymbol;
    const title = document.createElement('span'); title.className = 'source-title'; title.append(document.createTextNode(browser.name));
    const detail = document.createElement('span'); detail.className = 'source-detail'; detail.textContent = profile.name; title.append(detail); row.append(title);
    const result = state.result?.profiles?.find(p => p.id === profile.id);
    if (result) {
      const value = document.createElement('span'); value.className = 'source-result';
      value.textContent = result.error ? (/Safe Storage|Keychain/i.test(result.error) ? 'Skipped (Keychain)' : 'Needs sign-in') : `${result.imported || 0} cookies`;
      row.append(value);
    } else if ((pending || state.busy) && selectedProfiles.has(profile.id)) {
      const spinner = document.createElement('span'); spinner.className = 'spinner'; spinner.setAttribute('aria-label', 'Importing'); row.append(spinner);
    } else {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedProfiles.has(profile.id); input.setAttribute('aria-label', `${browser.name} · ${profile.name}`);
      input.onchange = () => { if (input.checked) selectedProfiles.add(profile.id); else selectedProfiles.delete(profile.id); controls(); }; row.append(input);
    }
    $('sources').append(row);
  }
  if (!count) { const empty = document.createElement('div'); empty.className = 'source-row empty-source'; empty.innerHTML = browserSymbol; const text = document.createElement('span'); text.textContent = 'No Chrome, Brave, Edge or Arc profiles found.'; empty.append(text); $('sources').append(empty); }
}
function render(nextState) {
  if (!nextState) return;
  const previousStep = state?.step;
  state = nextState;
  for (const step of steps) $(step).hidden = step !== state.step;
  const index = steps.indexOf(state.step);
  $('steps').setAttribute('aria-label', `Step ${index + 1} of 5`);
  document.querySelectorAll('.dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
  for (const [id, kind] of [['mic', 'microphone'], ['camera', 'camera']]) {
    const status = state.system[kind];
    $(id + '-status').textContent = labels[status] || 'Not requested';
    $(id + '-status').classList.toggle('granted', status === 'granted');
    $(id + '-status').hidden = ['denied', 'restricted'].includes(status);
    $(id + '-settings').hidden = !['denied', 'restricted'].includes(status);
  }
  $('screen-status').textContent = state.system.screen === 'granted' ? 'Allowed' : state.screenRequested ? 'Waiting for System Settings…' : 'Not allowed';
  $('screen-footnote').textContent = state.screenRequested ? 'When Olive is turned on in System Settings, quit and reopen. Setup continues at Import.' : 'Next, macOS opens System Settings. Turn on Olive under Screen & System Audio Recording, then come back here. Olive has to quit and reopen once.';
  const blockerOn = state.blocker?.installed && state.blocker?.enabled;
  $('blocker-label').textContent = blockerOn ? 'Ads are blocked by default' : state.blocker?.error ? 'Ad blocking isn’t on' : 'Ad blocking';
  $('blocker-description').textContent = blockerOn ? 'uBO Lite basic network blocking is on. Cosmetic filtering and per-site modes aren’t supported yet; turn blocking off from the shield button.' : state.blocker?.error ? 'uBO Lite couldn’t load its rules. Try again from the shield button.' : state.blocker?.installed ? 'uBO Lite is turned off in this profile. Turn it on from the shield button.' : 'uBO Lite basic network blocking is starting. Check its status from the shield button.';
  $('summary-calls').textContent = ['microphone', 'camera'].every(k => state.system[k] === 'granted') ? 'Allowed' : callsAnswered() ? 'Not allowed' : 'Skipped';
  $('summary-screen').textContent = state.system.screen === 'granted' ? 'Allowed' : state.screenRequested ? 'Waiting for System Settings' : 'Skipped';
  $('summary-import').textContent = state.result ? `${state.result.profiles?.length || 0} profiles, ${state.result.imported || 0} cookies` : state.imported ? 'Imported' : 'Skipped';
  $('summary-blocker').textContent = blockerOn ? 'uBO Lite basic, on' : 'Off';
  $('progress').textContent = state.progress || '';
  $('import-result').textContent = state.result ? `${state.result.imported || 0} cookies copied. ${state.result.existing || 0} existing cookies kept.` : '';
  renderSources(); controls();
  if (previousStep && previousStep !== state.step) $(state.step + '-title').focus({ preventScroll: true });
  if (state.step === 'import' && !discovered && !discovering && !pending) discover();
}
async function discover() {
  if (discovering) return;
  discovering = true; renderSources(); controls();
  try { const nextState = await window.oliveSetup.command('discover'); discovered = true; render(nextState); }
  catch (error) { discovered = true; $('error').textContent = error.message || 'Couldn’t find browser profiles. You can skip this step.'; }
  finally { discovering = false; sourceKey = ''; renderSources(); controls(); }
}
async function command(action, payload = {}) {
  if (pending || discovering) return;
  pending = true; $('error').textContent = ''; controls();
  if (action === 'import') { sourceKey = ''; renderSources(); }
  try {
    const nextState = await window.oliveSetup.command(action, payload);
    if (action === 'calls') callsRequested = true;
    render(nextState);
  } catch (error) { $('error').textContent = error.message || 'Something went wrong. Try again, or skip this step.'; }
  finally { pending = false; sourceKey = ''; renderSources(); controls(); if (state?.step === 'import' && !discovered && !discovering) discover(); }
}
function continueSetup() {
  if (!state || $('next').disabled) return;
  if (state.step === 'done') return command('finish');
  if (state.step === 'calls' && !callsAnswered()) return command('calls', { confirmed: true });
  if (state.step === 'screen') return state.screenRequested ? command('relaunch') : state.system.screen === 'granted' ? command('next') : command('screen', { confirmed: true });
  if (state.step === 'import' && !state.result && selections().length) return command('import', { selections: selections(), keychainConfirmed: true });
  return command('next');
}
$('next').onclick = continueSetup;
$('back').onclick = () => command('back');
$('later').onclick = () => command(state.step === 'welcome' ? 'later' : 'skip');
$('mic-settings').onclick = () => command('system', { kind: 'microphone' });
$('camera-settings').onclick = () => command('system', { kind: 'camera' });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); command(state?.step === 'done' ? 'finish' : 'later'); }
  else if (event.key === 'Enter' && !['BUTTON', 'INPUT'].includes(document.activeElement?.tagName)) { event.preventDefault(); continueSetup(); }
  else if (event.metaKey && event.key === '[' && !$('back').hidden) { event.preventDefault(); command('back'); }
});
window.oliveSetup.onState(render);
window.addEventListener('focus', async () => { if (!pending && !discovering) { try { render(await window.oliveSetup.command('get')); } catch {} } });
command('get');
