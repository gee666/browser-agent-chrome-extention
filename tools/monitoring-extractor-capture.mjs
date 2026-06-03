#!/usr/bin/env node
/**
 * Capture helper for tuning lib/browser-agent-core/content/extractor.js against
 * authenticated pages in the user's already-open Chrome extension session.
 *
 * IMPORTANT: this does not launch a browser. It starts the local WebSocket
 * broker that the installed extension connects to (default ws://127.0.0.1:7878),
 * then uses bridge requests against the current/selected tab.
 *
 * Usage examples:
 *   node tools/monitoring-extractor-capture.mjs --active
 *   node tools/monitoring-extractor-capture.mjs --url https://monitoring.../a/grafana-lokiexplore-app/explore
 *   node tools/monitoring-extractor-capture.mjs --out artifacts/monitoring-extractor --max-html-bytes 2000000
 *   node tools/monitoring-extractor-capture.mjs --reload-extension
 *
 * Outputs per page: rendered HTML, screenshot, extractor JSON, extractor DOM text,
 * tab metadata, and a small summary. Re-run after extractor edits/reloading the
 * extension to compare what changed.
 */
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_URLS = [
  'https://monitoring.ram30.ram-team.luxoft.com/',
  'https://monitoring.ram30.ram-team.luxoft.com/a/grafana-lokiexplore-app/explore',
  'https://monitoring.ram30.ram-team.luxoft.com/a/grafana-exploretraces-app/explore',
];

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
function has(name) { return process.argv.includes(`--${name}`); }
const port = Number(arg('port', 7878));
const outDir = resolve(String(arg('out', 'artifacts/monitoring-extractor')));
const urls = has('active') ? [] : process.argv.filter((v, i, a) => a[i - 1] === '--url');
if (!has('active') && urls.length === 0) urls.push(...DEFAULT_URLS);
const maxHtmlBytes = Number(arg('max-html-bytes', 2_000_000));
const settleMs = Number(arg('settle-ms', 5000));
const extractorPath = resolve(String(arg('extractor', 'lib/browser-agent-core/content/extractor.js')));

class WsPeer {
  constructor(socket) { this.socket = socket; this.buf = Buffer.alloc(0); this.fragments = []; this.nextId = 1; this.pending = new Map(); socket.on('data', b => this.onData(b)); }
  sendJson(obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    let hdr;
    if (payload.length < 126) hdr = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536) hdr = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    else {
      hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([hdr, payload]));
  }
  request(type, params = {}) {
    const id = String(this.nextId++);
    this.sendJson({ v: 1, kind: 'request', id, type, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${type}`)); }, Number(params.timeout_ms || 30000) + 10000);
      this.pending.set(id, { resolve, reject, t, type });
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const bigLen = this.buf.readBigUInt64BE(2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Websocket frame too large');
        len = Number(bigLen); off = 10;
      }
      const masked = !!(b1 & 0x80); const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const mask = masked ? this.buf.subarray(maskOff, maskOff + 4) : null;
      let payload = this.buf.subarray(off, off + len); this.buf = this.buf.subarray(off + len);
      if (mask) payload = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
      const opcode = b0 & 0x0f;
      const fin = !!(b0 & 0x80);
      if (opcode === 8) { this.socket.end(); return; }
      if (opcode === 1 || opcode === 0) {
        if (opcode === 1 && this.fragments.length) this.fragments = [];
        this.fragments.push(payload);
        if (!fin) continue;
        payload = this.fragments.length > 1 ? Buffer.concat(this.fragments) : payload;
        this.fragments = [];
      } else {
        continue;
      }
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.kind === 'hello') console.log('Extension hello:', msg);
      if (msg.kind === 'response') {
        const p = this.pending.get(msg.id); if (!p) continue;
        clearTimeout(p.t); this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(Object.assign(new Error(msg.error?.message || p.type), { bridgeError: msg.error }));
      }
    }
  }
}

function waitForPeer() {
  return new Promise((resolvePeer, reject) => {
    const server = createServer((socket) => {
      socket.once('data', (first) => {
        const text = first.toString('latin1');
        const key = /^Sec-WebSocket-Key: (.+)$/im.exec(text)?.[1]?.trim();
        if (!key) return socket.destroy();
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const peer = new WsPeer(socket);
        peer.server = server;
        resolvePeer(peer);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => console.log(`Waiting for extension bridge on ws://127.0.0.1:${port} ...`));
  });
}

function safeName(url, index) { return `${String(index + 1).padStart(2, '0')}-${new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'}`; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await mkdir(outDir, { recursive: true });
  const peer = await waitForPeer();
  const extractor = await readFile(extractorPath, 'utf8');
  if (has('reload-extension')) {
    const result = await peer.request('browser_reload_extension', { timeout_ms: 15000 });
    console.log('Reload requested:', result);
    peer.socket.end();
    peer.server?.close?.();
    return;
  }

  const tabs = await peer.request('browser_list_tabs', {});
  console.log('Tabs:', tabs.map(t => `${t.active ? '*' : ' '} ${t.tabId} ${t.url}`).join('\n'));
  const targets = urls.length ? urls : [tabs.find(t => t.active)?.url].filter(Boolean);

  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    console.log(`\n=== ${url} ===`);
    if (urls.length) await peer.request('browser_navigate', { url, use_active_tab: true, wait_until: 'settle', timeout_ms: 60000 });
    await sleep(settleMs);
    const name = safeName(url, i);
    const html = await peer.request('browser_get_html', { use_active_tab: true, wait_until: 'settle', max_bytes: maxHtmlBytes, strip: [] });
    await writeFile(join(outDir, `${name}.html`), html.html || '', 'utf8');
    await writeFile(join(outDir, `${name}.tab.json`), JSON.stringify({ requestedUrl: url, htmlMeta: html }, null, 2));
    const shot = await peer.request('browser_get_screenshot', { use_active_tab: true, wait_until: 'settle', format: 'png', quality: 0.9, max_width: 1600, timeout_ms: 60000 });
    await writeFile(join(outDir, `${name}.png`), Buffer.from(shot.data_base64, 'base64'));

    const code = `return await (async () => {\n  let listener;\n  const chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };\n  ${extractor}\n  if (!listener) throw new Error('extractor did not register listener');\n  return await new Promise((resolve) => listener({ type: 'get_page_state' }, null, resolve));\n})();`;
    const res = await peer.request('browser_run_js', { use_active_tab: true, code, timeout_ms: 30000, return_by_value: true, capture_console: true });
    const pageState = res.result?.value ?? res.value ?? res.result;
    await writeFile(join(outDir, `${name}.extractor.json`), JSON.stringify(pageState, null, 2));
    await writeFile(join(outDir, `${name}.domText.txt`), pageState?.domText || '', 'utf8');
    const summary = { url: pageState?.url, title: pageState?.title, elements: pageState?.elements?.length, domTextChars: pageState?.domText?.length, screenshot: `${name}.png`, html: `${name}.html` };
    await writeFile(join(outDir, `${name}.summary.json`), JSON.stringify(summary, null, 2));
    console.log(summary);
  }
  console.log(`\nSaved captures to ${outDir}`);
  peer.socket.end();
  peer.server?.close?.();
}
main().catch(e => { console.error(e.bridgeError || e); process.exit(1); });
