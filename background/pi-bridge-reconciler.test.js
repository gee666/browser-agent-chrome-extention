import test from 'node:test';
import assert from 'node:assert/strict';

import { createPiBridgeReconciler } from './pi-bridge-reconciler.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(refreshBridge) {
  const effects = [];
  const reconcile = createPiBridgeReconciler({
    refreshBridge,
    setRuntimeEnabled: async (enabled) => effects.push(['runtime', enabled]),
    ensureReconnectAlarm: async () => effects.push(['alarm', 'ensure']),
    clearReconnectAlarm: async () => effects.push(['alarm', 'clear']),
    startKeepaliveLoop: () => effects.push(['loop', 'start']),
    stopKeepaliveLoop: () => effects.push(['loop', 'stop']),
    logger: { error() {} },
  });
  return { reconcile, effects };
}

test('coalesces boot requests and serializes the complete reconciliation', async () => {
  const firstRefresh = deferred();
  let refreshes = 0;
  const { reconcile, effects } = makeHarness(async () => {
    refreshes += 1;
    if (refreshes === 1) return firstRefresh.promise;
    return { config: { enabled: false } };
  });

  const first = reconcile();
  const second = reconcile();
  assert.equal(first, second);
  assert.equal(refreshes, 1, 'a second refresh must not start during first reconciliation');

  firstRefresh.resolve({ config: { enabled: true } });
  await first;

  assert.equal(refreshes, 2, 'requests received while running coalesce into one follow-up');
  assert.deepEqual(effects, [
    ['alarm', 'ensure'], ['runtime', true], ['loop', 'start'],
    ['runtime', false], ['loop', 'stop'], ['alarm', 'clear'],
  ]);
});

test('an unknown null refresh preserves only the retry alarm', async () => {
  const { reconcile, effects } = makeHarness(async () => null);

  await reconcile();

  assert.deepEqual(effects, [['alarm', 'ensure']]);
});

test('a failed refresh preserves the retry alarm while state is unknown', async () => {
  const { reconcile, effects } = makeHarness(async () => {
    throw new Error('storage unavailable');
  });

  await reconcile();

  assert.deepEqual(effects, [['alarm', 'ensure']]);
});

test('null refresh preserves an alarm after enabled state was last known', async () => {
  const results = [{ config: { enabled: true } }, null];
  const { reconcile, effects } = makeHarness(async () => results.shift());

  await reconcile();
  await reconcile();

  assert.deepEqual(effects.filter(([kind]) => kind === 'alarm'), [
    ['alarm', 'ensure'],
    ['alarm', 'ensure'],
  ]);
});

test('null and failed refreshes do not recreate an alarm after disabled state was known', async () => {
  let refresh = 0;
  const { reconcile, effects } = makeHarness(async () => {
    refresh += 1;
    if (refresh === 1) return { config: { enabled: false } };
    if (refresh === 2) return null;
    throw new Error('storage unavailable');
  });

  await reconcile();
  await reconcile();
  await reconcile();

  assert.deepEqual(effects.filter(([kind]) => kind === 'alarm'), [
    ['alarm', 'clear'],
  ]);
});

test('enabled startup arms the retry alarm before runtime initialization', async () => {
  const effects = [];
  const reconcile = createPiBridgeReconciler({
    refreshBridge: async () => ({ config: { enabled: true } }),
    ensureReconnectAlarm: async () => effects.push('alarm'),
    setRuntimeEnabled: async () => {
      effects.push('runtime');
      throw new Error('startup failed');
    },
    clearReconnectAlarm: async () => effects.push('clear'),
    startKeepaliveLoop: () => effects.push('start'),
    stopKeepaliveLoop: () => effects.push('stop'),
    logger: { error() {} },
  });

  await reconcile();

  assert.deepEqual(effects, ['alarm', 'runtime']);
});

test('reconnect alarm exists only while the bridge is enabled', async () => {
  const configs = [{ enabled: true }, { enabled: false }];
  const { reconcile, effects } = makeHarness(async () => ({ config: configs.shift() }));

  await reconcile();
  await reconcile();

  assert.deepEqual(effects.filter(([kind]) => kind === 'alarm'), [
    ['alarm', 'ensure'],
    ['alarm', 'clear'],
  ]);
});
