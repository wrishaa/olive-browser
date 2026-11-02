// passkeys / webauthn (navigator.credentials.create / get).
//
// electron only services platform-authenticator requests after app.configureWebAuthn()
// (electron >= 44): until then isUserVerifyingPlatformAuthenticatorAvailable() is false and a
// passkey request waits forever (electron has no authenticator ui, no timeout dialog).
// the touch id authenticator stores device-bound passkeys in the keychain under a
// keychain access group that the signed app must carry in its `keychain-access-groups`
// entitlement (assets/entitlements.plist, scripts/package.mjs). if the running binary isn't
// signed with such a group (dev electron, ad-hoc builds) we leave webauthn off: turning it on
// without the entitlement makes sites offer passkeys that then fail.
//
// not covered by electron 44: icloud keychain / 1password passkeys (needs apple's browser
// passkey entitlement, see notes/passkeys.md), hybrid phone qr (no ui), security-key pin entry.
const fs = require('fs');

// entitlements live as a plain xml plist inside the main executable's code signature, so we
// read them from the binary instead of spawning codesign at startup (the stub is ~35 kB).
function keychainGroups(binary) {
  const text = Buffer.isBuffer(binary) ? binary.toString('latin1') : String(binary || '');
  const m = text.match(/<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  return [...m[1].matchAll(/<string>([^<]+)<\/string>/g)].map(x => x[1].trim()).filter(Boolean);
}

// the group we store passkeys under: an explicit override (tests), else the signed
// `<TEAM>.<bundle id>.webauthn` group.
function pickGroup(groups, override) {
  if (override) return groups.includes(override) ? override : null;
  return groups.find(g => /^[A-Z0-9]{10}\.[^.]+.*\.webauthn$/.test(g)) || null;
}

function readOwnGroups(execPath = process.execPath) {
  try { return keychainGroups(fs.readFileSync(execPath)); } catch { return []; }
}

// call once, early. returns { enabled, group, reason } for logs / tests.
function configure(app, { platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  if (platform !== 'darwin') return { enabled: false, reason: 'not macOS' };
  if (env.OLIVE_WEBAUTHN === '0') return { enabled: false, reason: 'OLIVE_WEBAUTHN=0' };
  if (typeof app.configureWebAuthn !== 'function') return { enabled: false, reason: 'electron has no configureWebAuthn' };
  const group = pickGroup(readOwnGroups(execPath), env.OLIVE_WEBAUTHN_GROUP);
  if (!group) return { enabled: false, reason: 'binary not signed with a *.webauthn keychain-access-groups entitlement' };
  try {
    // macOS shows: "Olive" is trying to sign in to example.com
    app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: 'sign in to $1' } });
    return { enabled: true, group };
  } catch (err) { return { enabled: false, group, reason: String(err?.message || err) }; }
}

// label for one account in the chooser
function accountLabel(a) {
  const name = a?.name || '', display = a?.displayName || '';
  if (name && display && name !== display) return `${display} (${name})`;
  return display || name || 'passkey';
}

// get() with several discoverable passkeys for the site: electron cancels the request
// (NotAllowedError) unless someone picks one. we ask with a small sheet on the tab's window.
// `choose(details, labels)` resolves to an index or -1 (injectable for tests).
function installAccountPicker(ses, { windowFor, dialog } = {}) {
  if (!ses || ses.__oliveWebauthnPicker) return; ses.__oliveWebauthnPicker = true;
  ses.on('select-webauthn-account', async (event, details, callback) => {
    let done = false; const answer = id => { if (done) return; done = true; try { id ? callback(id) : callback(); } catch {} };
    try {
      const accounts = Array.isArray(details?.accounts) ? details.accounts : [];
      if (!accounts.length) return answer();
      if (accounts.length === 1) return answer(accounts[0].credentialId); // electron only asks for 2+, but be safe
      const labels = accounts.map(accountLabel);
      const win = windowFor?.(details.frame) || null;
      const opts = { type: 'question', message: `Sign in to ${details.relyingPartyId || 'this site'}`, detail: 'Choose a passkey', buttons: [...labels, 'Cancel'], cancelId: labels.length, defaultId: 0, noLink: true };
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      answer(response >= 0 && response < accounts.length ? accounts[response].credentialId : null);
    } catch { answer(); }
  });
}

module.exports = { keychainGroups, pickGroup, configure, accountLabel, installAccountPicker };
