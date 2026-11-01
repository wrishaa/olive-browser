# ublock lite compatibility spike · 2026-10-15

narrowed scope: uBO Lite only. chatgpt/claude deferred. no dj cookies read, changed, cleared or imported by this work.

store: https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh
source: google's official update2/crx endpoint, TLS; unmodified CRX3 unpacked in a new empty directory (no manifest/source patch).
version 2026.1012.1545; CRX sha256 `de67c08f8f7a337bc82c2cc86423eea0243e02be3fd3bd9e289c20c82eadb24a`.
local metadata: `~/Library/Application Support/Olive Extensions/ublock.json`; unpacked bytes checked at startup. chromium generates DNR cache files and removes CWS verification metadata for unpacked loading; those metadata-only changes are allowed. this local hash manifest is reproducibility checking, not signature verification or a defense against a local attacker replacing both files and hashes.

## results

- installs: yes, real `session.extensions.loadExtension` on electron 44.7.2. unpacked ID differs from CWS ID because upstream manifest has no key; stable locally while path stays fixed.
- extension worker: fails at `js/background.js:871`, `chrome.permissions.onRemoved` undefined. `electron-chrome-extensions@4.9.0` was tried: frame APIs appeared, but worker still failed. dependency removed; no fake API shims shipped.
- native DNR: real API works. explicitly activating the six original enabled defaults (`ublock-filters`, `easylist`, `easyprivacy`, `pgl`, `ublock-badware`, `urlhaus-full`) enables native blocking without the failed worker.
- two bugs distinguished: default rules weren't active after the worker failed; separately, olive's google-only electron webRequest header hook bypassed DNR for all sites. removed hook, retained wc.setUserAgent navigation logic. google regression: Electron UA true, insecure-browser rejection false, password page true, no password entered.
- integrated dev CNN A/B: off 156 requests / 0 blocked; on 87 requests / 15 blocked. native `net::ERR_BLOCKED_BY_CLIENT` included `micro.rubiconproject.com`, `static.adsafeprotected.com`, `imasdk.googleapis.com`, plus analytics. request counts vary with page/network/consent; blocker errors distinguish extension filtering from generic DNS/ORB/CSP errors. guardian A/B also blocked analytics; no claim that all ads/cosmetic slots vanish.
- ui: sidebar button opens olive's explicitly-labeled basic rules popup with on/off; official popup URL can open, but official controls remain broken (not portrayed as working).
- gaps: worker permissions bridge/preload compatibility; background startup; active-tab/full official popup, per-site filtering modes, cosmetic filtering/picker; updates; private windows. estimate 2–5 days for worker compatibility investigation, potentially upstream electron work. defer big shims and further extensions.
- source references: electron v44.7.2 `docs/api/extensions.md`, `docs/api/extensions-api.md`; downloaded original uBO Lite manifest/background/popup. native APIs tested, not inferred from documentation coverage.

final rerun: integrated CNN off 263 requests / 0 blocked, on 108 / 19 blocked; all 27 existing UI checks + CDP smoke passed. rebuilt and installed `~/Applications/Olive.app`; native sidebar button and basic popup verified, six enabled rulesets, toggled off/on successfully and left on. CDP port remains off in the installed app. existing authenticated google page still loaded after relaunch. no user document edits or cookie manipulation. compatibility remains partial, not full extension success.

## 2026-11-02: worker runs via an Olive API shim

- Cause of the blank Options… page: Electron's extension worker exposes `self.browser`/`chrome` without `permissions`, `windows`, `commands`; uBOL's background.js threw at :871 so the dashboard never got a reply (body.loading forever).
- Fix: vendored CWS bytes unchanged; the profile-local copy gets an overlay (`olive/worker-shim.js`, `olive/worker.js`, manifest `service_worker` → `/olive/worker.js`), hash-verified like the rest (`overlayFiles` + `verifyPackage(root, record, overlay)`). Shim stand-ins only report what the manifest grants.
- Olive's on/off stays authoritative: while off (`chrome.storage.local.oliveBlocking = {enabled:false, rulesets}`), the worker sees a virtual ruleset list and real static rulesets stay off; turning on restores uBOL's own list (`rulesetConfig.enabledRulesets`, else manifest defaults).
- Still missing: `userScripts` (custom scriptlets). Official popup not re-checked.
- Test: scripts/extension-settings-native-test.mjs (dashboard renders with worker data, dark theme, off survives worker session start).
