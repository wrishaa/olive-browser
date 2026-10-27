// Local, user-selected cookie migration. No discovery-time cookie/keychain reads.
// Call importSelected only AFTER the UI confirms the sources and keychain warning.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decryptCookie, cookieDetails } = require('./arc-import');
const exec = promisify(execFile);

const DEFINITIONS = [
  ['arc', 'Arc', 'Arc/User Data', 'Arc Safe Storage'],
  ['chrome', 'Google Chrome', 'Google/Chrome', 'Chrome Safe Storage'],
  ['brave', 'Brave', 'BraveSoftware/Brave-Browser', 'Brave Safe Storage'],
  ['edge', 'Microsoft Edge', 'Microsoft Edge', 'Microsoft Edge Safe Storage'],
  ['chromium', 'Chromium', 'Chromium', 'Chromium Safe Storage'],
  ['vivaldi', 'Vivaldi', 'Vivaldi', 'Vivaldi Safe Storage'],
];
const NOTES = [
  'Only cookies were considered; passwords, history, bookmarks, local storage and IndexedDB were not imported.',
  'Existing Olive cookies were kept. Partitioned cookies and unsupported encryption were skipped.',
  'Some sites bind sessions to a browser or device and will still require sign-in. Reload existing tabs.',
];
const UNSUPPORTED = {
  safari: 'Safari cookies use a different protected format; safe session import is not supported. Sign in to sites in Olive instead.',
  firefox: 'Firefox cookie/session migration is not supported yet. Sign in to sites in Olive instead.',
};
const validDir = dir => /^(Default|Profile \d+)$/.test(dir);
const exists = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const file = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const json = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const directories = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

// SQLite's online backup captures committed WAL data without quitting the source.
// Both a backup progress deadline and a subprocess timeout bound a busy writer.
const SNAPSHOT = `import sqlite3,json,base64,sys,time,pathlib,os
source,dest=sys.argv[1:3]
start=time.monotonic()
def progress(status,remaining,total):
 if time.monotonic()-start>8: raise TimeoutError('snapshot deadline')
s=sqlite3.connect(pathlib.Path(source).as_uri()+'?mode=ro',uri=True,timeout=1)
d=None
try:
 s.execute('PRAGMA query_only=ON')
 d=sqlite3.connect(dest,timeout=1)
 os.chmod(dest,0o600)
 s.backup(d,pages=128,progress=progress,sleep=0.05)
 d.row_factory=sqlite3.Row
 try:
  v=d.execute("SELECT value FROM meta WHERE key='version'").fetchone()
  version=int(v[0]) if v else 0
 except sqlite3.DatabaseError: version=0
 rows=[]
 for r in d.execute('SELECT * FROM cookies'):
  progress(0,0,0)
  r=dict(r)
  r['encrypted_value']=base64.b64encode(r.get('encrypted_value') or b'').decode('ascii')
  rows.append(r)
 print(json.dumps({'version':version,'rows':rows}))
finally:
 if d is not None: d.close()
 s.close()
`;

function createImporter({ home = os.homedir(), tempRoot = os.tmpdir(), run = exec, now = () => Date.now() } = {}) {
  const support = path.join(home, 'Library/Application Support');
  const definitions = DEFINITIONS.map(([id, name, subdir, service]) => ({ id, name, root: path.join(support, subdir), service }));

  function discoverBrowsers() {
    const browsers = [];
    for (const browser of definitions) {
      if (!exists(browser.root)) continue;
      const cache = json(path.join(browser.root, 'Local State')).profile?.info_cache || {};
      const dirs = [...new Set([...Object.keys(cache), ...directories(browser.root)])].filter(validDir).sort();
      const profiles = dirs.filter(dir => exists(path.join(browser.root, dir)) &&
        !(browser.id === 'arc' && String(cache[dir]?.name || '').startsWith('__ARC_'))).map(dir => {
        const supported = ['Network/Cookies', 'Cookies'].some(p => file(path.join(browser.root, dir, p)));
        return { id: `${browser.id}:${dir}`, browserId: browser.id, name: String(cache[dir]?.name || dir), dir,
          supported, reason: supported ? '' : 'No cookie database found in this profile.' };
      });
      browsers.push({ id: browser.id, name: browser.name, supported: true, profiles });
    }
    const safariRoots = [path.join(home, 'Library/Safari'), path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Safari')];
    if (safariRoots.some(exists)) {
      const dirs = [...new Set(safariRoots.flatMap(root => directories(path.join(root, 'Profiles'))))];
      browsers.push({ id: 'safari', name: 'Safari', supported: false, reason: UNSUPPORTED.safari,
        profiles: ['Default', ...dirs].map(dir => ({ id: `safari:${dir}`, browserId: 'safari', name: dir === 'Default' ? 'Default' : `Safari profile (${dir})`, dir, supported: false, reason: UNSUPPORTED.safari })) });
    }
    const firefoxRoot = path.join(support, 'Firefox');
    if (exists(firefoxRoot)) {
      let ini = ''; try { ini = fs.readFileSync(path.join(firefoxRoot, 'profiles.ini'), 'utf8'); } catch {}
      const profiles = ini.split(/\r?\n\s*\r?\n/).filter(s => /^\[Profile[^\]]*\]/m.test(s)).map((s, i) => {
        const name = s.match(/^Name=(.*)$/m)?.[1]?.trim() || `Profile ${i + 1}`;
        return { id: `firefox:${i}`, browserId: 'firefox', name, supported: false, reason: UNSUPPORTED.firefox };
      });
      browsers.push({ id: 'firefox', name: 'Firefox', supported: false, reason: UNSUPPORTED.firefox, profiles });
    }
    return browsers;
  }

  async function snapshot(source, dest) {
    try {
      const { stdout } = await run('/usr/bin/python3', ['-I', '-c', SNAPSHOT, source, dest], {
        encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      const payload = JSON.parse(stdout);
      if (!Array.isArray(payload.rows) || !Number.isInteger(payload.version)) throw new Error();
      return payload;
    } catch { throw new Error('Could not read a consistent cookie snapshot. The source may be busy or unavailable; retry later.'); }
  }

  async function storageKey(service) {
    let secret;
    try {
      const result = await run('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'buffer', timeout: 60000, maxBuffer: 65536,
      });
      secret = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
      const end = secret.length && secret[secret.length - 1] === 10 ? secret.length - 1 : secret.length;
      return crypto.pbkdf2Sync(secret.subarray(0, end), 'saltysalt', 1003, 16, 'sha1');
    } catch { throw new Error('Safe Storage access was unavailable or cancelled. No key was logged.'); }
    finally { secret?.fill(0); }
  }

  const identity = c => JSON.stringify([String(c.domain || c.host_key || '').replace(/^\./, '').toLowerCase(), c.path || '/', c.name]);

  async function importSelected(session, ids) {
    if (!session?.cookies?.get || !session.cookies.set || !session.cookies.flushStore) throw new Error('A destination browser session is required.');
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Choose at least one supported browser profile.');
    const available = discoverBrowsers().flatMap(b => b.profiles);
    const selected = [...new Set(ids)].map(id => available.find(p => p.id === id));
    // Validate the entire selection before snapshots or keychain access.
    if (selected.some(p => !p?.supported)) throw new Error('A chosen profile is unavailable or unsupported. Choose it again.');
    let existing;
    try { existing = new Set((await session.cookies.get({})).map(identity)); }
    catch { throw new Error('Could not read destination cookies. Nothing was imported.'); }
    const report = { profiles: [], imported: 0, existing: 0, expired: 0, partitioned: 0, failed: 0, notes: [...NOTES] };
    const keys = new Map();
    try {
      for (const profile of selected) {
        const browser = definitions.find(b => b.id === profile.browserId);
        const source = ['Network/Cookies', 'Cookies'].map(p => path.join(browser.root, profile.dir, p)).find(file);
        const stats = { id: profile.id, browser: browser.name, profile: profile.name, imported: 0, existing: 0, expired: 0, partitioned: 0, failed: 0 };
        let temp, payload;
        try {
          temp = fs.mkdtempSync(path.join(tempRoot, 'olive-browser-import-'));
          fs.chmodSync(temp, 0o700);
          payload = await snapshot(source, path.join(temp, 'Cookies'));
          // No keychain lookup for an empty/plaintext-only database, or if all
          // encrypted cookies are expired, partitioned or already in Olive.
          const eligible = row => !row.top_frame_site_key && !row.is_partitioned &&
            !(row.has_expires && Number(row.expires_utc) / 1e6 - 11644473600 <= now() / 1000) && !existing.has(identity(row));
          if (payload.rows.some(row => eligible(row) && row.encrypted_value)) {
            if (!keys.has(browser.service)) keys.set(browser.service, await storageKey(browser.service));
          }
          for (const row of payload.rows) {
            try {
              if (row.top_frame_site_key || row.is_partitioned) { stats.partitioned++; continue; }
              if (row.has_expires && Number(row.expires_utc) / 1e6 - 11644473600 <= now() / 1000) { stats.expired++; continue; }
              if (existing.has(identity(row))) { stats.existing++; continue; }
              // Re-check before setting so cookies created since the initial scan
              // are preserved too. Never remove or replace a destination cookie.
              const current = await session.cookies.get({ name: row.name });
              if (current.some(c => identity(c) === identity(row))) { existing.add(identity(row)); stats.existing++; continue; }
              const value = decryptCookie(row, keys.get(browser.service), payload.version);
              await session.cookies.set(cookieDetails(row, value));
              existing.add(identity(row));
              stats.imported++;
            } catch { stats.failed++; }
            finally { row.value = ''; row.encrypted_value = ''; }
          }
        } catch (error) {
          // Never expose process stderr, sqlite rows, paths or Electron errors.
          stats.error = error?.message === 'Safe Storage access was unavailable or cancelled. No key was logged.'
            ? error.message : 'Profile could not be read safely. Retry later or sign in manually.';
        } finally {
          if (payload) for (const row of payload.rows) { row.value = ''; row.encrypted_value = ''; }
          if (temp) fs.rmSync(temp, { recursive: true, force: true });
        }
        report.profiles.push(stats);
        for (const key of ['imported', 'existing', 'expired', 'partitioned', 'failed']) report[key] += stats[key];
      }
      try { await session.cookies.flushStore(); }
      catch { report.notes.push('Cookie persistence could not be confirmed; keep Olive open and retry if needed.'); }
      return report;
    } finally { for (const key of keys.values()) key.fill(0); keys.clear(); }
  }
  return { discoverBrowsers, importSelected };
}

module.exports = { ...createImporter(), _test: { createImporter, SNAPSHOT } };
