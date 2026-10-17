# cache/performance diagnosis — 2026-10-18

result: caching works; no production caching defect reproduced. no runtime changes, rebuild, cache clear, cookie clear, arc access, or login changes.

## configuration audit

- normal windows and pages share `session.fromPartition('persist:olive')` through `webPreferences.session`. private windows intentionally use fresh non-persistent partitions.
- no HTTP-cache disabling flags, explicit cache-size limits, `clearCache`, or `clearStorageData` calls in app source. Chromium's normal disk/memory caches are enabled.
- installed normal partition's Cache directory is about 566 MiB. size alone is not proof of cache hits; measurements below are.
- navigation uses `loadURL`; ordinary reload uses `reload`, hard reload alone uses `reloadIgnoringCache`. ordinary reload may revalidate the document while reusing assets; this is normal browser behavior.
- `agent-api.js` no-store applies only to loopback API responses, not web content.
- extension test disables caching on its own new CDP test target, not globally or on existing user tabs. test tabs close afterward.
- startup restores tab metadata lazily and loads the active tab/split, not all background tabs. startup does await extension integrity checks/loading before showing restored windows; that is a possible startup-only cost, not measured as the cause here.
- defaults discard background renderers after 30 minutes or above 16 loaded tabs. revisiting a discarded tab reconstructs the page (HTTP cache remains). current installed snapshot: 9 tabs, all 9 loaded, so discarding was not causing the observed active-page wait.

## measurements

`node scripts/cache-test.mjs` tests the actual installed app via its authenticated loopback API. it uses unique localhost URLs with explicit max-age=3600, a 150 ms synthetic server delay and two ~512 KiB assets; no user's cached entries are invalidated.

final repeat:

- cold: 369 ms load, 1,049,642 transferred bytes, 3 document/asset server requests.
- warm navigation after about:blank: 13 ms load, 0 transferred bytes, both assets cache hits, 0 additional document/asset server requests.
- ordinary reload: 251 ms, document fetched again (458 bytes), both assets reused. expected behavior.
- delayed favicon requests are excluded from fixture counters.

`node scripts/cache-disk-test.mjs` launches the same Electron 44.7.2 runtime twice with the same persistent partition in a brand-new temporary profile, then deletes only that temporary profile. it is not a restart of the user's Olive app.

- first process: 375 ms, 524,953 transferred bytes, 2 server requests.
- second process after restart: 93 ms, 0 transferred bytes, 0 new server requests; cache size 525,312 bytes retained.
- confirms disk persistence in this runtime/config, complementing actual installed-app warm-cache hits. memory-cache versus disk-cache split was not separately instrumented in the installed process.

`node scripts/cache-test.mjs --public` also sampled Wikipedia twice; this is first/second observed load, not a guaranteed empty-cache cold test:

- first: TTFB 1,840 ms; response end 7,022 ms; DOM ready 7,184 ms; load 9,199 ms; 14 cache hits among 26 recorded resources.
- second: TTFB 524 ms; response end 1,195 ms; DOM ready 1,303 ms; load 2,936 ms; 24 cache hits among 41 recorded resources.
- DOM work after HTML response was only ~162/108 ms in these samples. resource totals differ because late scripts/requests vary; this is not a controlled benchmark.
- Wikipedia HTML says `private, s-maxage=0, max-age=0, must-revalidate, no-transform`, so network revalidation is required; cached static assets do not remove all network waits.
- independent curl on this connection also took ~8.69 s for Wikipedia and ~2.83 s TTFB for example.com. curl differs from Chromium, but slow waits are not exclusive to Olive.

read-only sample of the user's active page (no content or URLs recorded): TTFB ~8,965 ms, DOM ready ~9,370 ms, load ~99,631 ms; 58 resources with positive decoded size and zero transfer among 159 recorded. this supports network/server and late-resource waits rather than a disabled cache. it does not rule out interaction/rendering bugs on other pages.

## smallest next step

no cache setting change justified; do not override sites' cache-control or clear data. for this reproduced slowness the dominant wait is network/main response plus late resources. the sidebar spinner follows `did-stop-loading`, so it can keep spinning long after DOM-ready; a separate DOM-ready versus background-fetch indicator could make that distinction clearer, but would not improve the network itself.

if the complaint is specifically returning to old tabs, measure a discarded versus resident tab before changing the 30-minute/16-tab memory policy. if it is scrolling/typing, capture a short interaction trace on that affected page; navigation timings alone do not diagnose it.
