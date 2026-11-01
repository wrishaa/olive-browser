const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commandSuggestions, isAppCommand } = require('../src/core/app-commands');
test('common user words surface app destinations before web suggestions', () => {
  for (const [q, id] of Object.entries({shortcuts:'shortcuts',settings:'shortcuts',preferences:'shortcuts',activities:'activities',activity:'activities','site time':'activities',usage:'activities',remap:'shortcuts',profiles:'profiles'})) {
    assert.equal(commandSuggestions(q)[0].commandId,id,q);
    assert.equal(commandSuggestions(q)[0].kind,'command');
  }
  assert.ok(commandSuggestions('settings').some(c=>c.commandId==='sitePermissions'));
});
test('partial words, empty prompt and URL-like input', () => {
  assert.equal(commandSuggestions('short')[0].commandId,'shortcuts');
  assert.equal(commandSuggestions('acti')[0].commandId,'activities');
  assert.equal(commandSuggestions('')[0].commandId,'activities');
  for(const q of ['settings.example','https://activities.com','localhost:9333','randomunrelated']) assert.deepEqual(commandSuggestions(q),[]);
});
test('only allowlisted local actions execute', () => {
  assert.equal(isAppCommand('activities'),true);
  for(const id of ['closeWindow','submit','eval','__proto__',null]) assert.equal(isAppCommand(id),false);
});
test('extensions page is a palette destination', () => {
  for (const q of ['extensions', 'extension', 'ext', 'ublock', 'ubo', 'ad blocker', 'adblock']) assert.equal(commandSuggestions(q)[0].commandId, 'extensions', q);
  assert.equal(isAppCommand('extensions'), true);
  assert.ok(commandSuggestions('settings').some(c => c.commandId === 'extensions'));
  assert.ok(commandSuggestions('settings').some(c => c.commandId === 'sitePermissions'));
});
