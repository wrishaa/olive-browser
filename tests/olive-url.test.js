const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSettingsUrl, settingsUrl, validTab, TABS, parseOliveUrl, extensionDisplayUrl, extensionLoadUrl, isOliveUrl } = require('../src/core/olive-url');

test('olive://settings and its tabs', () => {
  assert.deepEqual(parseSettingsUrl('olive://settings'), { tab: 'general' });
  assert.deepEqual(parseSettingsUrl(' olive://settings/ '), { tab: 'general' });
  assert.deepEqual(parseSettingsUrl('OLIVE://Settings/Shortcuts'), { tab: 'shortcuts' });
  for (const t of TABS) assert.deepEqual(parseSettingsUrl(`olive://settings/${t}`), { tab: t });
  assert.deepEqual(parseSettingsUrl('olive:settings'), { tab: 'general' });
  assert.deepEqual(parseSettingsUrl('olive://settings/general#x'), { tab: 'general' });
  assert.deepEqual(parseSettingsUrl('olive://settings/unloading'), { tab: 'general', section: 'unloading' });
});
test('old page names are aliases', () => {
  assert.deepEqual(parseSettingsUrl('olive://shortcuts'), { tab: 'shortcuts' });
  assert.deepEqual(parseSettingsUrl('olive://extensions'), { tab: 'extensions' });
  assert.deepEqual(parseSettingsUrl('olive://activities'), { tab: 'activities' });
  assert.deepEqual(parseSettingsUrl('olive://preferences'), { tab: 'general' });
  assert.deepEqual(parseSettingsUrl('olive://permissions'), { tab: 'general', section: 'permissions' });
});
test('anything else is not a settings url', () => {
  for (const x of ['', null, 'settings', 'https://settings', 'olive://', 'olive://nope', 'olive://settings/nope', 'olive://shortcuts/x', 'olive://settings/general/extra', 'javascript:olive://settings', 'oliveo://settings'])
    assert.equal(parseSettingsUrl(x), null, String(x));
  assert.equal(settingsUrl('general'), 'olive://settings');
  assert.equal(settingsUrl('extensions'), 'olive://settings/extensions');
  assert.equal(validTab('__proto__'), 'general');
});

test('olive:// pages, redirects and assets', () => {
  const p = u => parseOliveUrl(u);
  assert.equal(p('olive://settings').file, 'settings-general.html');
  assert.equal(p('olive://settings/shortcuts').file, 'shortcuts.html');
  assert.equal(p('olive://settings/activities').file, 'site-time.html');
  assert.equal(p('olive://settings/extensions').file, 'extensions.html');
  assert.equal(p('olive://settings/general?section=unloading').query.section, 'unloading');
  assert.equal(p('olive://extensions').location, 'olive://settings/extensions');
  assert.equal(p('olive://shortcuts').location, 'olive://settings/shortcuts');
  assert.equal(p('olive://settings/unloading').location, 'olive://settings/general?section=unloading');
  assert.equal(p('olive://site-settings?origin=https://meet.google.com/x').location, 'olive://settings/general?section=permissions&origin=https%3A%2F%2Fmeet.google.com');
  assert.equal(p('olive://site-settings?origin=javascript:alert(1)').location, 'olive://settings/general?section=permissions');
  assert.equal(p('olive://extensions/ublock').file, 'extension.html');
  assert.equal(p('olive://ledger').file, 'ledger.html');
  assert.equal(p('olive://profiles').file, 'profiles.html');
  assert.equal(p('olive://onboarding').file, 'onboarding.html');
  assert.equal(p('olive://onboarding/screen').step, 'screen');
  assert.equal(p('olive://onboarding/nope'), null);
  // assets: plain names next to the pages, never a preload, never a path
  assert.equal(p('olive://settings/settings-nav.js').asset, 'settings-nav.js');
  assert.equal(p('olive://ledger/ledger.css').asset, 'ledger.css');
  for (const bad of ['olive://settings/settings-preload.js', 'olive://settings/..%2Fmain%2Fmain.js', 'olive://nope/ui.css', 'olive://user:pw@settings', 'olive://settings:8080', 'olive://ledger/x', 'olive://extensions/other', 'olive://extensions/ublock/a/b'])
    assert.ok(!p(bad) || p(bad).kind !== 'asset' && !p(bad).file, bad);
  assert.equal(p('olive://settings/%2e%2e/x.js').asset, 'x.js'); // dot segments resolve inside the host: still one plain name
  assert.equal(isOliveUrl('OLIVE://x'), true);
  assert.equal(isOliveUrl('https://olive'), false);
});

test('uBO pages show as olive:// and load the chrome-extension page', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(extensionLoadUrl('olive://extensions/ublock/options', id), `chrome-extension://${id}/dashboard.html`);
  assert.equal(extensionLoadUrl('olive://extensions/ublock/dashboard#settings', id), `chrome-extension://${id}/dashboard.html#settings`);
  assert.equal(extensionLoadUrl('olive://extensions/ublock/popup', id), `chrome-extension://${id}/popup.html`);
  assert.equal(extensionLoadUrl('olive://extensions/ublock', id), null);
  assert.equal(extensionLoadUrl('olive://extensions/ublock/options', null), null);
  assert.equal(extensionDisplayUrl(`chrome-extension://${id}/dashboard.html#rulesets`, id), 'olive://extensions/ublock/options#rulesets');
  assert.equal(extensionDisplayUrl(`chrome-extension://${id}/popup.html`, id), 'olive://extensions/ublock/popup');
  assert.equal(extensionDisplayUrl(`chrome-extension://other/popup.html`, id), null);
  assert.equal(extensionDisplayUrl(`chrome-extension://${id}/js/x.js`, id), null);
});

test('settings deep links carry section and origin', () => {
  assert.equal(settingsUrl('general', { section: 'permissions', origin: 'https://a.example/x?y' }), 'olive://settings/general?section=permissions&origin=https%3A%2F%2Fa.example');
  assert.equal(settingsUrl('shortcuts', { section: 'bogus' }), 'olive://settings/shortcuts');
  assert.deepEqual(parseSettingsUrl('olive://site-settings?origin=https://a.example'), { tab: 'general', section: 'permissions', origin: 'https://a.example' });
});
