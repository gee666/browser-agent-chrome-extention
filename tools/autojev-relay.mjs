#!/usr/bin/env node
// AutoJev documents a backend requirement for cross-origin browser clients.
// This relay accepts only one extension origin and forwards only model evaluation.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 48 * 1024 * 1024;
const OMIT_HEADERS = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'user-agent', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

// Node fetch has an independent five-minute response-header deadline. Use the
// HTTP client without implicit deadlines so the explicit abort timer governs.
// HTTP request does not follow redirects.
export function requestUpstream(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method, headers, signal, timeout: 0 }, response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = response.statusCode || 502;
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response), { status, headers: responseHeaders }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

export function createAutoJevRelay({ upstream = 'http://127.0.0.1:8765', extensionId, timeoutMs = 1200000, fetchImpl = requestUpstream } = {}) {
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('A Chrome extension ID is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('Relay timeout must be 1–3600000 ms');
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname)) {
    throw new Error('Upstream must be a loopback HTTP(S) origin');
  }
  const origin = `chrome-extension://${extensionId}`;
  const endpoint = new URL('/v1/systemone', target);
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, message) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    const host = String(req.headers.host || '');
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      reply(403, 'Loopback clients only'); return;
    }
    if (req.headers.origin !== origin) { reply(403, 'Extension origin not allowed'); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-TypeSafe-Request-Id');
    if (req.url !== '/v1/systemone') { reply(404, 'Only model evaluation is supported'); return; }
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'POST') { reply(405, 'POST required'); return; }
      const headers = String(req.headers['access-control-request-headers'] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
      if (headers.some(h => !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(h) || OMIT_HEADERS.has(h) || h.startsWith('sec-') || h.startsWith('proxy-'))) { reply(400, 'Unsupported headers'); return; }
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': headers.join(', '), 'Access-Control-Max-Age': '600' });
      res.end(); return;
    }
    if (req.method !== 'POST') { reply(405, 'POST required'); return; }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { reply(415, 'JSON required'); return; }
    if (!req.headers.authorization && !req.headers['x-api-key']) { reply(401, 'API key required'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    req.on('aborted', disconnect);
    res.on('close', disconnect);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { reply(413, 'Request too large'); return; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!OMIT_HEADERS.has(key) && !key.startsWith('sec-') && !key.startsWith('proxy-') && typeof value === 'string') headers[key] = value;
      }
      // A backend-to-backend request has no browser Origin, cookies or referrer.
      const upstreamResponse = await fetchImpl(endpoint, { method: 'POST', headers, body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error' });
      const requestId = upstreamResponse.headers.get('x-typesafe-request-id');
      if (requestId && /^[a-zA-Z0-9-]{1,100}$/.test(requestId)) res.setHeader('X-TypeSafe-Request-Id', requestId);
      // The browser provider only consumes status on errors; never forward bodies
      // which might echo credentials or request content from a misconfigured server.
      if (!upstreamResponse.ok) { await upstreamResponse.body?.cancel(); reply(upstreamResponse.status, 'AutoJev rejected the request'); return; }
      const body = await upstreamResponse.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch {
      reply(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'AutoJev request timed out or disconnected' : 'AutoJev connection failed');
    } finally {
      clearTimeout(timer);
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const extensionId = process.env.AUTOJEV_EXTENSION_ID || process.argv[2];
  const port = Number(process.env.AUTOJEV_RELAY_PORT || 8878);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port');
  const timeoutMs = Number(process.env.AUTOJEV_RELAY_TIMEOUT_MS || 1200000);
  const server = createAutoJevRelay({ extensionId, upstream: process.env.AUTOJEV_UPSTREAM || 'http://127.0.0.1:8765', timeoutMs });
  server.requestTimeout = timeoutMs;
  server.listen(port, '127.0.0.1', () => console.log(`AutoJev relay listening on http://127.0.0.1:${port}; extension ${extensionId}`));
  const close = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
