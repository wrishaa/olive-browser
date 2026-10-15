// User-triggered, local-only Arc cookie import. Never log secrets or sqlite rows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
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

const READ_SQLITE = `import sqlite3,json,base64,sys
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
version=int(c.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0])
rows=[]
for r in c.execute('SELECT * FROM cookies'):
 d=dict(r); d['encrypted_value']=base64.b64encode(d['encrypted_value']).decode('ascii'); rows.append(d)
print(json.dumps({'version':version,'rows':rows}))
c.close()
`;

async function importProfile(ses, profile, root = ARC_ROOT) {
  // Resolve only a profile actually named in Arc's Local State. Never accept paths.
  if (!profiles(root).some(p => p.dir === profile.dir && p.name === profile.name)) throw new Error('Arc profile changed; choose it again.');
  const sourceDir = path.join(root, profile.dir);
  const source = [path.join(sourceDir, 'Cookies'), path.join(sourceDir, 'Network/Cookies')].find(f => fs.existsSync(f));
  if (!source) throw new Error('No cookie database in that Arc profile.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-arc-'));
  fs.chmodSync(temp, 0o700);
  let secret, key;
  const stats = { profile: profile.name, directory: profile.dir, imported: 0, expired: 0, failed: 0, partitioned: 0, failedDomains: [], passwords: 'skipped: Olive has no password store', siteStorage: 'skipped: live LevelDB/IndexedDB cannot safely be merged' };
  const failedDomains = new Set();
  try {
    const dest = path.join(temp, 'Cookies');
    // Arc is quit by the UI first. Include SQLite sidecars for crash recovery too.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fs.existsSync(source + suffix)) {
        fs.copyFileSync(source + suffix, dest + suffix);
        fs.chmodSync(dest + suffix, 0o600);
      }
    }
    let payload;
    try {
      const { stdout } = await run('/usr/bin/python3', ['-I', '-c', READ_SQLITE, dest], { maxBuffer: 64 * 1024 * 1024 });
      payload = JSON.parse(stdout);
    } catch { throw new Error('Could not read the temporary Arc cookie snapshot. No source files changed.'); }
    // Exactly one service-scoped lookup. Never include stdout/stderr in an error.
    try {
      const result = await run('/usr/bin/security', ['find-generic-password', '-s', 'Arc Safe Storage', '-w'], { encoding: 'buffer', maxBuffer: 65536 });
      secret = result.stdout;
      const end = secret.length && secret[secret.length - 1] === 10 ? secret.length - 1 : secret.length;
      key = crypto.pbkdf2Sync(secret.subarray(0, end), 'saltysalt', 1003, 16, 'sha1');
      secret.fill(0);
    } catch { throw new Error('Arc Safe Storage was unavailable or access was cancelled. No key was logged.'); }
    for (const row of payload.rows) {
      const expiry = Number(row.expires_utc) / 1e6 - 11644473600;
      if (row.has_expires && expiry <= Date.now() / 1000) { stats.expired++; continue; }
      if (row.top_frame_site_key) { stats.partitioned++; failedDomains.add(row.host_key); continue; }
      try {
        const value = decryptCookie(row, key, payload.version);
        await ses.cookies.set(cookieDetails(row, value));
        stats.imported++;
      } catch {
        // Electron errors may include a cookie value: never retain or log them.
        stats.failed++;
        failedDomains.add(row.host_key);
      } finally { row.value = ''; row.encrypted_value = ''; }
    }
    await ses.cookies.flushStore();
    stats.failedDomains = [...failedDomains].sort();
    return stats;
  } finally {
    secret?.fill(0); key?.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
      detail: 'Only the chosen profile is read. Cookies merge into Olive’s normal session and may replace matching logins. Passwords and site storage are not imported.',
      buttons: [...choices.map(p => `${p.name} (${p.dir})`), 'Cancel'], cancelId: choices.length, defaultId: choices.length,
    });
    if (pick.response >= choices.length) return;
    const profile = choices[pick.response];
    const confirm = await dialog.showMessageBox({
      type: 'question', title: 'Import from Arc', message: `Import ${profile.name} into Olive?`,
      detail: 'Arc will quit so its cookie database can be copied consistently. macOS may ask permission for the single “Arc Safe Storage” keychain item. Nothing is uploaded. Temporary database copies are deleted afterwards.',
      buttons: ['Cancel', 'Quit Arc and Import'], defaultId: 0, cancelId: 0,
    });
    if (confirm.response !== 1) return;
    try {
      await run('/usr/bin/osascript', ['-e', 'if application id "company.thebrowser.Browser" is running then tell application id "company.thebrowser.Browser" to quit'], { timeout: 30000 });
    } catch { throw new Error('Arc did not quit. Close it and retry the import.'); }
    // Wait for Arc to finish flushing; never force-quit it.
    let running = false;
    for (let i = 0; i < 40; i++) {
      const { stdout } = await run('/usr/bin/osascript', ['-e', 'application id "company.thebrowser.Browser" is running']);
      running = stdout.trim() === 'true';
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (running) throw new Error('Arc is still running. Close it and retry.');
    const result = await importProfile(mgr.session, profile);
    // Aggregate counts + domain names only. No credentials in reports.
    const reportFile = path.join(app.getPath('userData'), 'arc-import-report.json');
    fs.writeFileSync(reportFile, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.chmodSync(reportFile, 0o600);
    await dialog.showMessageBox({
      type: 'info', title: 'Arc import complete', message: `${result.imported} cookies imported from ${profile.name}`,
      detail: `${result.expired} expired; ${result.failed} failed; ${result.partitioned} unsupported partitioned cookies.\nPasswords skipped: Olive has no password store.\nLocal storage/IndexedDB skipped: unsafe to merge.\nSome sites may still require sign-in. Existing open tabs need reloading.`, buttons: ['Done'],
    });
    mgr.broadcast();
  } catch (err) {
    // All thrown messages above are fixed strings, never sqlite rows or key data.
    await dialog.showMessageBox({ type: 'error', title: 'Arc import', message: 'Import could not finish', detail: 'Close Arc and retry. Check that Arc Safe Storage access is allowed in Keychain Access. No credentials were logged.', buttons: ['OK'] });
  } finally { mgr.arcImportBusy = false; }
}

module.exports = { profiles, decryptCookie, cookieDetails, importProfile, showImport };
