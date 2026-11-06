// the raw chromium devtools port (opt-in: Developer menu / OLIVE_CDP=1 / --cdp) can't be
// hooked from inside electron, so olive never advertises it. chromium listens on a random
// loopback port; olive listens on the advertised one (9222 when free) and forwards http
// and websockets to it, running every client->browser cdp message through the same
// guard as the agent api (src/main/cdp-guard.js). a refused command never reaches
// chromium; the client gets a normal cdp error reply for its id.
//
// limits: the real port still exists on loopback (any local process could scan for it),
// so this protects tools that use the advertised url / DevToolsActivePort, not a
// process that's out to bypass it.
const http = require('http');
const net = require('net');
const { CdpGuard } = require('./cdp-guard');

const MAX_MESSAGE = 256 * 1024 * 1024;

// incremental websocket frame reader. yields {fin, opcode, payload (unmasked), raw}
// chunks are only joined once a whole frame is there (big screenshot frames stay linear)
class FrameReader {
  constructor() { this.chunks = []; this.len = 0; this.need = 2; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.chunks.push(chunk); this.len += chunk.length;
    if (this.len < this.need) return [];
    this.buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = this.parse();
    this.chunks = this.buf.length ? [this.buf] : []; this.len = this.buf.length;
    return out;
  }
  parse() {
    const out = [];
    this.need = 2;
    for (;;) {
      const b = this.buf;
      this.need = 2;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { this.need = 4; if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { this.need = 10; if (b.length < 10) break; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large'); len = Number(big); off = 10; }
      const maskOff = off; if (masked) off += 4;
      this.need = off + len;
      if (b.length < off + len) break;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskOff + (i & 3)];
      out.push({ fin, opcode, payload, raw: b.subarray(0, off + len) });
      this.buf = b.subarray(off + len);
    }
    return out;
  }
}

// an unmasked server->client text frame
function textFrame(str) {
  const data = Buffer.from(str, 'utf8');
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  return Buffer.concat([head, data]);
}

// reassembles data messages (text or binary, fragmented or not); control frames pass alone
class MessageReader {
  constructor() { this.frames = new FrameReader(); this.parts = null; }
  // returns [{control: true, raw} | {data: Buffer, raws: [Buffer]}]
  push(chunk) {
    const out = [];
    for (const f of this.frames.push(chunk)) {
      if (f.opcode >= 0x8) { out.push({ control: true, opcode: f.opcode, raw: f.raw }); continue; }
      if (f.opcode !== 0) this.parts = { payloads: [], raws: [] };
      if (!this.parts) continue; // stray continuation: drop
      this.parts.payloads.push(f.payload); this.parts.raws.push(Buffer.from(f.raw));
      if (f.fin) { out.push({ data: Buffer.concat(this.parts.payloads), raws: this.parts.raws }); this.parts = null; }
    }
    return out;
  }
}

function rewritePorts(text, from, to) {
  return text.split(`127.0.0.1:${from}`).join(`127.0.0.1:${to}`).split(`localhost:${from}`).join(`localhost:${to}`).split(`[::1]:${from}`).join(`[::1]:${to}`);
}

function startCdpProxy({ upstreamPort, port = 0, host = '127.0.0.1', log = () => {} }) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
    delete headers['accept-encoding'];
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (ur) => {
      const type = String(ur.headers['content-type'] || '');
      if (!/json/.test(type)) { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); return; }
      const chunks = []; ur.on('data', (c) => chunks.push(c)); ur.on('end', () => {
        const body = Buffer.from(rewritePorts(Buffer.concat(chunks).toString('utf8'), upstreamPort, server.address().port), 'utf8');
        const h = { ...ur.headers, 'content-length': body.length }; delete h['transfer-encoding'];
        res.writeHead(ur.statusCode, h); res.end(body);
      });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  server.on('upgrade', (req, client, head) => {
    sockets.add(client); client.on('close', () => sockets.delete(client));
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    const kill = () => { client.destroy(); upstream.destroy(); };
    client.on('error', kill); upstream.on('error', kill);
    const guard = new CdpGuard(); // one cdp session per websocket
    const pendingNotes = new Map(); // id (+ sessionId) -> {method, params} awaiting a result
    const key = (id, sessionId) => `${sessionId || ''}:${id}`;
    upstream.once('connect', () => {
      // same request to chromium, minus compression (we read frames in the clear)
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
        if (/^sec-websocket-extensions$/i.test(k)) continue;
        lines.push(`${k}: ${/^host$/i.test(k) ? `127.0.0.1:${upstreamPort}` : v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      let handshake = Buffer.alloc(0), open = false;
      const fromServer = new MessageReader();
      upstream.on('data', (chunk) => {
        if (!open) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end < 0) return;
          open = true;
          client.write(handshake.subarray(0, end + 4));
          chunk = handshake.subarray(end + 4);
          if (!chunk.length) return;
        }
        client.write(chunk);
        // read only to learn which browser contexts this session created
        let msgs; try { msgs = fromServer.push(chunk); } catch { kill(); return; }
        if (!pendingNotes.size) return;
        for (const m of msgs) {
          if (!m.data) continue;
          let msg; try { msg = JSON.parse(m.data.toString('utf8')); } catch { continue; }
          noteReply(msg);
        }
      });
      const fromClient = new MessageReader();
      const reply = (msg, err) => {
        const out = { id: msg.id, error: { code: -32000, message: err.message, data: err.why } };
        if (msg.sessionId) out.sessionId = msg.sessionId;
        client.write(textFrame(JSON.stringify(out)));
      };
      const pending = [];
      const onClient = (chunk) => {
        let msgs; try { msgs = fromClient.push(chunk); } catch { kill(); return; }
        for (const m of msgs) {
          if (m.control) { upstream.write(m.raw); continue; }
          let msg; try { msg = JSON.parse(m.data.toString('utf8')); } catch { msg = null; }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { log('dropped a cdp message that is not a json command'); continue; }
          try { guard.check(msg.method, msg.params); } catch (err) {
            if (err.code !== 'OLIVE_CDP_BLOCKED') throw err;
            log(`refused ${String(msg.method)}: ${err.why}`);
            reply(msg, err);
            continue;
          }
          const name = String(msg.method || '').toLowerCase();
          if (name === 'target.createbrowsercontext' || name === 'target.disposebrowsercontext') pendingNotes.set(key(msg.id, msg.sessionId), { method: msg.method, params: msg.params });
          // (a context made inside an old-style Target.sendMessageToTarget isn't learned:
          // clearing it stays refused, the safe side)
          for (const m2 of m.raws) upstream.write(m2);
        }
      };
      const noteReply = (msg) => {
        if (msg && msg.id != null) {
          const k = key(msg.id, msg.sessionId), p = pendingNotes.get(k);
          if (p) { pendingNotes.delete(k); if (!msg.error) guard.note(p.method, p.params, msg.result); }
        }
      };
      client.on('data', (c) => { if (!open) pending.push(c); else onClient(c); });
      const flush = setInterval(() => { if (open) { clearInterval(flush); for (const c of pending.splice(0)) onClient(c); } }, 5);
      if (head?.length) pending.push(head);
      client.on('close', () => { clearInterval(flush); upstream.destroy(); });
      upstream.on('close', () => { clearInterval(flush); client.destroy(); });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (port !== 0) { log(`cdp proxy: port ${port} busy (${err.code}), using a random one`); server.listen(0, host, () => resolve(proxyApi())); }
      else reject(err);
    });
    server.listen(port, host, () => resolve(proxyApi()));
  });
  function proxyApi() {
    return { server, port: server.address().port, upstreamPort, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
  }
}

module.exports = { startCdpProxy, FrameReader, MessageReader, textFrame, rewritePorts };
