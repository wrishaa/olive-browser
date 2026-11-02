const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSettingsUrl, settingsUrl, validTab, TABS } = require('../src/core/settings-url');

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
