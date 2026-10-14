#!/usr/bin/env node
// tiny cli for the olive agent api. reads ~/Library/Application Support/Olive/agent.json
// (set OLIVE_PROFILE=dev for the dev build).
//
//   olive info                      endpoints (cdp + api)
//   olive tabs                      list tabs
//   olive open <url> [--split] [--bg]
//   olive nav <tab> <url>
//   olive eval <tab> <js>
//   olive text <tab>
//   olive shot <tab> [file.png]
//   olive cdp <tab> <Method> [json-params]
//   olive activate|close|back|forward|reload|devtools <tab>
//   olive history [query]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile = process.env.OLIVE_PROFILE ? `Olive-${process.env.OLIVE_PROFILE}` : 'Olive';
const infoFile = path.join(os.homedir(), 'Library/Application Support', profile, 'agent.json');
let info;
try {
  info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
} catch {
  console.error(`olive is not running (no ${infoFile})`);
  process.exit(1);
}

async function call(p, body, raw = false) {
  const res = await fetch(info.api + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Olive-Agent': '1', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) {
    console.error(text);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

switch (cmd) {
  case 'info':
    out(info);
    break;
  case 'tabs': {
    const tabs = await call('/tabs');
    for (const t of tabs) console.log(`${String(t.id).padStart(4)} ${t.active ? '*' : t.visible ? '+' : ' '} ${t.pinned ? 'P' : ' '} ${t.title?.slice(0, 50).padEnd(50)} ${t.url}`);
    break;
  }
  case 'open':
    out(await call('/tabs', { url: pos[0], split: flags.has('--split'), background: flags.has('--bg') }));
    break;
  case 'nav':
    out(await call(`/tabs/${pos[0]}/navigate`, { url: pos[1] }));
    break;
  case 'eval':
    out((await call(`/tabs/${pos[0]}/eval`, { expression: pos.slice(1).join(' ') })).result);
    break;
  case 'text':
    out(await call(`/tabs/${pos[0]}/text`));
    break;
  case 'shot': {
    const res = await call(`/tabs/${pos[0]}/screenshot`, null, true);
    const file = pos[1] || `/tmp/olive-tab-${pos[0]}.png`;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(file);
    break;
  }
  case 'cdp':
    out(await call(`/tabs/${pos[0]}/cdp`, { method: pos[1], params: pos[2] ? JSON.parse(pos[2]) : {} }));
    break;
  case 'activate':
  case 'close':
  case 'back':
  case 'forward':
  case 'reload':
  case 'devtools':
    out(await call(`/tabs/${pos[0]}/${cmd}`, {}));
    break;
  case 'history':
    for (const h of await call(`/history?q=${encodeURIComponent(pos[0] || '')}&limit=30`)) console.log(`${new Date(h.last).toISOString().slice(0, 16)}  ${h.title?.slice(0, 50).padEnd(50)} ${h.url}`);
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 16).map((l) => l.slice(3)).join('\n'));
}
