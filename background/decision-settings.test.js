import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_CONFIG_KEYS, decisionOptions, appendDiscoveryReport } from './decision-settings.js';

test('normal mode preserves configured provider and defaults', () => {
  const llm = {};
  const result = decisionOptions({}, () => assert.fail('unexpected provider'), llm);
  assert.equal(result.decisionMode, 'llm');
  assert.equal(result.helperLlm, llm);
  assert.equal(result.decisionConfig.timeoutMs, 1200000);
  assert.equal(result.decisionConfig.fallbackEnabled, true);
  assert.ok(DECISION_CONFIG_KEYS.includes('jevApiKey'));
});

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
