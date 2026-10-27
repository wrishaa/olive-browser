const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decryptCookie, cookieDetails, profiles } = require('../src/main/arc-import');
const key = crypto.pbkdf2Sync('synthetic-test-only', 'saltysalt', 1003, 16, 'sha1');
const row = { host_key: '.example.com', name: 'test', path: '/', is_secure: 1, is_httponly: 1, samesite: 1, has_expires: 1, expires_utc: '13444473600000000', top_frame_site_key: '', has_cross_site_ancestor: 1 };
const plain = Buffer.concat([crypto.createHash('sha256').update(row.host_key).digest(), Buffer.from('synthetic-cookie')]);
const enc = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
row.encrypted_value = Buffer.concat([Buffer.from('v10'), enc.update(plain), enc.final()]).toString('base64');
assert.equal(decryptCookie(row, key, 24), 'synthetic-cookie');
assert.throws(() => decryptCookie({ ...row, host_key: '.wrong.example' }, key, 24));
assert.throws(() => decryptCookie({ ...row, encrypted_value: Buffer.from('v20xyz').toString('base64') }, key, 24));
const details = cookieDetails(row, 'synthetic-cookie');
assert.equal(details.domain, '.example.com');
assert.equal(details.secure, true);
assert.equal(details.httpOnly, true);
assert.equal(details.sameSite, 'lax');
assert.equal(details.expirationDate, 1800000000);
assert.equal(cookieDetails({ ...row, host_key: 'example.com' }, '').domain, undefined);
assert.throws(() => cookieDetails({ ...row, top_frame_site_key: 'https://partition.example' }, ''));
assert.equal(cookieDetails({ ...row, has_expires: 0 }, '').expirationDate, undefined);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-arc-profiles-test-'));
try {
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: {
    'Profile 2': { name: 'dj' }, 'Profile 3': { name: '__ARC_internal' }, '../escape': { name: 'unsafe' },
  } } }));
  assert.deepEqual(profiles(root), [{ dir: 'Profile 2', name: 'dj' }]);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('arc import: 12 synthetic crypto/mapping/profile checks passed (no real cookie/key reads)');
