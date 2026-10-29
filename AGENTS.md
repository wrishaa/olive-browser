# driving olive from an agent

olive exposes two local endpoints (127.0.0.1 only). find them in
`~/Library/Application Support/Olive/agent.json` (dev build: `Olive-dev/`):

```json
{ "cdp": "http://127.0.0.1:9222", "api": "http://127.0.0.1:9333", "cdpPort": 9222, "apiPort": 9333 }
```

ports fall back to random ones if 9222/9333 are taken, so read the file.
override with `OLIVE_CDP_PORT` / `OLIVE_API_PORT`.

## 1. chrome devtools protocol (full control)

standard chromium remote debugging. works with playwright, puppeteer, raw CDP.

```js
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
```

notes:
- every olive tab is a CDP page target. the olive ui itself (sidebar) and docked
  devtools are targets too: pick pages by `targetId` from `GET /tabs` below.
- `Target.createTarget` / `context.newPage()` don't make olive tabs. open tabs
  with `POST /tabs`, then attach to the returned `targetId` /
  `webSocketDebuggerUrl`.
- `browser.close()` on a CDP connection just disconnects.

## 2. olive api (tabs, windows, quick actions)

every request needs the token in `agent-token` (next to `agent.json`, mode
0600, created on first launch) as `Authorization: Bearer <token>`. the api binds
127.0.0.1 only and refuses any request with an `Origin` header (web pages) or a
non-localhost `Host` (dns rebinding). no token, no access, including `GET /`.
to rotate the token: quit olive, delete `agent-token`, relaunch.

| call | does |
|---|---|
| `GET /tabs` | all tabs: id, windowId, title, url, active, visible, pinned, splitId, loaded, targetId, webSocketDebuggerUrl |
| `POST /tabs {url, activate?, split?, windowId?}` | open a tab in the background (in the sidebar, not selected), waits for load. `activate: true` also selects it. `split: true` puts it next to the active tab |
| `POST /tabs/:id/navigate {url}` | load url or search text, waits for load |
| `POST /tabs/:id/activate` | select the tab inside its window. never focuses the window or brings olive forward |
| `POST /tabs/:id/back` `/forward` `/reload` `/close` | |
| `POST /tabs/:id/eval {expression}` | run js in the page, awaits promises, returns `{result}` |
| `GET /tabs/:id/text` | `document.body.innerText` |
| `GET /tabs/:id/screenshot` | png, works for background tabs without waking them (incl. the first shot of a never-shown tab: retried inside olive, no script retry needed) |
| `POST /tabs/:id/cdp {method, params, timeout?}` | any CDP command on that tab, no websocket needed. 504 after `timeout` ms (default 15000) |
| `POST /tabs/:id/frames {on?, ms?}` | full frame rate (~60/s) for a background tab for `ms` (default 30000, max 600000); `on:false` ends it. off by default |
| `POST /tabs/:id/devtools` | toggle docked devtools |
| `POST /tabs/:id/split {with}` | show the tab next to tab `with` |
| `GET /windows`, `POST /windows {private?, url?}` | |
| `POST /groups {name, status?}` | make a **tab group** for your work: it sits collapsed at the bottom of the sidebar with a sparkle, your name (1-60 chars, a task noun phrase: "Flights to Lisbon") and a one-line status. returns `{id, …}` |
| `POST /tabs {url, group: <id>}` | open a tab inside your group, always in the background (`activate` is ignored there). `group: {name, status?}` makes the group on the way |
| `PATCH /groups/:id {status?, name?, working?, collapsed?}` | update the status line (≤ 40 chars, present tense, no period: "comparing 3 fares", then "done · cheapest $612"). `working:false` stops the pulse when you are finished. a rename after the user renamed it gets 409 |
| `GET /groups`, `POST /groups/:id/close` | list groups (`tabIds`, `working`, `section`); close yours (all its tabs go) |
| `GET /history?q=&limit=` | browsing history |
| `GET /downloads` | |

### tab groups

put related tabs in a group so the user sees one tidy row ("✦ Flights to Lisbon · comparing 3 fares · 5")
instead of five tabs appearing in their list. the group lives in its own section at the bottom of
the sidebar; the user's tabs never move because of it. closing your own tabs inside a working group
keeps the group for 2 minutes (open → read → close → open is fine); the pulse also stops by itself
2 minutes after your last call. the user may rename, collapse, move tabs out of or close your group
at any time; a closed group's id is gone (404), make a new one.

```sh
G=$(curl -s -H "$T" -X POST localhost:9333/groups -d '{"name":"Flights to Lisbon","status":"searching"}' | jq .id)
curl -s -H "$T" -X POST localhost:9333/tabs -d "{\"url\":\"kayak.com\",\"group\":$G}"
curl -s -H "$T" -X PATCH localhost:9333/groups/$G -d '{"status":"done · cheapest $612","working":false}'
```

### working in the background

agents never take the foreground: no api call focuses a window, activates olive
or (unless you pass `activate: true` / call `/activate`) changes the selected
tab. background tabs stay throttled like any hidden tab. while an api call runs
on one (eval, cdp, navigate, back/forward/reload, text, screenshot) olive gives
it the size it would have on screen, and for everything but text/screenshot
emulates focus (`document.hasFocus()` true, `visibilityState` visible, timers
at full speed). ~1.5s after the last call that's undone and the tab is
throttled again. rAF/compositor frames stay slow (~1/s) in hidden tabs by default.
to watch an animation or a video, opt in to full frame rate (~60/s):
`frames: true` on eval/navigate/back/forward/reload/cdp does it for that call
only, `POST /tabs/:id/frames {ms}` for a window (default 30s, max 10min,
`{on:false}` ends it early). it costs gpu+cpu, so it ends by itself. a size you
set with `Emulation.setDeviceMetricsOverride` through `/cdp` is kept (also
between calls) until you send `Emulation.clearDeviceMetricsOverride`; cdp
`Page.captureScreenshot` works on hidden static pages too. don't toggle
`Emulation.setFocusEmulationEnabled` yourself through `/cdp`: olive turns it
off after each step.

```sh
T="Authorization: Bearer $(cat "$HOME/Library/Application Support/Olive/agent-token")"
curl -s -H "$T" localhost:9333/tabs
curl -s -H "$T" -X POST localhost:9333/tabs -d '{"url":"news.ycombinator.com"}'
curl -s -H "$T" -X POST localhost:9333/tabs/3/eval -d '{"expression":"document.title"}'
curl -s -H "$T" -X POST localhost:9333/tabs/3/cdp -d '{"method":"Network.enable"}'
```

## 3. cli

```sh
node bin/olive.mjs tabs
node bin/olive.mjs open github.com --split
node bin/olive.mjs eval 3 'document.title'
node bin/olive.mjs shot 3 /tmp/x.png
node bin/olive.mjs cdp 3 Page.navigate '{"url":"https://example.com"}'
```

## smoke test

`node scripts/cdp-smoke.mjs` (or `OLIVE_PROFILE=dev …`): opens a tab via the
api, attaches playwright over CDP, types + clicks, checks network events, evals,
screenshots, closes.

## security

both endpoints bind 127.0.0.1. CDP is unauthenticated (same as chrome with
`--remote-debugging-port`): any local process can drive the browser and read
cookies. the olive api refuses requests with an `Origin` header or a non-local
`Host`, and needs the custom header, so web pages can't call it.
