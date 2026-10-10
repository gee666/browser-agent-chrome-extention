import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createAutoJevRelay } from './autojev-relay.mjs';
const extensionId = 'igkjmmohlilflmpifdodcanndbniocnb';
const origin = `chrome-extension://${extensionId}`;
async function fixture(t, fetchImpl) {
  const server = createAutoJevRelay({ extensionId, fetchImpl });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const headers = { Origin: origin, Authorization: 'Bearer test-only', 'Content-Type': 'application/json', 'X-App': 'extension' };

test('relay is origin-restricted and cannot proxy management or arbitrary URLs', async t => {
  const base = await fixture(t, () => assert.fail('must not forward'));
  assert.equal((await fetch(base + '/v1/systemone', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/v1/systemone', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  for (const path of ['/local/dashboard-key', '/local/keys', '/v1/systemone?url=http://elsewhere/']) assert.equal((await fetch(base + path, { headers })).status, 404);
  assert.throws(() => createAutoJevRelay({ extensionId, upstream: 'https://example.com' }));
  assert.throws(() => createAutoJevRelay({ extensionId: '*' }));
});

test('forwards auth/custom headers and exact body only to loopback evaluation', async t => {
  let request;
  const base = await fixture(t, async (url, options) => { request = { url, ...options }; return new Response('{"answers":{}}', { headers: { 'x-typesafe-request-id': 'test-request' } }); });
  const body = '{"state":"hello","questions":{}}';
  const response = await fetch(base + '/v1/systemone', { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('x-typesafe-request-id'), 'test-request');
  assert.equal(String(request.url), 'http://127.0.0.1:8765/v1/systemone');
  assert.equal(request.body.toString(), body);
  assert.equal(request.headers.authorization, 'Bearer test-only');
  assert.equal(request.headers['x-app'], 'extension');
  assert.equal(request.headers.origin, undefined);
  assert.equal(request.redirect, 'error');
});

test('preflight is narrow and missing credentials never reach upstream', async t => {
  const base = await fixture(t, () => assert.fail('must not forward'));
  const r = await fetch(base + '/v1/systemone', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-app' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-headers'), 'authorization, content-type, x-app');
  assert.equal((await fetch(base + '/v1/systemone', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

async function transportFixture(t, handler, timeoutMs) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = createAutoJevRelay({ extensionId, upstream: `http://127.0.0.1:${upstream.address().port}`, timeoutMs });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); upstream.closeAllConnections(); upstream.close(); });
  return `http://127.0.0.1:${relay.address().port}/v1/systemone`;
}

test('real transport waits for slow headers within its configured deadline', async t => {
  const url = await transportFixture(t, (req, res) => setTimeout(() => { res.writeHead(200); res.end('{"ready":true}'); }, 100), 1000);
  const r = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ready: true });
});

test('real transport aborts slow headers at the application deadline', async t => {
  let disconnected = false;
  const url = await transportFixture(t, (req, res) => { res.on('close', () => disconnected = true); }, 50);
  const r = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 504);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(disconnected, true);
});

test('client disconnect cancels an in-flight real upstream request', async t => {
  let closed;
  const disconnected = new Promise(resolve => closed = resolve);
  const url = await transportFixture(t, (req, res) => { res.on('close', closed); res.writeHead(200); res.write('{'); }, 3000);
  const controller = new AbortController();
  const pending = fetch(url, { method: 'POST', headers, body: '{}', signal: controller.signal }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort();
  await pending;
  let timer;
  await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream did not disconnect')), 1000); })]).finally(() => clearTimeout(timer));
});

test('real transport never follows upstream redirects', async t => {
  let secondRequest = false;
  const url = await transportFixture(t, (req, res) => {
    if (req.url === '/other') { secondRequest = true; res.end('bad'); return; }
    res.writeHead(307, { Location: '/other' }); res.end();
  }, 1000);
  const r = await fetch(url, { method: 'POST', headers, body: '{}', redirect: 'manual' });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), null);
  assert.equal(secondRequest, false);
});

test('upstream errors do not expose response bodies', async t => {
  const base = await fixture(t, async () => new Response('secret body', { status: 401 }));
  const r = await fetch(base + '/v1/systemone', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 401);
  assert.ok(!(await r.text()).includes('secret'));
});
