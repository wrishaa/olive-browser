// settings.json in userData (app-wide, not per profile). Read before chromium starts
// (cdp switch), so this stays plain node: no electron.
const fs = require('fs');
const path = require('path');
const TU = require('./tab-unload');

const DEFAULTS = Object.freeze({ cdp: false, agentApi: true, ...TU.DEFAULTS });

// settings + whether the file needs rewriting (a one-time migration happened)
function loadSettings(file) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const { settings, changed } = TU.migrate(raw);
  const out = { ...DEFAULTS, ...settings };
  out.cdp = !!out.cdp;
  out.agentApi = out.agentApi !== false;
  return { settings: out, changed: changed && fs.existsSync(file) };
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

// a value from the settings page: booleans for the toggles, whole numbers for unloading
function normalizeSetting(key, value) {
  if (key === 'cdp' || key === 'agentApi') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
    return value;
  }
  return TU.normalize(key, value);
}

module.exports = { DEFAULTS, loadSettings, saveSettings, normalizeSetting };
