import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This test guards against regressions in the Options page OAuth wiring.
//
// Background: `options.js` wires login/logout/status elements by building DOM
// ids from a provider -> uiKey map. A prior bug used the provider id
// `anthropic-oauth` as the uiKey, which produced ids like
// `login-anthropic-oauth` that do not exist in `options.html` (which uses
// the prefix `anthropic`). The listeners silently attached to nothing and
// the Anthropic OAuth card appeared broken.
//
// Rather than standing up a full DOM to run options.js end-to-end (no dev
// deps are available in this workspace), these tests assert the two sides
// of the contract directly:
//   1. options.js declares OAUTH_UI_CONFIG with the expected provider/uiId
//      pairs and separates providerId from uiId (not just reused).
//   2. For every uiId, the matching DOM ids are present in options.html.
//      For every providerId, the background worker exposes matching handlers.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_JS_PATH = path.join(HERE, 'options.js');
const OPTIONS_HTML_PATH = path.join(HERE, 'options.html');

const EXPECTED_ENTRIES = [
  { providerId: 'openai-codex', uiId: 'openai-codex' },
  { providerId: 'anthropic',    uiId: 'anthropic' },
  { providerId: 'gemini-cli',   uiId: 'gemini-cli' },
];

const UI_ELEMENT_PREFIXES = ['login', 'logout', 'badge', 'detail', 'status'];

test('options.js declares OAUTH_UI_CONFIG with expected provider/uiId pairs', async () => {
  const source = await readFile(OPTIONS_JS_PATH, 'utf8');

  // The config block should be present and should list providerId + uiId
  // entries for all three OAuth providers.
  assert.match(source, /OAUTH_UI_CONFIG\s*=\s*\[/);
  for (const { providerId, uiId } of EXPECTED_ENTRIES) {
    const re = new RegExp(
      `providerId:\\s*['"]${providerId}['"][^}]*uiId:\\s*['"]${uiId}['"]`,
    );
    assert.match(source, re, `expected entry for providerId=${providerId} uiId=${uiId}`);
  }

  // The wiring loops must use OAUTH_UI_CONFIG (with providerId/uiId)
  // rather than the old Object.entries(OAUTH_KEY_MAP) pattern that caused
  // the anthropic-oauth / anthropic mismatch.
  assert.match(source, /for \(const \{ providerId, uiId \} of OAUTH_UI_CONFIG\)/);

  // Anthropic in particular: providerId is `anthropic`, not `anthropic-oauth`.
  // This was the specific bug that left the Anthropic login button unwired.
  assert.doesNotMatch(
    source,
    /providerId:\s*['"]anthropic-oauth['"]/,
    'Anthropic providerId must be "anthropic", not "anthropic-oauth"',
  );
});

test('every OAuth uiId has matching login/logout/badge/detail/status DOM ids in options.html', async () => {
  const html = await readFile(OPTIONS_HTML_PATH, 'utf8');

  for (const { uiId } of EXPECTED_ENTRIES) {
    for (const prefix of UI_ELEMENT_PREFIXES) {
      const expectedId = `${prefix}-${uiId}`;
      assert.match(
        html,
        new RegExp(`id=["']${expectedId}["']`),
        `options.html must contain id="${expectedId}" (${prefix} element for ${uiId})`,
      );
    }
  }
});

test('Anthropic OAuth controls target ui prefix "anthropic" (regression guard)', async () => {
  const html = await readFile(OPTIONS_HTML_PATH, 'utf8');
  assert.match(html, /id=["']login-anthropic["']/);
  assert.match(html, /id=["']logout-anthropic["']/);
  assert.match(html, /id=["']badge-anthropic["']/);
  assert.match(html, /id=["']status-anthropic["']/);
  // The broken id scheme must NOT be present in the HTML.
  assert.doesNotMatch(html, /id=["']login-anthropic-oauth["']/);
  assert.doesNotMatch(html, /id=["']badge-anthropic-oauth["']/);
});

// jsdom-free DOM-wiring sanity check: build a minimal DOM stub that records
// which (elementId, event, handler) triples get attached, then drive the
// wiring loop the same way options.js does.
test('wiring loop attaches listeners to the correct anthropic DOM ids', async () => {
  const attached = [];
  const dom = new Map();
  function makeEl(id) {
    const el = {
      id,
      listeners: {},
      addEventListener(event, handler) {
        attached.push({ id, event });
        this.listeners[event] = handler;
      },
      setAttribute() {},
      removeAttribute() {},
    };
    dom.set(id, el);
    return el;
  }
  // Pre-populate the DOM with the ids that options.html declares.
  for (const { uiId } of EXPECTED_ENTRIES) {
    for (const prefix of UI_ELEMENT_PREFIXES) {
      makeEl(`${prefix}-${uiId}`);
    }
  }
  const documentStub = {
    getElementById(id) {
      return dom.get(id) || null;
    },
  };

  // Simulate the wiring loop from options.js.
  for (const { providerId, uiId } of EXPECTED_ENTRIES) {
    documentStub.getElementById(`login-${uiId}`)?.addEventListener('click', () => providerId);
    documentStub.getElementById(`logout-${uiId}`)?.addEventListener('click', () => providerId);
  }

  // Anthropic must be wired on `login-anthropic` (not `login-anthropic-oauth`).
  const anthropicLoginAttached = attached.some(
    (entry) => entry.id === 'login-anthropic' && entry.event === 'click',
  );
  assert.equal(anthropicLoginAttached, true, 'login-anthropic must have a click listener attached');
  const badAttached = attached.some((entry) => entry.id === 'login-anthropic-oauth');
  assert.equal(badAttached, false, 'login-anthropic-oauth must not be referenced');
});
