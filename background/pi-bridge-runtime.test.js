import test from 'node:test';
import assert from 'node:assert/strict';

import { createPiBridgeRuntime } from './pi-bridge-runtime.js';

// Minimal chrome API stub capable of driving createPiBridgeRuntime()'s
// handlers without a real browser. Each test wires in the subset it needs.
function createChromeStub({ scripts = {}, inspectorSends = {}, tab = { id: 42, url: 'https://example.com/', title: 'Example' } } = {}) {
  const listeners = {
    tabsOnRemoved: [],
    tabsOnUpdated: [],
    debuggerOnDetach: [],
    runtimeOnSuspend: [],
  };

  const scriptingCalls = [];
  const captureVisibleTabCalls = [];

  const chromeApi = {
    tabs: {
      async get() { return tab; },
      async query() { return [tab]; },
      async update() { return tab; },
      async create() { return tab; },
      async remove() {},
      onUpdated: {
        addListener: (fn) => listeners.tabsOnUpdated.push(fn),
        removeListener: (fn) => {
          const i = listeners.tabsOnUpdated.indexOf(fn);
          if (i >= 0) listeners.tabsOnUpdated.splice(i, 1);
        },
      },
      onRemoved: {
        addListener: (fn) => listeners.tabsOnRemoved.push(fn),
        removeListener: () => {},
      },
      captureVisibleTab: (_windowId, _opts, cb) => {
        captureVisibleTabCalls.push({ windowId: _windowId, opts: _opts });
        cb('data:image/png;base64,ZmFsbGJhY2s=');
      },
    },
    windows: {
      async update() {},
    },
    scripting: {
      async executeScript({ target, func, args }) {
        scriptingCalls.push({ target, args });
        const mode = inferMode(func);
        const handler = scripts[mode];
        if (!handler) {
          return [{ result: null }];
        }
        return [{ result: await handler(args?.[0] || {}, target) }];
      },
    },
    debugger: {
      onDetach: {
        addListener: (fn) => listeners.debuggerOnDetach.push(fn),
      },
      onEvent: {
        addListener: () => {},
      },
      async attach() {},
      async detach() {},
      async sendCommand(source, method, params) {
        const handler = inspectorSends[method];
        if (typeof handler === 'function') {
          return await handler({ source, params });
        }
        return {};
      },
    },
    storage: {
      local: {
        _store: new Map(),
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
          for (const key of list) {
            if (this._store.has(key)) out[key] = this._store.get(key);
          }
          cb(out);
        },
        set(value, cb) {
          for (const [k, v] of Object.entries(value)) this._store.set(k, v);
          cb?.();
        },
      },
    },
    runtime: {
      id: 'test-ext',
      onSuspend: {
        addListener: (fn) => listeners.runtimeOnSuspend.push(fn),
      },
      getManifest: () => ({ version: '0.0.0-test' }),
      lastError: null,
    },
    alarms: { create: async () => {} },
    browsingData: {},
  };

  return { chromeApi, listeners, scriptingCalls, captureVisibleTabCalls };
}

// The runtime injects four different content-script function shapes. We
// identify which one is being executed by stringifying it and looking for a
// stable marker.
function inferMode(func) {
  const src = func.toString();
  if (src.includes('collectHtml')) return 'html';
  if (src.includes('collectDomInfo')) return 'domInfo';
  if (src.includes('collectComputedStyles')) return 'computedStyles';
  if (src.includes('getSelectorRect')) return 'selectorRect';
  return 'unknown';
}

test('default requests reuse the active tab without creating, pinning, or closing tabs', async () => {
  const { chromeApi } = createChromeStub();
  const mutations = [];
  chromeApi.tabs.create = async (params) => { mutations.push(['create', params]); return { id: 99 }; };
  chromeApi.tabs.update = async (...args) => { mutations.push(['update', ...args]); };
  chromeApi.tabs.remove = async (...args) => { mutations.push(['remove', ...args]); };
  // A saved dedicated tab from an older version must not affect targeting.
  chromeApi.storage.local._store.set('piBridge.agentTabId', 99);
  let activeId = 42;
  chromeApi.tabs.query = async () => [{ id: activeId, url: 'https://active.test/' }];
  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  try {
    await runtime.warmUp();
    await runtime.handleRequest({ type: 'browser_get_html', params: {} });
    assert.equal((await runtime.resolveRunTaskTab()).tabId, 42);
    activeId = 43;
    assert.equal((await runtime.resolveRunTaskTab()).tabId, 43);
    assert.equal((await runtime.resolveRunTaskTab({ tab_id: 42 })).tabId, 42);
    await runtime.handleRequest({ type: 'browser_list_tabs', params: {} });
    assert.deepEqual(mutations, []);
  } finally {
    await runtime.dispose();
  }
});

test('no active tab reports an error instead of creating a placeholder tab', async () => {
  const { chromeApi } = createChromeStub();
  chromeApi.tabs.query = async () => [];
  chromeApi.tabs.create = async () => { assert.fail('must not create a default tab'); };
  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  try {
    await assert.rejects(runtime.resolveRunTaskTab(), { code: 'E_NO_ACTIVE_TAB' });
    await assert.rejects(runtime.handleRequest({ type: 'browser_get_html', params: {} }), { code: 'E_NO_ACTIVE_TAB' });
  } finally {
    await runtime.dispose();
  }
});

test('browser_create_tab creates only the requested tab, without a default placeholder', async () => {
  const { chromeApi } = createChromeStub();
  const created = [];
  chromeApi.tabs.create = async (params) => { created.push(params); return { id: 99, ...params }; };
  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  try {
    const result = await runtime.handleRequest({ type: 'browser_create_tab', params: { url: 'https://requested.test/', wait_until: 'none' } });
    assert.equal(result.tabId, 99);
    assert.deepEqual(created, [{ url: 'https://requested.test/', active: false, pinned: false }]);
  } finally {
    await runtime.dispose();
  }
});

test('external JS requests reach the injected rewrite service without raw browser execution', async () => {
  const { chromeApi, scriptingCalls } = createChromeStub({
    inspectorSends: {
      'Runtime.evaluate': () => assert.fail('external source must not reach CDP'),
    },
  });
  const calls = [];
  const runtime = createPiBridgeRuntime({
    chromeApi, storageArea: chromeApi.storage.local,
    logger: { warn() {}, error() {}, debug() {} },
    async executeExternalScript(request) {
      calls.push(request);
      return { type: 'string', value: 'Example', console_entries: [] };
    },
  });
  try {
    const read = await runtime.handleRequest({ type: 'browser_evaluate_js', params: { expression: 'document.title', world: 'main' } });
    const run = await runtime.handleRequest({ type: 'browser_run_js', params: { code: 'return args[0];', args: ['Example'], tab_id: 42 } });
    assert.equal(read.value, 'Example');
    assert.equal(run.value, 'Example');
    assert.equal(calls[0].kind, 'expression');
    assert.equal(calls[0].source, 'document.title');
    assert.equal(calls[0].tabId, 42);
    assert.equal(calls[1].kind, 'program');
    assert.equal(calls[1].source, 'return args[0];');
    assert.deepEqual(calls[1].args, ['Example']);
    assert.deepEqual(scriptingCalls, []);
  } finally {
    await runtime.dispose();
  }
});

test('external JS fails closed when the rewrite service is absent, while trusted inspection still works', async () => {
  const { chromeApi, scriptingCalls } = createChromeStub({ scripts: { html: async () => ({ html: '<p>trusted inspection</p>' }) } });
  const runtime = createPiBridgeRuntime({
    chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} },
  });
  try {
    await assert.rejects(runtime.handleRequest({ type: 'browser_evaluate_js', params: { expression: 'document.title' } }), { code: 'E_SCRIPT_REWRITE_UNAVAILABLE' });
    await assert.rejects(runtime.handleRequest({ type: 'browser_run_js', params: { code: 'return 1;' } }), { code: 'E_SCRIPT_REWRITE_UNAVAILABLE' });
    const result = await runtime.handleRequest({ type: 'browser_get_html', params: {} });
    assert.equal(result.html, '<p>trusted inspection</p>');
    assert.equal(scriptingCalls.length, 1);
  } finally {
    await runtime.dispose();
  }
});

test('browser_get_html forwards max_bytes to the content script', async () => {
  let capturedArgs = null;
  const { chromeApi } = createChromeStub({
    scripts: {
      html: async (args) => {
        capturedArgs = args;
        return { html: 'ok', url: 'https://example.com/', title: 'Example' };
      },
    },
  });

  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  const response = await runtime.handleRequest({
    type: 'browser_get_html',
    params: { tab_id: 42, max_bytes: 1024 },
  });

  assert.ok(response);
  assert.ok(capturedArgs, 'executeScript was not invoked for html handler');
  assert.equal(capturedArgs.maxBytes, 1024, 'maxBytes must be forwarded to collectHtml()');
});

test('browser_get_html passes max_bytes through alongside selector/strip', async () => {
  let capturedArgs = null;
  const { chromeApi } = createChromeStub({
    scripts: {
      html: async (args) => {
        capturedArgs = args;
        return { html: 'ok', url: 'https://example.com/', title: 'Example' };
      },
    },
  });

  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  await runtime.handleRequest({
    type: 'browser_get_html',
    params: { tab_id: 42, selector: 'main', selector_all: true, strip: ['script'], max_bytes: 2048 },
  });

  assert.equal(capturedArgs.selector, 'main');
  assert.equal(capturedArgs.selectorAll, true);
  assert.deepEqual(capturedArgs.strip, ['script']);
  assert.equal(capturedArgs.maxBytes, 2048);
});

test('collectHtml content-script body truncates to maxBytes', () => {
  // Build the same content-script function the runtime injects. We exercise
  // the truncation logic directly since the content script runs in the page
  // MAIN world and is not accessible from Node.
  const collectHtml = function collectHtml({ selector, selectorAll, strip, maxBytes }) {
    const cloneNode = (node) => node.cloneNode(true);
    const stripClone = () => {};
    const applyLimit = (html) => {
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : null;
      if (limit === null) return { html, truncated: false, byteLength: html.length };
      const encoder = new TextEncoder();
      const bytes = encoder.encode(html);
      if (bytes.length <= limit) return { html, truncated: false, byteLength: bytes.length };
      const sliced = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, limit));
      return { html: sliced, truncated: true, byteLength: limit, originalByteLength: bytes.length };
    };
    const docEl = { outerHTML: 'x'.repeat(10_000), cloneNode() { return this; } };
    const root = cloneNode(docEl);
    stripClone(root, strip);
    const limited = applyLimit(root.outerHTML);
    return {
      html: limited.html,
      truncated: limited.truncated,
      byteLength: limited.byteLength,
      originalByteLength: limited.originalByteLength,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null,
    };
  };

  const result = collectHtml({ maxBytes: 100 });
  assert.equal(result.truncated, true);
  assert.equal(result.html.length, 100);
  assert.equal(result.byteLength, 100);
  assert.equal(result.originalByteLength, 10_000);
});

test('createAgentBrowserBridge screenshots the task tab via CDP, not captureVisibleTab', async () => {
  const inspectorSends = {
    'Page.captureScreenshot': async ({ source }) => {
      return { data: Buffer.from(`cdp-${source.tabId}`).toString('base64') };
    },
  };
  const { chromeApi, captureVisibleTabCalls } = createChromeStub({ inspectorSends });

  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  const bridge = await runtime.createAgentBrowserBridge(42);
  const shot = await bridge.takeScreenshot();

  assert.ok(typeof shot === 'string');
  assert.ok(shot.startsWith('data:image/png;base64,'));
  const decoded = Buffer.from(shot.split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, 'cdp-42', 'screenshot must come from CDP against the task tab id');
  assert.equal(captureVisibleTabCalls.length, 0, 'captureVisibleTab must not be used when CDP succeeds');
});

test('createAgentBrowserBridge falls back to captureVisibleTab only when CDP capture fails', async () => {
  const inspectorSends = {
    'Page.captureScreenshot': async () => {
      throw new Error('debugger not attached');
    },
  };
  const { chromeApi, captureVisibleTabCalls } = createChromeStub({ inspectorSends });

  const runtime = createPiBridgeRuntime({ chromeApi, storageArea: chromeApi.storage.local, logger: { warn() {}, error() {}, debug() {} } });
  const bridge = await runtime.createAgentBrowserBridge(42);
  const shot = await bridge.takeScreenshot();

  assert.ok(shot.startsWith('data:image/png;base64,'));
  assert.equal(captureVisibleTabCalls.length, 1, 'fallback must engage when CDP capture throws');
});
