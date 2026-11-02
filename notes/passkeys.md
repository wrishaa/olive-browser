# passkeys / webauthn in olive (nov 2 2026, branch overnight-passkeys off f7451ab)

## what olive did before (f7451ab, electron 44.7.2)

- no webauthn code at all: no `app.configureWebAuthn`, no `select-webauthn-account`, nothing in
  `src/main/permissions.js` (its check/request handlers never see webauthn; it isn't a permission).
- signed f7451ab build entitlements: allow-jit, disable-library-validation, audio-input, camera,
  location. no keychain-access-groups, no provisioning profile. Info.plist has electron's default
  `NSBluetoothAlwaysUsageDescription` / `NSBluetoothPeripheralUsageDescription` ("This app needs access to Bluetooth").
- electron services platform authenticators only after `app.configureWebAuthn()` (added in 44, PR 51255/51412).
  until then `isUserVerifyingPlatformAuthenticatorAvailable()` is false.
- electron has no webauthn ui. a request no authenticator answers never settles, not even after
  its own timeout, and every later call on the page fails with `OperationError: A request is already pending.`
  measured on webauthn.io (throwaway profile): create with timeout 60000 still pending after 75 s;
  direct create on https://webauthn.io (rpId webauthn.io): pending at 20 s, then get = "A request is already pending".
  that is what google sign-in hits ("try another way to use your passkey").
- several discoverable passkeys for one site + get() without allowCredentials: electron emits
  `select-webauthn-account`; with no listener the request fails with NotAllowedError.

## per mode

| mode | before | now (this branch) | blocker |
|---|---|---|---|
| a) touch id platform authenticator | missing | wired + gated, off until signed with a profile | needs a Developer ID provisioning profile (dj, portal) |
| b) icloud keychain / 1password passkeys | missing | missing | apple managed entitlement + electron doesn't support browser-mode passkeys |
| c) hybrid / phone qr | missing | missing | electron has no caBLE/qr ui; not fixable in olive |
| d) usb security keys | works for keys without pin (touch / built-in uv) | same + the account chooser | pin entry unsupported in electron (issue 24573) |

### a) touch id
electron 44: `app.configureWebAuthn({ touchID: { keychainAccessGroup, promptReason } })`; passkeys are
device-bound (secure enclave), not synced. the group must be in `keychain-access-groups`.
measured: a temp copy (com.reframe.olive.passkeytest, Developer ID GLUU6G59Y3, hardened runtime) signed with
`keychain-access-groups = [GLUU6G59Y3.com.reframe.olive.passkeytest.webauthn]` is killed at launch (exit 137):
`AMFI: Code has restricted entitlements, but the validation of its code signature failed. Unsatisfied Entitlements`.
so it needs an embedded provisioning profile. none exists on this mac for GLUU6G59Y3.
calling configureWebAuthn without the entitlement (dev electron): uvpaa stays false, platform create hangs.

what olive does now: `src/main/webauthn.js` reads the entitlements from its own signed binary and calls
`configureWebAuthn` only when a `<TEAM>.<bundle>.webauthn` group is there (dev / unsigned: off, unchanged).
`scripts/package.mjs` + `scripts/passkey-signing.mjs` add the entitlement only if a matching profile is supplied.

**dj, to turn touch id passkeys on** (account holder or admin, developer.apple.com → Certificates, Identifiers & Profiles):
1. Identifiers → + → App IDs → App → description "Olive", Bundle ID **explicit** `com.reframe.olive`. no capability
   needed for touch id (keychain groups `GLUU6G59Y3.*` come with every profile). register.
2. Profiles → + → Distribution → **Developer ID** → App ID `com.reframe.olive` → certificate
   "Developer ID Application: Retune AI Inc (GLUU6G59Y3)" (the one on this mac) → name "Olive Developer ID" → download.
3. put it at `assets/embedded.provisionprofile` (or `OLIVE_PROVISION_PROFILE=/path/x.provisionprofile npm run package -- --release`).
   the build checks team, app id, keychain group, platform and expiry, embeds it at
   `Contents/embedded.provisionprofile`, and signs the main app with
   `com.apple.application-identifier = GLUU6G59Y3.com.reframe.olive`, `com.apple.developer.team-identifier = GLUU6G59Y3`,
   `keychain-access-groups = [GLUU6G59Y3.com.reframe.olive.webauthn]` (helpers keep the base set).
4. then verify on webauthn.io: register (touch id sheet "Olive is trying to sign in to webauthn.io") + authenticate.
   not verified yet: needs the profile.

### b) icloud keychain passkeys (synced, the "use your passkey" sheet like safari/chrome)
- for a browser this is apple's managed capability `com.apple.developer.web-browser.public-key-credential`
  ("lets your app make registration and assertion requests for passkeys and security keys for any relying party").
  request form (account holder only): https://developer.apple.com/contact/request/macos-browsers-passkeys/
  criteria: http/https in Info.plist (olive has them), url field on launch, navigates directly to the url.
- suggested request text: "Olive (bundle id com.reframe.olive, team GLUU6G59Y3) is a Chromium-based desktop web browser
  for macOS. It registers http/https URL handlers, opens to a URL/search field, and loads any website the user enters
  without redirection. We request the Web Browser Public Key Credential entitlement so users can create and use iCloud
  Keychain and credential-provider passkeys on any website, as in Safari and Chrome."
- after approval: App ID com.reframe.olive → Capabilities/Additional capabilities → enable it, regenerate the Developer ID
  profile, add `<key>com.apple.developer.web-browser.public-key-credential</key><true/>` to the main-app entitlements.
- **but electron can't use it**: electron's `platformPasskeys` (electron >= 45 era, PR 51563, not in 44.7.2) uses
  ASAuthorizationController with Associated Domains, i.e. only for the app's own sites; electron's source says it
  doesn't reuse chromium's icloud_keychain.mm because that "gates on the com.apple.developer.web-browser.public-key-credential
  entitlement ... Electron apps don't (and can't) carry that entitlement". so even with apple's grant olive needs an
  electron patch (or upstream feature) that enables chromium's browser-mode icloud keychain authenticator.

### c) hybrid / phone qr
chromium's caBLE code is in the binary but electron's request delegate never shows the qr / bluetooth ui
(RegisterActionCallbacks ignores the bluetooth callbacks). no entitlement fixes that; needs electron work.
the bluetooth usage strings are already in Info.plist; `com.apple.security.device.bluetooth` is only for sandboxed apps.

### d) usb security keys
chromium's hid discovery runs without ui; hardened runtime needs no usb/hid entitlement
(`com.apple.security.device.usb` is app sandbox only). verified with a CDP virtual usb ctap2 key: webauthn.io
register + login pass before and after. real keys that need a PIN fail (electron: "does not support WebAuthn PIN entry").
not tested with a physical key (none attached).

## what changed
- `src/ui/webauthn-preload.js`: unanswered create/get end with chrome's NotAllowedError at the site's timeout
  (10 s..10 min clamp, 5 min default, +1 s grace), freeing the request slot. conditional (autofill) requests untouched.
- `src/main/webauthn.js` + main.js: touch id gate (above) and a passkey chooser sheet for `select-webauthn-account`.
- `scripts/package.mjs` / `scripts/passkey-signing.mjs`: profile-gated passkey entitlements.
- tests: `tests/webauthn.test.js` (unit), `scripts/webauthn-native-test.mjs` (native, in test:native),
  `scripts/webauthn-probe.mjs` (manual probe against a real site, not in any suite).

## fyi: stuck tab drag (read on f7451ab, not changed)
confirmed in code: `startDrag` (src/ui/ui.js:548) sends overlay drag, which raises the full-window ui view over the pages
(src/main/window.js:1133-1136). only `endDrag` (ui.js:697, overlay null at :709) clears it, only from the window
`pointerup` (ui.js:519). no pointercancel / lostpointercapture / blur handling for a drag. if the pointerup never reaches the
ui (cancelled gesture, cmd-tab or mission control mid-drag, release lost with the capture), `drag` stays set and the
transparent ui view keeps eating clicks over the page. it is not permanent: the next pointerup anywhere in the window hits
`if (drag) endDrag(e)`, but that click is eaten and can perform the stale drop (move / split). also `endDrag` releases
capture with `d.pointerId`, which is never set (capture was taken with `pressing.pointerId`); harmless (caught).
