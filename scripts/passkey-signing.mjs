// passkeys (touch id) at signing time, used by scripts/package.mjs.
//
// electron's touch id authenticator (src/main/webauthn.js) stores passkeys under a keychain
// access group that must be in the app's `keychain-access-groups` entitlement. on macOS that
// entitlement is restricted: amfi kills the app at launch ("Code has restricted entitlements,
// but the validation of its code signature failed") unless a provisioning profile embedded at
// Contents/embedded.provisionprofile allows it. so the entitlement is only added when a
// Developer ID provisioning profile for this exact app id is supplied (OLIVE_PROVISION_PROFILE
// or assets/embedded.provisionprofile). no profile: signed exactly as before, passkeys off.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEAM = 'GLUU6G59Y3';
export const webauthnGroup = (team, bundleId) => `${team}.${bundleId}.webauthn`;

// does a profile's entitlement pattern (`TEAM.*`, `TEAM.com.x.*`, exact) cover a value?
export const covers = (pattern, value) => pattern === value || (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1)));

// profile: { team, appId, groups, platforms, expires } -> problems (empty = usable)
export function profileProblems(profile, { team = TEAM, bundleId, now = new Date() } = {}) {
  const out = [];
  if (!profile) return ['no profile'];
  if (profile.team !== team) out.push(`profile team ${profile.team} is not ${team}`);
  if (!profile.appId || !covers(profile.appId, `${team}.${bundleId}`)) out.push(`profile app id ${profile.appId} does not cover ${team}.${bundleId}`);
  const group = webauthnGroup(team, bundleId);
  if (!(profile.groups || []).some(g => covers(g, group))) out.push(`profile keychain-access-groups ${JSON.stringify(profile.groups || [])} do not cover ${group}`);
  if (profile.platforms && !profile.platforms.includes('OSX')) out.push(`profile is for ${profile.platforms.join(', ')}, not macOS`);
  if (profile.expires && profile.expires < now) out.push(`profile expired ${profile.expires.toISOString()}`);
  return out;
}

// read a .provisionprofile (cms-signed plist) with apple's tools
export function readProfile(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-profile-'));
  try {
    const plist = path.join(dir, 'p.plist');
    fs.writeFileSync(plist, execFileSync('/usr/bin/security', ['cms', '-D', '-i', file]));
    const get = key => { try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
    const list = key => (get(key) || '').split('\n').map(s => s.trim()).filter(s => s && s !== 'Array {' && s !== '}');
    const expires = get('ExpirationDate');
    return { team: list('TeamIdentifier')[0] || null, appId: get('Entitlements:com.apple.application-identifier'), groups: list('Entitlements:keychain-access-groups'),
      platforms: list('Platform'), expires: expires ? new Date(expires) : null, name: get('Name') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// base entitlements plist text + the passkey keys for the main app
export function withPasskeyEntitlements(basePlist, { team = TEAM, bundleId }) {
  const extra = `<!-- passkeys (touch id): allowed by Contents/embedded.provisionprofile, see scripts/passkey-signing.mjs -->\n`
    + `<key>com.apple.application-identifier</key><string>${team}.${bundleId}</string>\n`
    + `<key>com.apple.developer.team-identifier</key><string>${team}</string>\n`
    + `<key>keychain-access-groups</key><array><string>${webauthnGroup(team, bundleId)}</string></array>\n`;
  if (!basePlist.includes('</dict></plist>')) throw new Error('unexpected entitlements plist shape');
  return basePlist.replace('</dict></plist>', extra + '</dict></plist>');
}

// decide for a build: { profile, entitlements (path), problems }
export function passkeySigning({ root, app, bundleId, baseEntitlements, env = process.env, log = console.log }) {
  const file = env.OLIVE_PROVISION_PROFILE || path.join(root, 'assets', 'embedded.provisionprofile');
  if (!fs.existsSync(file)) { log(`passkeys: no provisioning profile (${env.OLIVE_PROVISION_PROFILE ? file : 'set OLIVE_PROVISION_PROFILE'}), touch id passkeys stay off`); return { entitlements: baseEntitlements, problems: ['no profile'] }; }
  const profile = readProfile(file);
  const problems = profileProblems(profile, { bundleId });
  if (problems.length) throw new Error(`passkeys: provisioning profile ${file} unusable: ${problems.join('; ')}`);
  fs.copyFileSync(file, path.join(app, 'Contents', 'embedded.provisionprofile'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'olive-entitlements-')), 'entitlements.plist');
  fs.writeFileSync(out, withPasskeyEntitlements(fs.readFileSync(baseEntitlements, 'utf8'), { bundleId }));
  log(`passkeys: embedded profile "${profile.name}", keychain group ${webauthnGroup(TEAM, bundleId)}`);
  return { profile, entitlements: out, problems: [] };
}
