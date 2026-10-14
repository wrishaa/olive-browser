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

send `X-Olive-Agent: 1` on every request (requests from web pages are refused).

| call | does |
|---|---|
| `GET /tabs` | all tabs: id, windowId, title, url, active, visible, pinned, splitId, loaded, targetId, webSocketDebuggerUrl |
| `POST /tabs {url, background?, split?, windowId?}` | open a tab, waits for load. `split: true` puts it next to the active tab |
| `POST /tabs/:id/navigate {url}` | load url or search text, waits for load |
| `POST /tabs/:id/activate` `/back` `/forward` `/reload` `/close` | |
| `POST /tabs/:id/eval {expression}` | run js in the page, awaits promises, returns `{result}` |
| `GET /tabs/:id/text` | `document.body.innerText` |
| `GET /tabs/:id/screenshot` | png |
| `POST /tabs/:id/cdp {method, params}` | any CDP command on that tab, no websocket needed |
| `POST /tabs/:id/devtools` | toggle docked devtools |
| `POST /tabs/:id/split {with}` | show the tab next to tab `with` |
| `GET /windows`, `POST /windows {private?, url?}` | |
| `GET /history?q=&limit=` | browsing history |
| `GET /downloads` | |

```sh
curl -s -H 'X-Olive-Agent: 1' localhost:9333/tabs
curl -s -H 'X-Olive-Agent: 1' -X POST localhost:9333/tabs -d '{"url":"news.ycombinator.com"}'
curl -s -H 'X-Olive-Agent: 1' -X POST localhost:9333/tabs/3/eval -d '{"expression":"document.title"}'
curl -s -H 'X-Olive-Agent: 1' -X POST localhost:9333/tabs/3/cdp -d '{"method":"Network.enable"}'
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
