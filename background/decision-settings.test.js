import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_CONFIG_KEYS, decisionOptions, appendDiscoveryReport } from './decision-settings.js';
import { DECISION_STORAGE_KEYS } from '../options/decision-settings.js';
import * as core from '../lib/browser-agent-core/background/index.js';
const { normalizeJevConfig } = core;

test('normal mode preserves configured provider and defaults', () => {
  const llm = {};
  const result = decisionOptions({}, () => assert.fail('unexpected provider'), llm);
  assert.equal(result.decisionMode, 'llm');
  assert.equal(result.helperLlm, llm);
  assert.equal(result.decisionConfig.timeoutMs, 1200000);
  assert.equal(result.decisionConfig.fallbackEnabled, true);
  assert.ok(DECISION_CONFIG_KEYS.includes('jevApiKey'));
  assert.ok(DECISION_CONFIG_KEYS.includes('jevCacheMode'));
  assert.equal(result.decisionConfig.cacheMode, 'context');
  assert.deepEqual([...DECISION_CONFIG_KEYS].sort(), [...DECISION_STORAGE_KEYS].sort());
});

for (const decisionMode of [undefined, 'llm']) {
  for (const useVision of [false, true]) {
    test(`normal LLM task works without Jev: mode=${decisionMode}, vision=${useVision}`, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => {
        assert.fail('Normal LLM mode must not contact Jev');
      });
      const llm = { complete: async () => JSON.stringify({ action: { done: { success: true, message: 'LLM task completed' } } }) };
      const helperLlm = { complete: () => assert.fail('Unused Jev helper must not run') };
      const decisions = decisionOptions({
        decisionMode,
        // Even stale, invalid Jev settings must not affect normal tasks.
        jevBaseUrl: 'not-a-url', jevCacheMode: 'invalid', jevTimeoutMs: -1,
        helperModel: 'unused-helper',
      }, () => assert.fail('Normal mode must not create a Jev helper provider'), llm);
      assert.equal(decisions.decisionMode, 'llm');
      assert.equal(decisions.helperLlm, llm);
      let screenshots = 0;
      const agent = new core.AgentCore({
        ...decisions, llm, helperLlm, useVision,
        bridge: {
          getActiveTabId: async () => 1,
          getPageState: async () => ({ url: 'https://example.com', title: 'Test', domText: 'Ready', elements: [], context: {} }),
          takeScreenshot: async () => { screenshots++; return null; },
          sendStatus() {},
        },
        executor: { execute: () => assert.fail('Done must not issue input') },
      });
      assert.equal(await agent.run('Finish the task'), 'LLM task completed');
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(screenshots, useVision ? 1 : 0);
    });
  }
}

test('Jev settings map without losing false and provider auth settings', () => {
  const config = { decisionMode: 'jev', provider: 'openai-codex', model: 'primary', helperModel: ' gpt-6-luna ', jevBaseUrl: 'http://localhost:8765', jevApiKey: 'local-test', jevHeaders: { 'X-App': 'extension' }, jevRequestParams: { custom: 1 }, jevTimeoutMs: 1234, jevFallbackEnabled: false };
  const result = decisionOptions(config, c => c, {});
  assert.equal(result.helperLlm.provider, 'openai-codex');
  assert.equal(result.helperLlm.model, 'gpt-6-luna');
  assert.equal(result.decisionConfig.apiKey, 'local-test');
  assert.equal(result.decisionConfig.fallbackEnabled, false);
  assert.equal(result.decisionConfig.timeoutMs, 1234);
  assert.deepEqual(result.decisionConfig.headers, { 'X-App': 'extension' });
});

test('runtime maps each stored cache selector and retains legacy headers and provider config', () => {
  for (const jevCacheMode of ['server', 'none', 'options', 'context']) {
    const llm = {};
    const config = { decisionMode: 'jev', provider: 'openai-codex', model: 'saved-model', apiKey: 'provider-key',
      baseUrl: 'https://provider.example', inputBackend: 'cdp', jevCacheMode,
      jevApiKey: 'jev-key', jevHeaders: { 'X-AutoJev-Prefix-Cache': 'true' } };
    const before = structuredClone(config);
    const result = decisionOptions(config, () => assert.fail('unexpected provider'), llm);
    assert.equal(result.helperLlm, llm);
    assert.equal(result.decisionConfig.cacheMode, jevCacheMode);
    if (normalizeJevConfig) assert.equal(normalizeJevConfig(result.decisionConfig).cacheMode, jevCacheMode);
    assert.deepEqual(result.decisionConfig.headers, config.jevHeaders);
    assert.deepEqual(config, before);
  }
});

test('existing stored Jev settings request context without mutating storage', () => {
  const config = { decisionMode: 'jev', jevApiKey: 'stored-key', jevHeaders: { 'X-AutoJev-Prefix-Cache': 'false' } };
  const before = structuredClone(config);
  const result = decisionOptions(config, () => {}, {});
  assert.equal(result.decisionConfig.cacheMode, 'context');
  assert.deepEqual(result.decisionConfig.headers, config.jevHeaders);
  assert.deepEqual(config, before);
});

test('invalid stored cache modes reach core validation rather than silently changing behavior', { skip: !normalizeJevConfig && 'Published core has no Jev runtime' }, () => {
  for (const jevCacheMode of ['', 'CONTEXT', false, 1, 'invalid']) {
    const result = decisionOptions({ decisionMode: 'jev', jevCacheMode }, () => {}, {});
    assert.throws(() => normalizeJevConfig(result.decisionConfig), /Invalid Jev cache mode/);
  }
});

test('unknown modes fail rather than silently changing behavior', () => {
  assert.throws(() => decisionOptions({ decisionMode: 'unknown' }, () => {}, {}));
});

test('discovery reports update by identity and retain only 50', () => {
  const entries = Array.from({ length: 50 }, (_, n) => ({ discoveryId: String(n), executionResult: 'resolved' }));
  const next = appendDiscoveryReport(entries, { discoveryId: '49', executionResult: 'executed' });
  assert.equal(next.length, 50);
  assert.equal(next.at(-1).executionResult, 'executed');
  assert.equal(entries.at(-1).executionResult, 'resolved');
  assert.equal(appendDiscoveryReport(next, { discoveryId: '50' })[0].discoveryId, '1');
  assert.throws(() => appendDiscoveryReport([], { reason: 'x'.repeat(50001) }));
});
