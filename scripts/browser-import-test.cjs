// Synthetic fixtures only: never reads a real profile or invokes Keychain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createImporter } = require('../src/main/browser-import')._test;
const { decryptCookie, cookieDetails } = require('../src/main/arc-import');
const exec = promisify(execFile);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-import-test-'));
const home = path.join(fixture, 'home');
const tempRoot = path.join(fixture, 'temp');
fs.mkdirSync(tempRoot);
const support = path.join(home, 'Library/Application Support');
const secret = 'synthetic-only';
const key = crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
let checks = 0;
function check(fn) { fn(); checks++; }
function row(name, overrides = {}) {
  return { host_key: '.example.test', name, path: '/', value: '', encrypted_value: '', is_secure: 1,
    is_httponly: 1, samesite: 1, has_expires: 0, expires_utc: 0, top_frame_site_key: '', ...overrides };
}
function encrypt(r, value) {
  const plain = Buffer.concat([crypto.createHash('sha256').update(r.host_key).digest(), Buffer.from(value)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  return { ...r, encrypted_value: Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]).toString('base64') };
}
async function database(root, rows) {
  fs.mkdirSync(root, { recursive: true });
  await exec('/usr/bin/python3', ['-I', '-c', `import sqlite3,json,base64,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE meta(key TEXT,value TEXT)')
c.execute("INSERT INTO meta VALUES ('version','24')")
c.execute('CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,expires_utc INTEGER,top_frame_site_key TEXT)')
for r in json.loads(sys.argv[2]):
 r['encrypted_value']=base64.b64decode(r['encrypted_value'])
 c.execute('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?)',tuple(r.values()))
c.commit()
c.close()`, path.join(root, 'Cookies'), JSON.stringify(rows)]);
}
function session(initial = []) {
  const saved = [...initial];
  return { saved, cookies: {
    get: async filter => saved.filter(c => !filter.name || c.name === filter.name),
    set: async d => saved.push({ ...d, domain: d.domain || new URL(d.url).hostname }),
    flushStore: async () => {},
  } };
}
(async () => {
  try {
    const arc = path.join(support, 'Arc/User Data');
    fs.mkdirSync(arc, { recursive: true });
    fs.writeFileSync(path.join(arc, 'Local State'), JSON.stringify({ profile: { info_cache: {
      Default: { name: 'Personal' }, 'Profile 2': { name: 'Work' }, '../escape': { name: 'unsafe' }, 'Profile 3': { name: '__ARC_internal' },
    } } }));
    const rows = [encrypt(row('new'), 'synthetic-cookie'), encrypt(row('existing'), 'do-not-replace'),
      encrypt(row('expired', { has_expires: 1, expires_utc: 11644473601000000 }), 'old'),
      encrypt(row('partitioned', { top_frame_site_key: 'https://other.test' }), 'partition'),
      row('bad', { encrypted_value: Buffer.from('v20unsupported').toString('base64') }), row('plain', { value: 'plaintext-cookie' })];
    await database(path.join(arc, 'Default'), rows);
    await database(path.join(arc, 'Profile 2'), [encrypt(row('work'), 'work-cookie')]);
    fs.mkdirSync(path.join(arc, 'Profile 3'));
    for (const sub of ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi']) await database(path.join(support, sub, 'Default'), []);
    fs.mkdirSync(path.join(home, 'Library/Safari/Profiles/test-uuid'), { recursive: true });
    fs.mkdirSync(path.join(support, 'Firefox'), { recursive: true });
    fs.writeFileSync(path.join(support, 'Firefox/profiles.ini'), '[Profile0]\nName=Personal\nPath=Profiles/synthetic\n');
    let keychainCalls = 0;
    const run = async (cmd, args, options) => {
      if (cmd === '/usr/bin/security') {
        keychainCalls++;
        assert.deepEqual(args, ['find-generic-password', '-s', 'Arc Safe Storage', '-w']);
        return { stdout: Buffer.from(secret + '\n') };
      }
      assert.equal(cmd, '/usr/bin/python3');
      assert.equal(options.timeout, 12000);
      const dest = args[args.length - 1];
      assert.equal(fs.statSync(path.dirname(dest)).mode & 0o777, 0o700);
      const result = await exec(cmd, args, options);
      assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
      return result;
    };
    const importer = createImporter({ home, tempRoot, run });
    const discovered = importer.discoverBrowsers();
    check(() => assert.equal(keychainCalls, 0));
    check(() => assert.deepEqual(discovered.map(b => b.id), ['arc', 'chrome', 'brave', 'edge', 'chromium', 'vivaldi', 'safari', 'firefox']));
    check(() => assert.deepEqual(discovered[0].profiles.map(p => p.name), ['Personal', 'Work']));
    check(() => assert.equal(discovered.find(b => b.id === 'firefox').profiles[0].name, 'Personal'));
    check(() => assert(discovered.filter(b => ['safari', 'firefox'].includes(b.id)).every(b => !b.supported && b.profiles.every(p => !p.supported && p.reason))));
    await assert.rejects(importer.importSelected(session(), ['arc:../escape'])); checks++;
    await assert.rejects(importer.importSelected(session(), ['arc:Default', 'safari:Default'])); checks++;
    check(() => assert.equal(keychainCalls, 0));
    const target = session([{ name: 'existing', domain: '.example.test', path: '/', value: 'keep-me' }]);
    const source = path.join(arc, 'Default/Cookies');
    const before = fs.readFileSync(source);
    const report = await importer.importSelected(target, ['arc:Default', 'arc:Profile 2', 'arc:Default']);
    check(() => assert.deepEqual([report.imported, report.existing, report.expired, report.partitioned, report.failed], [3, 1, 1, 1, 1]));
    check(() => assert.equal(keychainCalls, 1));
    check(() => assert.equal(report.profiles.length, 2));
    check(() => assert.equal(target.saved.find(c => c.name === 'existing').value, 'keep-me'));
    check(() => assert.equal(target.saved.find(c => c.name === 'new').sameSite, 'lax'));
    check(() => assert.equal(target.saved.find(c => c.name === 'new').httpOnly, true));
    check(() => assert.equal(target.saved.find(c => c.name === 'new').secure, true));
    check(() => assert.deepEqual(fs.readFileSync(source), before));
    check(() => assert.deepEqual(fs.readdirSync(tempRoot), []));
    check(() => assert(!JSON.stringify(report).includes('synthetic-cookie')));
    check(() => assert(!JSON.stringify(report).includes('plaintext-cookie')));
    check(() => assert.equal(decryptCookie(rows[0], key, 24), 'synthetic-cookie'));
    check(() => assert.throws(() => decryptCookie({ ...rows[0], host_key: '.wrong.test' }, key, 24)));
    check(() => assert.equal(cookieDetails(row('host', { host_key: 'example.test' }), 'v').domain, undefined));
    check(() => assert.equal(cookieDetails(row('exp', { has_expires: 1, expires_utc: '13444473600000000' }), 'v').expirationDate, 1800000000));
    // Errors from external tools must be scrubbed and temporary files removed.
    const denied = createImporter({ home, tempRoot, run: async (cmd, args, opts) => {
      if (cmd === '/usr/bin/security') throw new Error('SECRET-cookie-in-stderr');
      return run(cmd, args, opts);
    } });
    const failure = await denied.importSelected(session(), ['arc:Default']);
    check(() => assert(failure.profiles[0].error.includes('cancelled')));
    check(() => assert(!JSON.stringify(failure).includes('SECRET')));
    check(() => assert.deepEqual(fs.readdirSync(tempRoot), []));
    const busy = createImporter({ home, tempRoot, run: async () => { throw new Error('sensitive sqlite stderr'); } });
    const busyReport = await busy.importSelected(session(), ['arc:Default']);
    check(() => assert(busyReport.profiles[0].error));
    check(() => assert(!JSON.stringify(busyReport).includes('sensitive')));
    check(() => assert.deepEqual(fs.readdirSync(tempRoot), []));
    // Plaintext/empty sources need no Safe Storage request.
    const empty = await importer.importSelected(session(), ['chrome:Default']);
    check(() => assert.equal(empty.imported, 0));
    check(() => assert.equal(keychainCalls, 1));
    // A live, uncheckpointed WAL cookie must be present in the backup snapshot.
    const liveRoot = path.join(support, 'Google/Chrome/Default');
    const live = execFile('/usr/bin/python3', ['-I', '-u', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute("INSERT INTO cookies VALUES ('.wal.test','live','/','wal-value',X'',1,0,1,0,0,'')")
c.commit()
print('ready',flush=True)
sys.stdin.readline()
c.close()`, path.join(liveRoot, 'Cookies')]);
    try {
      await new Promise((resolve, reject) => { live.once('error', reject); live.stdout.once('data', resolve); });
      const liveTarget = session();
      const liveReport = await importer.importSelected(liveTarget, ['chrome:Default']);
      check(() => assert.equal(liveReport.imported, 1));
      check(() => assert.equal(liveTarget.saved[0].value, 'wal-value'));
    } finally { live.stdin.end('\n'); }
    console.log(`browser import: ${checks} synthetic checks passed; no real profiles, Keychain calls or browser quits`);
  } finally { key.fill(0); fs.rmSync(fixture, { recursive: true, force: true }); }
})().catch(() => { console.error('browser import synthetic test failed'); process.exitCode = 1; });
