import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { InputControlBridge, NativeScriptService } from '../lib/browser-agent-core/background/index.js';
import { CdpInputControlBridge } from '../lib/browser-agent-input-control/index.js';
import { createConfiguredInputControl, createNativeScriptProvider, createNativeScriptRuntime } from './native-script-runtime.js';
import { createJsNavigationDestructiveHandlers } from '../lib/pi-browser-agent-bridge/src/handlers/js-navigation-family.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const request = () => ({
  tabId: 42, kind: 'expression', source: 'document.title', args: [],
  awaitPromise: true, returnByValue: true, captureConsole: false,
  timeoutMs: 1000, signal: new AbortController().signal,
});

test('script translation uses the normal configured LLM with Jev disabled and its helper LLM with Jev enabled', () => {
  for (const decisionMode of [undefined, 'llm', 'jev']) {
    const configs = [];
    const config = {
      decisionMode, provider: 'openai-codex', model: 'main-model',
      helperModel: '  helper-model  ', reasoningLevel: 'high', apiKey: 'preserved',
    };
    const llm = createNativeScriptProvider(config, (value) => {
      configs.push(value);
      return { config: value, complete() {} };
    });
    const expectedModel = decisionMode === 'jev' ? 'helper-model' : 'main-model';
    assert.equal(llm.config.model, expectedModel);
    assert.equal(llm.config.provider, 'openai-codex');
    assert.equal(llm.config.apiKey, 'preserved');
    assert.equal(llm.config.reasoningLevel, 'high');
    assert.equal(typeof llm.complete, 'function');
    assert.equal(configs.length, decisionMode === 'jev' ? 2 : 1);
    assert.equal(config.model, 'main-model', 'selection must not mutate stored configuration');
  }
  const llm = createNativeScriptProvider({ decisionMode: 'jev', model: 'main', helperModel: ' ' }, (config) => ({ config }));
  assert.equal(llm.config.model, 'main');
  assert.throws(() => createNativeScriptProvider({ decisionMode: 'invalid' }, () => ({})), /Invalid decision mode/);
});

test('shared input factory honors CDP, Python, and the default without connecting Python', () => {
  assert.ok(createConfiguredInputControl({ inputBackend: 'cdp' }) instanceof CdpInputControlBridge);
  assert.ok(createConfiguredInputControl() instanceof CdpInputControlBridge);
  assert.ok(createConfiguredInputControl({ inputBackend: 'native' }) instanceof InputControlBridge);
  assert.throws(() => createConfiguredInputControl({ inputBackend: 'unknown' }), { code: 'E_INPUT_BACKEND' });
});

test('configuration is loaded once per request and passed to both provider and input factory', async () => {
  let config = { inputBackend: 'cdp', model: 'first' };
  let loads = 0;
  const selected = [];
  const runtime = createNativeScriptRuntime({
    loadConfiguration: async () => { loads++; return config; },
    loadProvider: (value) => { assert.equal(value, config); return {}; },
    createInputControl: ({ config: value, tabId }) => {
      assert.equal(value, config);
      assert.equal(tabId, 42);
      const input = createConfiguredInputControl(value);
      selected.push(input.constructor);
      return input;
    },
    createService: () => ({ executeExternalScript: async () => ({ type: 'undefined' }) }),
  });
  await runtime.executeExternalScript(request());
  config = { inputBackend: 'native', model: 'second' };
  await runtime.executeExternalScript(request());
  assert.equal(loads, 2);
  assert.deepEqual(selected, [CdpInputControlBridge, InputControlBridge]);
});

test('script runtime forwards its trusted input interface and current provider with the complete request', async () => {
  const llm = {};
  let providerLoads = 0;
  const calls = [];
  const runtime = createNativeScriptRuntime({
    async loadProvider() { providerLoads++; return llm; },
    createService(options) {
      assert.equal(options.llm, llm);
      assert.ok(options.inputControl instanceof InputControlBridge);
      assert.equal(options.inputControl.constructor, InputControlBridge);
      const originalDisconnect = options.inputControl.disconnect.bind(options.inputControl);
      options.inputControl.disconnect = () => { calls.push('disconnect'); originalDisconnect(); };
      return {
        async executeExternalScript(value) {
          calls.push(value);
          assert.equal(runtime.busy, true);
          return { type: 'string', value: 'Example' };
        },
      };
    },
  });
  const first = request();
  assert.deepEqual(await runtime.executeExternalScript(first), { type: 'string', value: 'Example' });
  assert.equal(calls[0], first);
  assert.equal(calls[1], 'disconnect');
  assert.equal(runtime.busy, false);
  await runtime.executeExternalScript(request());
  assert.equal(providerLoads, 2, 'provider configuration must be refreshed for each request');
});

test('translated CDP click and key input works when no Python host is installed', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { connectNative() { assert.fail('CDP must not connect to Python'); } } };
  const commands = [];
  const context = { screenX: 0, screenY: 0, outerHeight: 900, innerHeight: 800,
    outerWidth: 1000, innerWidth: 1000, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
  const state = { context, width: 1000, height: 800, url: 'https://example.test/',
    visible: true, editable: true, x: 100, y: 100 };
  const transport = {
    async send(tabId, method, params) { commands.push({ tabId, method, params }); return {}; },
    async detach() {}, dispose() {},
  };
  const runtime = createNativeScriptRuntime({
    loadConfiguration: async () => ({ inputBackend: 'cdp' }),
    loadProvider: async () => ({ complete: async () => JSON.stringify({ version: 1,
      steps: [{ op: 'click', selector: '#button' }, { op: 'key', key: 'Enter' }],
      result: { kind: 'undefined' },
    }) }),
    createInputControl({ config, tabId }) {
      assert.equal(config.inputBackend, 'cdp');
      return new CdpInputControlBridge({ bridge: { getActiveTabId: () => tabId }, transport });
    },
    createService: (options) => new NativeScriptService({ ...options, page: {
      snapshot: async () => state, target: async () => state, assertActive: async () => {},
    } }),
  });
  try {
    const result = await runtime.executeExternalScript(request());
    assert.equal(result.type, 'undefined');
    assert.ok(commands.length >= 4);
    assert.ok(commands.every(({ tabId, method }) => tabId === 42 && ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(method)));
    assert.deepEqual(commands.filter(({ method, params }) => method === 'Input.dispatchMouseEvent' && params.type !== 'mouseMoved').map(({ params }) => params.type), ['mousePressed', 'mouseReleased']);
    assert.deepEqual(commands.filter(({ method }) => method === 'Input.dispatchKeyEvent').map(({ params }) => params.type), ['keyDown', 'keyUp']);
    assert.equal(runtime.busy, false);
  } finally { globalThis.chrome = previousChrome; }
});

test('default core service translates reads through the selected LLM in both decision modes', async () => {
  const previousChrome = globalThis.chrome;
  const inspections = [];
  const completions = [];
  globalThis.chrome = {
    runtime: { connectNative() { assert.fail('read-only plans must not issue native input'); } },
    scripting: {
      async executeScript(options) {
        inspections.push(options);
        assert.equal(options.world, 'ISOLATED');
        assert.equal(options.target.tabId, 42);
        assert.equal(typeof options.func, 'function');
        assert.deepEqual(options.args, [{ op: 'read', id: 'title', property: 'title' }]);
        return [{ result: 'Example title' }];
      },
    },
  };
  try {
    for (const decisionMode of ['llm', 'jev']) {
      const runtime = createNativeScriptRuntime({
        loadProvider: async () => createNativeScriptProvider({ decisionMode, model: 'normal', helperModel: 'helper' }, (config) => ({
          async complete(options) {
            completions.push({ model: config.model, options });
            return JSON.stringify({ version: 1,
              steps: [{ op: 'read', id: 'title', property: 'title' }],
              result: { kind: 'ref', id: 'title' },
            });
          },
        })),
      });
      const result = await runtime.executeExternalScript(request());
      assert.equal(result.value, 'Example title');
      assert.equal(result.type, 'string');
      const completion = completions.at(-1);
      assert.equal(completion.model, decisionMode === 'jev' ? 'helper' : 'normal');
      assert.equal(JSON.parse(completion.options.messages[0].content).source, 'document.title');
      assert.equal(runtime.busy, false);
    }
    assert.equal(inspections.length, 2);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('global script ownership covers provider setup, translation, execution, and all tab IDs', async () => {
  const provider = deferred();
  const execution = deferred();
  const runtime = createNativeScriptRuntime({
    loadProvider: () => provider.promise,
    createService: () => ({ executeExternalScript: () => execution.promise }),
  });
  const first = runtime.executeExternalScript(request());
  assert.equal(runtime.busy, true);
  await assert.rejects(runtime.executeExternalScript({ ...request(), tabId: 99 }), { code: 'E_BUSY' });
  provider.resolve({});
  await Promise.resolve();
  await assert.rejects(runtime.executeExternalScript(request()), { code: 'E_BUSY' });
  execution.resolve({ type: 'undefined', value: undefined });
  await first;
  assert.equal(runtime.busy, false);
});

test('asynchronous backend cleanup finishes before ownership is released', async () => {
  const cleanup = deferred();
  const started = deferred();
  const runtime = createNativeScriptRuntime({
    loadProvider: async () => ({}),
    createInputControl: () => ({ disconnect() { started.resolve(); return cleanup.promise; } }),
    createService: () => ({ executeExternalScript: async () => ({ type: 'undefined' }) }),
  });
  const run = runtime.executeExternalScript(request());
  await started.promise;
  assert.equal(runtime.busy, true);
  await assert.rejects(runtime.executeExternalScript(request()), { code: 'E_BUSY' });
  cleanup.resolve();
  await run;
  assert.equal(runtime.busy, false);
});

test('a running task rejects external scripts before provider setup', async () => {
  const runtime = createNativeScriptRuntime({
    isTaskRunning: () => true,
    loadProvider() { assert.fail('must not load provider while a task owns input'); },
  });
  await assert.rejects(runtime.executeExternalScript(request()), { code: 'E_BUSY' });
  assert.equal(runtime.busy, false);
});

test('cancellation during provider setup cannot create a native connection or execute later', async () => {
  const provider = deferred();
  const controller = new AbortController();
  const aborted = Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' });
  const runtime = createNativeScriptRuntime({
    loadProvider: () => provider.promise,
    createInputControl() { assert.fail('cancelled request must never connect'); },
    createService() { assert.fail('cancelled request must never execute'); },
  });
  const run = runtime.executeExternalScript({ ...request(), signal: controller.signal });
  controller.abort(aborted);
  provider.resolve({});
  await assert.rejects(run, (error) => error === aborted);
  assert.equal(runtime.busy, false);
  await assert.rejects(runtime.executeExternalScript({ ...request(), signal: controller.signal }), (error) => error === aborted);
});

test('active native input is aborted on cancellation and disconnected before releasing ownership', async () => {
  const controller = new AbortController();
  const calls = [];
  const started = deferred();
  const runtime = createNativeScriptRuntime({
    loadProvider: async () => ({}),
    createInputControl: () => ({
      abort() { calls.push('abort'); },
      disconnect() { calls.push('disconnect'); assert.equal(runtime.busy, true); },
    }),
    createService: () => ({
      executeExternalScript({ signal }) {
        started.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    }),
  });
  const run = runtime.executeExternalScript({ ...request(), signal: controller.signal });
  await started.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(run, /cancelled/);
  assert.deepEqual(calls, ['abort', 'disconnect']);
  assert.equal(runtime.busy, false);
});

test('bridge request timeout aborts an in-flight Python native host command', async () => {
  const previousChrome = globalThis.chrome;
  const commands = [];
  let disconnected = 0;
  const port = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) { commands.push(message.command); },
    disconnect() { disconnected++; },
  };
  globalThis.chrome = { runtime: {
    connectNative(name) {
      assert.equal(name, 'com.workshop.python_input_control');
      return port;
    },
  } };
  const runtime = createNativeScriptRuntime({
    loadProvider: async () => ({}),
    createService({ inputControl }) {
      return {
        _inputControl: inputControl,
        async executeExternalScript() {
          await this._inputControl.execute('type', { text: 'native text' }, {});
          assert.fail('timed-out native input must not complete or issue another action');
        },
      };
    },
  });
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi: { async get() { return { id: 42 }; } },
    executeExternalScript: (value) => runtime.executeExternalScript(value),
  });
  try {
    await assert.rejects(handlers.browser_run_js({ code: 'input.value = "native text";', tab_id: 42, timeout_ms: 10 }), { code: 'E_TIMEOUT' });
    // The abort rejects the pending native promise. Allow its finally block
    // to disconnect before checking global ownership.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(commands, ['type']);
    assert.equal(disconnected, 1);
    assert.equal(runtime.busy, false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('provider and native execution failures release ownership without a fallback', async () => {
  const failure = Object.assign(new Error('native failed'), { code: 'E_NATIVE' });
  let stage = 'provider';
  let disconnected = 0;
  const runtime = createNativeScriptRuntime({
    async loadProvider() { if (stage === 'provider') throw failure; return {}; },
    createInputControl: () => ({ disconnect() { disconnected++; } }),
    createService: () => ({ async executeExternalScript() { throw failure; } }),
  });
  await assert.rejects(runtime.executeExternalScript(request()), (error) => error === failure);
  assert.equal(runtime.busy, false);
  stage = 'execution';
  await assert.rejects(runtime.executeExternalScript(request()), (error) => error === failure);
  assert.equal(runtime.busy, false);
  assert.equal(disconnected, 1);
});

test('service worker wires scripts to the native runtime and prevents tasks from taking its lock', async () => {
  const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
  assert.match(source, /loadConfiguration: loadAgentConfig/);
  assert.match(source, /loadProvider: \(config\) => createNativeScriptProvider\(config, createProvider\)/);
  assert.match(source, /inputBackend: config\.inputBackend \|\| DEFAULT_INPUT_BACKEND/);
  assert.match(source, /createConfiguredInputControl as createInputControl/);
  assert.match(source, /isTaskRunning: \(\) => currentTaskRun !== null/);
  assert.match(source, /executeExternalScript: \(request\) => nativeScriptRuntime\.executeExternalScript\(request\)/);
  assert.match(source, /if \(nativeScriptRuntime\.busy\)\s*\{\s*throw createTaskError\('E_BUSY'/);
});
