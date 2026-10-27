// User-triggered, local-only Arc cookie import. Never log secrets or sqlite rows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ARC_ROOT = path.join(os.homedir(), 'Library/Application Support/Arc/User Data');

function profiles(root = ARC_ROOT) {
  const cache = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {};
  return Object.entries(cache).filter(([dir, p]) =>
    /^(Default|Profile \d+)$/.test(dir) && !String(p.name).startsWith('__ARC_')
  ).map(([dir, p]) => ({ dir, name: p.name || dir }));
}

// Chromium macOS v10: AES-128-CBC, PBKDF2-SHA1(saltysalt, 1003).
// Cookie database v24+ authenticates the host with a SHA256 prefix.
function decryptCookie(row, key, version) {
  const enc = Buffer.from(row.encrypted_value, 'base64');
  if (!enc.length) return row.value || '';
  if (enc.subarray(0, 3).toString('ascii') !== 'v10') throw new Error('unsupported encryption');
  const dec = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([dec.update(enc.subarray(3)), dec.final()]);
  try {
    if (version >= 24) {
      const hash = crypto.createHash('sha256').update(row.host_key).digest();
      if (plain.length < 32 || !crypto.timingSafeEqual(plain.subarray(0, 32), hash)) throw new Error('host digest mismatch');
      return plain.subarray(32).toString('utf8');
    }
    return plain.toString('utf8');
  } finally { plain.fill(0); }
}

function cookieDetails(row, value) {
  if (row.top_frame_site_key) throw new Error('partitioned cookie unsupported');
  const host = row.host_key.replace(/^\./, '');
  const secure = !!row.is_secure;
  const details = {
    url: `${secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
    name: row.name, value, path: row.path || '/', secure, httpOnly: !!row.is_httponly,
    sameSite: ({ '-1': 'unspecified', '0': 'no_restriction', '1': 'lax', '2': 'strict' })[row.samesite] || 'unspecified',
  };
  // Omitting domain preserves host-only cookies (including __Host- prefixes).
  if (row.host_key.startsWith('.')) details.domain = row.host_key;
  if (row.has_expires && Number(row.expires_utc) > 0) details.expirationDate = Number(row.expires_utc) / 1e6 - 11644473600;
  return details;
}

// Legacy Arc entry point uses the same non-quitting, read-only migration path.
async function importProfile(ses, profile, root = ARC_ROOT) {
  if (root !== ARC_ROOT || !profiles(root).some(p => p.dir === profile.dir && p.name === profile.name)) {
    throw new Error('Arc profile changed; choose it again.');
  }
  const report = await require('./browser-import').importSelected(ses, [`arc:${profile.dir}`]);
  const stats = report.profiles[0];
  if (stats.error) throw new Error(stats.error);
  return { ...stats, directory: profile.dir,
    passwords: 'skipped: Olive has no password store',
    siteStorage: 'skipped: local storage and IndexedDB cannot safely be merged' };
}

async function showImport(mgr) {
  const { app, dialog } = require('electron');
  if (mgr.arcImportBusy) return;
  mgr.arcImportBusy = true;
  try {
    const choices = profiles();
    if (!choices.length) throw new Error('No Arc profiles found.');
    const pick = await dialog.showMessageBox({
      type: 'question', title: 'Import from Arc', message: 'Choose an Arc profile',
      detail: 'Only the chosen profile is read. Existing Olive cookies are kept. Passwords and site storage are not imported.',
      buttons: [...choices.map(p => `${p.name} (${p.dir})`), 'Cancel'], cancelId: choices.length, defaultId: choices.length,
    });
    if (pick.response >= choices.length) return;
    const profile = choices[pick.response];
    const confirm = await dialog.showMessageBox({
      type: 'question', title: 'Import from Arc', message: `Import ${profile.name} into Olive?`,
      detail: 'Arc stays open. A read-only SQLite snapshot is used. macOS may ask permission for the single “Arc Safe Storage” keychain item. Nothing is uploaded. Temporary database copies are deleted afterwards.',
      buttons: ['Cancel', 'Import'], defaultId: 0, cancelId: 0,
    });
    if (confirm.response !== 1) return;
    const result = await importProfile(mgr.session, profile);
    // Aggregate counts + domain names only. No credentials in reports.
    const reportFile = path.join(app.getPath('userData'), 'arc-import-report.json');
    fs.writeFileSync(reportFile, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.chmodSync(reportFile, 0o600);
    await dialog.showMessageBox({
      type: 'info', title: 'Arc import complete', message: `${result.imported} cookies imported from ${profile.name}`,
      detail: `${result.existing} existing cookies kept; ${result.expired} expired; ${result.failed} failed; ${result.partitioned} unsupported partitioned cookies.\nPasswords skipped: Olive has no password store.\nLocal storage/IndexedDB skipped: unsafe to merge.\nSome sites may still require sign-in. Existing open tabs need reloading.`, buttons: ['Done'],
    });
    mgr.broadcast();
  } catch (err) {
    // All thrown messages above are fixed strings, never sqlite rows or key data.
    await dialog.showMessageBox({ type: 'error', title: 'Arc import', message: 'Import could not finish', detail: 'Retry later or sign in manually. Check that Arc Safe Storage access is allowed in Keychain Access. No credentials were logged.', buttons: ['OK'] });
  } finally { mgr.arcImportBusy = false; }
}

module.exports = { profiles, decryptCookie, cookieDetails, importProfile, showImport };
