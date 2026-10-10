import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeJevConfig } from '../lib/browser-agent-core/background/jev.js';
import {
  DECISION_DEFAULTS, DECISION_STORAGE_KEYS, DecisionValidationError,
  validateDecisionSettings, toJevConnectionConfig, initDecisionSettings,
} from './decision-settings.js';

const html = await readFile(new URL('./options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('./options.js', import.meta.url), 'utf8');

function values(overrides = {}) {
  return { ...DECISION_DEFAULTS, jevHeaders: '{}', jevRequestParams: '{}', jevTimeoutMs: '1200000', ...overrides };
}

function documentStub() {
  const fields = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    fields.set(id, {
      id, value: '', checked: false, textContent: '', innerHTML: '',
      style: {}, disabled: false, attributes: new Map(), listeners: new Map(),
      addEventListener(event, handler) { this.listeners.set(event, handler); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
    });
  }
  return {
    fields, listeners: new Map(),
    getElementById(id) { return fields.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener(event, handler) { this.listeners.set(event, handler); },
  };
}

function init(stored = {}, runtime = { sendMessage() {} }) {
  const document = documentStub();
  const ui = initDecisionSettings(document, runtime, stored);
  return { document, ui, fields: document.fields, click: () => document.fields.get('jev-test-btn').listeners.get('click')() };
}

test('storage defaults, field IDs, and blank helper match the contract', () => {
  assert.deepEqual(validateDecisionSettings(values()), {
    decisionMode: 'llm', jevBaseUrl: 'http://localhost:8765', jevApiKey: '', jevModel: 'jev-latest',
    jevHeaders: {}, jevRequestParams: {}, jevTimeoutMs: 1200000, jevFallbackEnabled: true, helperModel: '',
  });
  for (const key of DECISION_STORAGE_KEYS) {
    assert.match(html, new RegExp(`id="${key}"`));
    assert.match(html, new RegExp(`(?:for="${key}"|type="checkbox" id="${key}")`));
  }
  assert.match(html, /type="password" id="jevApiKey"/);
  for (const id of ['provider', 'apiKey', 'model-select', 'model-custom', 'baseUrl']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /\.\.\.DECISION_STORAGE_KEYS/);
});

test('accepts each endpoint form, trimmed strings, blank key, custom helper, and disabled fallback', () => {
  for (const endpoint of ['http://localhost:8765', 'http://localhost:8765/v1/', 'https://example.com/v1/systemone']) {
    const config = validateDecisionSettings(values({
      decisionMode: 'jev', jevBaseUrl: ` ${endpoint} `, jevApiKey: ' ', jevModel: ' jev-custom ',
      helperModel: ' custom-helper ', jevFallbackEnabled: false, jevTimeoutMs: '1',
      jevHeaders: '{"X-Api-Key":"secret","X-Session":"session-secret"}',
      jevRequestParams: '{"temperature":0,"nested":{"enabled":true},"tags":["a","b"]}',
    }));
    assert.equal(config.jevBaseUrl, endpoint);
    assert.equal(config.jevApiKey, '');
    assert.equal(config.jevModel, 'jev-custom');
    assert.equal(config.helperModel, 'custom-helper');
    assert.equal(config.jevFallbackEnabled, false);
    assert.equal(config.jevTimeoutMs, 1);
    assert.deepEqual(config.jevHeaders, { 'X-Api-Key': 'secret', 'X-Session': 'session-secret' });
    assert.equal(config.jevRequestParams.nested.enabled, true);
  }
  assert.equal(validateDecisionSettings(values({ jevTimeoutMs: '3600000' })).jevTimeoutMs, 3600000);
  assert.match(html, /id="jevTimeoutMs" min="1" max="3600000" step="1" value="1200000"/);
  assert.deepEqual(validateDecisionSettings(values({ jevHeaders: ' ', jevRequestParams: '' })).jevHeaders, {});
});

test('rejects invalid fields without quoting any entered value', () => {
  const cases = {
    decisionMode: ['secret-marker'],
    jevBaseUrl: ['', 'secret-marker', 'file:///secret-marker', 'https://secret-marker:password@example.com',
      'https://example.com/?key=secret-marker', 'https://example.com/#secret-marker'],
    jevApiKey: ['secret-marker\nembedded'],
    jevModel: ['', 'secret-marker\nembedded'],
    helperModel: ['secret-marker\nembedded'],
    jevHeaders: ['{"secret-marker":', '[]', 'null', '"secret-marker"', '{"bad name":"secret-marker"}',
      '{"X-Key":123}', '{"X-Key":"secret-marker\\r\\nInjected"}', '{"X-Key":"secret-marker\\u0000"}',
      '{"Authorization":"secret-marker"}', '{"Content-Type":"secret-marker"}',
      '{"User-Agent":"secret-marker"}', '{"Content-Encoding":"secret-marker"}',
      JSON.stringify({ 'X-Key': 'secret-marker\ttab' }),
      '{"Host":"secret-marker"}', '{"Sec-Fetch-Site":"secret-marker"}', '{"Proxy-Secret":"secret-marker"}',
      '{"X-Key":"secret-marker","x-key":"other"}', '{"X-Key":"secret-marker🙂"}',
      '{"__proto__":{"secret-marker":true}}'],
    jevRequestParams: ['{"secret-marker":', '[]', 'null', '42', '{"state":"secret-marker"}',
      '{"questions":{"secret-marker":true}}', '{"images":["secret-marker"]}', '{"model":"secret-marker"}',
      '{"nested":[{"constructor":"secret-marker"}]}'],
    jevTimeoutMs: ['', 'secret-marker', '0', '-1', '1.5', 'Infinity', '1e3', '3600001', '2147483648'],
    jevFallbackEnabled: ['secret-marker'],
  };
  for (const [field, invalidValues] of Object.entries(cases)) {
    for (const value of invalidValues) {
      assert.throws(() => validateDecisionSettings(values({ [field]: value })), error => {
        assert.ok(error instanceof DecisionValidationError);
        assert.equal(error.field, field);
        assert.ok(!error.message.includes('secret-marker'));
        return true;
      }, `${field} should reject invalid input`);
    }
  }
});

test('accepted UI configurations pass the shared core normalizer', () => {
  for (const timeoutMs of [1, 1200000, 3600000]) {
    for (const endpoint of ['http://localhost:8765', 'http://localhost:8878/v1', 'https://example.com/v1/systemone']) {
      for (const headers of [{}, { 'X-Key': 'header-secret' }, { 'X-AutoJev-Prefix-Cache': 'true' }, { 'x-api-key': 'local-key' }]) {
        const settings = validateDecisionSettings(values({
          decisionMode: 'jev', jevTimeoutMs: String(timeoutMs), jevBaseUrl: endpoint,
          jevHeaders: JSON.stringify(headers), jevRequestParams: '{"temperature":0}',
        }));
        const normalized = normalizeJevConfig(toJevConnectionConfig(settings));
        assert.equal(normalized.timeoutMs, timeoutMs);
        assert.deepEqual(normalized.headers, headers);
        assert.equal(normalized.requestParams.temperature, 0);
        assert.match(normalized.endpoint, /\/v1\/systemone$/);
      }
    }
  }
});

test('reserved headers and all control characters are rejected by both UI and core', () => {
  const badHeaders = [
    { 'User-Agent': 'agent' }, { 'user-agent': 'agent' }, { 'CONTENT-Encoding': 'gzip' },
    { Authorization: 'Bearer key' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Proxy-Key': 'key' },
    ...[...Array.from({ length: 32 }, (_, index) => index), 127].map(code => ({ 'X-Key': `secret-marker${String.fromCharCode(code)}end` })),
  ];
  for (const headers of badHeaders) {
    assert.throws(() => normalizeJevConfig({ headers }));
    assert.throws(() => validateDecisionSettings(values({ jevHeaders: JSON.stringify(headers) })), error => {
      assert.equal(error.field, 'jevHeaders');
      assert.ok(!error.message.includes('secret-marker'));
      return true;
    });
  }
});

test('stored JSON objects, credentials, helper, and false fallback round-trip', () => {
  const stored = {
    ...DECISION_DEFAULTS, decisionMode: 'jev', jevApiKey: 'saved-secret',
    jevHeaders: { 'X-Key': 'saved-secret' }, jevRequestParams: { temperature: 0 },
    jevFallbackEnabled: false, helperModel: 'custom-helper',
  };
  const { ui, fields } = init(stored);
  assert.deepEqual(ui.read(), stored);
  assert.equal(fields.get('jevFallbackEnabled').checked, false);
  assert.equal(fields.get('jev-test-status').textContent, '');
  assert.deepEqual(init().ui.read(), { ...DECISION_DEFAULTS });
});

test('connection test sends current unsaved fields and only the runtime config shape', async () => {
  const messages = [];
  let reply;
  const stored = { decisionMode: 'jev', jevApiKey: 'stored-secret', helperModel: 'helper-model' };
  const { fields, click } = init(stored, { sendMessage(message, callback) { messages.push(message); reply = callback; } });
  fields.get('jevApiKey').value = 'unsaved-secret';
  fields.get('jevHeaders').value = '{"X-Key":"header-secret"}';
  fields.get('jevRequestParams').value = '{"temperature":0}';
  fields.get('jevFallbackEnabled').checked = false;
  const promise = click();
  assert.equal(fields.get('jev-test-btn').disabled, true);
  assert.deepEqual(messages, [{
    type: 'test_jev_connection', config: {
      baseUrl: 'http://localhost:8765', apiKey: 'unsaved-secret', model: 'jev-latest',
      headers: { 'X-Key': 'header-secret' }, requestParams: { temperature: 0 }, timeoutMs: 1200000, fallbackEnabled: false,
    },
  }]);
  reply({ ok: true, message: 'unsaved-secret header-secret' });
  await promise;
  assert.equal(fields.get('jev-test-status').textContent, 'Jev connection successful.');
  assert.equal(fields.get('jev-test-btn').disabled, false);
  assert.deepEqual(toJevConnectionConfig(init(stored).ui.read()), {
    baseUrl: 'http://localhost:8765', apiKey: 'stored-secret', model: 'jev-latest',
    headers: {}, requestParams: {}, timeoutMs: 1200000, fallbackEnabled: true,
  });
});

test('connection failures, runtime errors, thrown errors, and absent responses never echo secrets', async () => {
  const runtimes = [
    { sendMessage(_, callback) { callback({ ok: false, error: 'secret-marker' }); } },
    { sendMessage(_, callback) { callback(undefined); } },
    { lastError: { message: 'secret-marker' }, sendMessage(_, callback) { callback({ ok: true }); } },
    { sendMessage() { throw new Error('secret-marker'); } },
  ];
  for (const runtime of runtimes) {
    const { fields, click } = init({ jevApiKey: 'secret-marker' }, runtime);
    await click();
    assert.match(fields.get('jev-test-status').textContent, /^Jev connection failed\./);
    assert.ok(!fields.get('jev-test-status').textContent.includes('secret-marker'));
    assert.equal(fields.get('jev-test-btn').disabled, false);
  }
});

test('connection validation blocks runtime calls and marks the field invalid', async () => {
  let calls = 0;
  const { fields, click } = init({}, { sendMessage() { calls++; } });
  fields.get('jevHeaders').value = '{"secret-marker":';
  await click();
  assert.equal(calls, 0);
  assert.equal(fields.get('jevHeaders').attributes.get('aria-invalid'), 'true');
  assert.equal(fields.get('jev-test-status').textContent, 'Jev headers must be valid JSON.');
  fields.get('jevHeaders').listeners.get('input')();
  assert.equal(fields.get('jevHeaders').attributes.has('aria-invalid'), false);
  assert.equal(fields.get('jev-test-status').textContent, '');
});

test('connection test recovers if the runtime never answers', async () => {
  const { fields, click } = init({ jevTimeoutMs: 1 });
  await click();
  assert.match(fields.get('jev-test-status').textContent, /^Jev connection failed\./);
  assert.equal(fields.get('jev-test-btn').disabled, false);
});

async function optionsPage(stored, failSave = false) {
  const document = documentStub();
  const writes = [];
  const runtime = {
    lastError: null, onMessage: { addListener() {} },
    sendMessage(message, callback) { if (message.type === 'oauth_status') callback({}); },
  };
  const chrome = {
    runtime, storage: { local: {
      get(keys, callback) { callback(stored); },
      set(items, callback) {
        if (failSave) runtime.lastError = { message: 'secret-marker' };
        else writes.push(items);
        callback();
        runtime.lastError = null;
      },
    } },
  };
  const context = vm.createContext({
    document, chrome, location: { hash: '' }, DECISION_STORAGE_KEYS, DecisionValidationError, initDecisionSettings,
    DEFAULT_PI_BRIDGE_CONFIG: { urls: ['ws://127.0.0.1:7878'] },
    readPiBridgeConfig: async () => ({ enabled: true, urls: ['ws://127.0.0.1:7878'] }),
    normalizePiBridgeConfig: config => config,
    // No browser or network input. Exercise successful live model-list loading too.
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'listed-model' }], models: [{ name: 'listed-model' }] }),
    }),
    setTimeout: () => 0, clearTimeout() {}, console: {
      error() { assert.fail('Options must not log credential-bearing errors'); },
      warn() { assert.fail('Options must not log credential-bearing errors'); },
    },
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, ''), context);
  await document.listeners.get('DOMContentLoaded')();
  return {
    document, writes,
    save: () => document.fields.get('save-btn').listeners.get('click')(),
    loadModels: vm.runInContext('loadModels', context),
  };
}

const normalSettings = {
  provider: 'openai-codex', apiKey: '', model: 'gpt-5.6-luna', baseUrl: '', inputBackend: 'native',
  reasoningLevel: 'high', maxIterations: 30, useVision: true,
};

test('unlisted saved gpt-6-luna stays selected after load and refresh and is saved unchanged for every provider', async () => {
  for (const provider of ['openai', 'anthropic', 'ollama', 'openrouter', 'nvidia', 'openai-codex', 'anthropic-oauth', 'gemini-cli']) {
    const settings = { ...normalSettings, provider, apiKey: 'test-key', model: 'gpt-6-luna', inputBackend: 'cdp' };
    const p = await optionsPage(settings);
    const select = p.document.fields.get('model-select');
    assert.equal(select.value, 'gpt-6-luna', `${provider} must keep the saved custom model`);
    assert.match(select.innerHTML, /<option value="gpt-6-luna">gpt-6-luna<\/option>/);
    assert.equal(p.document.fields.get('model-custom').style.display, 'none');
    await p.loadModels(provider, settings.apiKey, settings.baseUrl, select.value);
    assert.equal(select.value, 'gpt-6-luna', `${provider} refresh must keep the custom model`);
    await p.save();
    assert.equal(p.writes.length, 1);
    assert.equal(p.writes[0].model, 'gpt-6-luna', `${provider} save must not silently replace the model`);
    assert.equal(p.writes[0].provider, provider);
    assert.equal(p.writes[0].helperModel, '');
  }
});

test('actual options save persists parsed Jev settings alongside existing LLM credentials', async () => {
  const { document, writes, save } = await optionsPage(normalSettings);
  document.fields.get('decisionMode').value = 'jev';
  document.fields.get('jevApiKey').value = 'secret-marker';
  document.fields.get('jevHeaders').value = '{"X-Key":"secret-marker"}';
  document.fields.get('jevRequestParams').value = '{"temperature":0}';
  document.fields.get('jevFallbackEnabled').checked = false;
  document.fields.get('helperModel').value = 'custom-helper';
  await save();
  assert.equal(writes.length, 1);
  const saved = writes[0];
  assert.equal(saved.provider, normalSettings.provider);
  assert.equal(saved.model, normalSettings.model);
  assert.equal(saved.reasoningLevel, normalSettings.reasoningLevel);
  assert.equal(saved.maxIterations, 30);
  assert.equal(saved.decisionMode, 'jev');
  assert.equal(saved.jevApiKey, 'secret-marker');
  assert.deepEqual(saved.jevHeaders, { 'X-Key': 'secret-marker' });
  assert.deepEqual(saved.jevRequestParams, { temperature: 0 });
  assert.equal(saved.jevFallbackEnabled, false);
  assert.equal(saved.helperModel, 'custom-helper');
  assert.match(document.fields.get('save-confirm').textContent, /^Saved/);
});

test('Jev mode disables vision without changing or saving over the normal LLM preference', async () => {
  assert.match(html, /Use vision in normal LLM mode/);
  assert.match(html, /Jev sends screenshots on demand to the configured decision, fallback, and helper providers/);
  assert.match(html, /tools\/autojev-relay\.mjs/);
  assert.match(html, /http:\/\/localhost:8878/);
  assert.match(html, /allowlist your extension origin/);
  for (const preference of [false, true]) {
    const p = await optionsPage({ ...normalSettings, decisionMode: 'jev', useVision: preference });
    const vision = p.document.fields.get('useVision');
    const mode = p.document.fields.get('decisionMode');
    assert.equal(vision.disabled, true);
    assert.equal(vision.checked, preference);
    await p.save();
    assert.equal(p.writes.at(-1).useVision, preference);
    mode.value = 'llm';
    mode.listeners.get('change')();
    assert.equal(vision.disabled, false);
    assert.equal(vision.checked, preference);
    vision.checked = !preference;
    mode.value = 'jev';
    mode.listeners.get('change')();
    assert.equal(vision.disabled, true);
    assert.equal(vision.checked, !preference);
    await p.save();
    assert.equal(p.writes.at(-1).useVision, !preference);
    mode.value = 'llm';
    mode.listeners.get('change')();
    assert.equal(vision.disabled, false);
    assert.equal(vision.checked, !preference);
  }
});

test('actual options save validates first, leaves LLM controls available, and suppresses storage errors', async () => {
  const page = await optionsPage(normalSettings);
  page.document.fields.get('jevRequestParams').value = '{"images":["secret-marker"]}';
  await page.save();
  assert.equal(page.writes.length, 0);
  assert.match(page.document.fields.get('save-confirm').textContent, /cannot override/);
  assert.equal(page.document.fields.get('model-select').disabled, false);
  assert.notEqual(page.document.fields.get('model-group').style.display, 'none');

  const failure = await optionsPage(normalSettings, true);
  await failure.save();
  assert.equal(failure.writes.length, 0);
  assert.equal(failure.document.fields.get('save-confirm').textContent, 'Failed to save settings. Try again.');
});
