import test from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeSettings } from './bridge-settings.js';

function page(store = {}, { failRead = false, failWrite = false } = {}) {
  const elements = new Map(['piBridgeEnabled', 'piBridgeUrl', 'piBridgeSave', 'piBridgeStatus'].map(id => [id, {
    value: '', checked: false, disabled: false, textContent: '',
    addEventListener(type, callback) { this[type] = callback; },
  }]));
  const writes = [];
  const runtime = {};
  const chrome = { runtime, storage: { local: {
    get(keys, callback) {
      if (failRead) throw new Error('private storage error');
      callback(structuredClone(store));
    },
    set(items, callback) {
      if (failWrite) runtime.lastError = { message: 'private storage error' };
      else { Object.assign(store, structuredClone(items)); writes.push(items); }
      callback();
      delete runtime.lastError;
    },
  } } };
  return { document: { getElementById: id => elements.get(id) }, chrome, elements, store, writes };
}

test('bridge URLs save and survive a fresh page without any model/provider settings', async () => {
  const first = page();
  await initBridgeSettings(first.document, first.chrome);
  assert.match(first.elements.get('piBridgeUrl').value, /^ws:\/\/127\.0\.0\.1:7878/);
  first.elements.get('piBridgeUrl').value = 'ws://127.0.0.1:7878';
  first.elements.get('piBridgeEnabled').checked = true;
  await first.elements.get('piBridgeSave').click();
  assert.match(first.elements.get('piBridgeStatus').textContent, /saved/);
  assert.deepEqual(Object.keys(first.store), ['piBridgeConfig']);
  assert.equal(first.store.piBridgeConfig.enabled, true);
  assert.ok(first.store.piBridgeConfig.urls.includes('ws://127.0.0.1:7878'));
  const reloaded = page(first.store);
  await initBridgeSettings(reloaded.document, reloaded.chrome);
  assert.equal(reloaded.elements.get('piBridgeUrl').value, first.elements.get('piBridgeUrl').value);
});

test('custom URLs and disabled state round-trip without changing provider credentials', async () => {
  const p = page({ apiKey: 'secret', model: 'custom' });
  await initBridgeSettings(p.document, p.chrome);
  p.elements.get('piBridgeEnabled').checked = false;
  p.elements.get('piBridgeUrl').value = 'ws://localhost:9000\nwss://example.com/bridge\nws://localhost:9000';
  await p.elements.get('piBridgeSave').click();
  assert.deepEqual(p.store.piBridgeConfig, { enabled: false, url: 'ws://localhost:9000', urls: ['ws://localhost:9000', 'wss://example.com/bridge'] });
  assert.equal(p.store.apiKey, 'secret');
  assert.equal(p.store.model, 'custom');
});

test('invalid URL inputs never write settings', async () => {
  for (const url of ['not-a-url', 'http://localhost:7878', 'ws://user:secret@localhost:7878']) {
    const p = page();
    await initBridgeSettings(p.document, p.chrome);
    p.elements.get('piBridgeUrl').value = url;
    await p.elements.get('piBridgeSave').click();
    assert.equal(p.writes.length, 0);
    assert.match(p.elements.get('piBridgeStatus').textContent, /WebSocket URLs/);
  }
});

test('storage failures are visible without leaking error contents or claiming success', async () => {
  const unreadable = page({}, { failRead: true });
  await initBridgeSettings(unreadable.document, unreadable.chrome);
  assert.equal(unreadable.elements.get('piBridgeSave').disabled, true);
  assert.match(unreadable.elements.get('piBridgeStatus').textContent, /Could not load/);
  const p = page({}, { failWrite: true });
  await initBridgeSettings(p.document, p.chrome);
  p.elements.get('piBridgeUrl').value = 'ws://localhost:9000';
  await p.elements.get('piBridgeSave').click();
  assert.match(p.elements.get('piBridgeStatus').textContent, /Could not save/);
  assert.doesNotMatch(p.elements.get('piBridgeStatus').textContent, /private/);
  assert.equal(p.elements.get('piBridgeSave').disabled, false);
});
