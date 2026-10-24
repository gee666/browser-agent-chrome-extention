import * as core from '../lib/browser-agent-core/background/index.js';

// Jev is optional: published core revisions may not provide it. Importing its
// missing module statically prevented *all* options (including bridge URLs)
// from loading. Keep settings editable without pretending the runtime exists.
export const jevAvailable = typeof core.testJevConnection === 'function';

export function validateJevHeaders(headers) {
  if (typeof core.normalizeJevConfig === 'function') {
    core.normalizeJevConfig({ headers });
    return;
  }
  const seen = new Set();
  const reserved = /^(authorization|content-type|content-length|content-encoding|host|user-agent|cookie|cookie2|connection|origin|referer|accept-encoding|transfer-encoding|upgrade|via|te|trailer|expect|date|dnt|permissions-policy|x-autojev-cache-mode)$|^(sec-|proxy-)/i;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || reserved.test(name) ||
        seen.has(lower) || typeof value !== 'string' || /[^\x20-\x7e\x80-\xff]/.test(value)) {
      throw new Error('Invalid or reserved header');
    }
    seen.add(lower);
  }
}

// Stored beside the existing provider credentials in chrome.storage.local.
export const DECISION_DEFAULTS = Object.freeze({
  decisionMode: 'llm',
  jevBaseUrl: 'http://localhost:8765',
  jevApiKey: '',
  jevModel: 'jev-latest',
  jevCacheMode: 'context',
  jevHeaders: Object.freeze({}),
  jevRequestParams: Object.freeze({}),
  jevTimeoutMs: 1200000,
  jevFallbackEnabled: true,
  helperModel: '',
});
export const DECISION_STORAGE_KEYS = Object.keys(DECISION_DEFAULTS);

export class DecisionValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'DecisionValidationError';
    this.field = field;
  }
}

function invalid(field, message) {
  throw new DecisionValidationError(field, message);
}

function jsonObject(value, field, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.trim() || '{}');
  } catch {
    // JSON parser errors can quote secrets from the supplied text.
    invalid(field, `${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid(field, `${label} must be a JSON object.`);
  }
  const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
  function checkKeys(object) {
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      if (unsafeKeys.has(key)) invalid(field, `${label} contains an unsafe object key.`);
      checkKeys(child);
    }
  }
  checkKeys(parsed);
  return parsed;
}

// Accept origin, /v1, or full /v1/systemone URLs. Endpoint resolution is runtime-owned.
export function validateDecisionSettings(values) {
  const decisionMode = values.decisionMode;
  if (!['llm', 'jev'].includes(decisionMode)) {
    invalid('decisionMode', 'Choose LLM or Jev decision mode.');
  }
  const jevBaseUrl = values.jevBaseUrl.trim();
  let url;
  try {
    url = new URL(jevBaseUrl);
  } catch {
    invalid('jevBaseUrl', 'Jev endpoint must be an HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    invalid('jevBaseUrl', 'Jev endpoint must be an HTTP or HTTPS URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    invalid('jevBaseUrl', 'Jev endpoint cannot contain credentials, a query, or a fragment. Use the key or headers fields for credentials.');
  }
  const jevApiKey = values.jevApiKey.trim();
  if (/[\x00-\x1f\x7f]/.test(jevApiKey)) {
    invalid('jevApiKey', 'Jev API key cannot contain control characters.');
  }
  const jevModel = values.jevModel.trim();
  if (!jevModel || /[\x00-\x1f\x7f]/.test(jevModel)) {
    invalid('jevModel', 'Enter a Jev model name without control characters.');
  }
  const jevCacheMode = values.jevCacheMode;
  if (!['server', 'none', 'options', 'context'].includes(jevCacheMode)) {
    invalid('jevCacheMode', 'Choose Server default, None, Options, or Context cache mode.');
  }
  const helperModel = values.helperModel.trim();
  if (/[\x00-\x1f\x7f]/.test(helperModel)) {
    invalid('helperModel', 'Helper model cannot contain control characters.');
  }
  const jevHeaders = jsonObject(values.jevHeaders, 'jevHeaders', 'Jev headers');
  // Prefer the runtime's header rules; older cores use the conservative local
  // validator above. Never forward potentially credential-bearing error text.
  try {
    validateJevHeaders(jevHeaders);
  } catch {
    invalid('jevHeaders', 'Jev headers contain an invalid or reserved name or value.');
  }
  const jevRequestParams = jsonObject(values.jevRequestParams, 'jevRequestParams', 'Jev request parameters');
  if (['state', 'questions', 'images', 'model'].some(key => Object.hasOwn(jevRequestParams, key))) {
    invalid('jevRequestParams', 'Jev request parameters cannot override state, questions, images, or model.');
  }
  const timeoutText = String(values.jevTimeoutMs).trim();
  const jevTimeoutMs = Number(timeoutText);
  if (!/^\d+$/.test(timeoutText) || !Number.isSafeInteger(jevTimeoutMs) ||
      jevTimeoutMs < 1 || jevTimeoutMs > 3600000) {
    invalid('jevTimeoutMs', 'Jev timeout must be a whole number from 1 to 3600000 milliseconds.');
  }
  if (typeof values.jevFallbackEnabled !== 'boolean') {
    invalid('jevFallbackEnabled', 'Choose whether to allow LLM fallback.');
  }
  return {
    decisionMode, jevBaseUrl, jevApiKey, jevModel, jevCacheMode, jevHeaders,
    jevRequestParams, jevTimeoutMs, jevFallbackEnabled: values.jevFallbackEnabled, helperModel,
  };
}

export function toJevConnectionConfig(settings) {
  return {
    baseUrl: settings.jevBaseUrl,
    apiKey: settings.jevApiKey,
    model: settings.jevModel,
    cacheMode: settings.jevCacheMode ?? DECISION_DEFAULTS.jevCacheMode,
    headers: settings.jevHeaders,
    requestParams: settings.jevRequestParams,
    timeoutMs: settings.jevTimeoutMs,
    fallbackEnabled: settings.jevFallbackEnabled,
  };
}

export function initDecisionSettings(document, runtime, stored) {
  const fields = Object.fromEntries(DECISION_STORAGE_KEYS.map(key => [key, document.getElementById(key)]));
  const testButton = document.getElementById('jev-test-btn');
  const status = document.getElementById('jev-test-status');
  const availability = document.getElementById('jev-availability');
  if (!jevAvailable && availability) {
    availability.textContent = 'Jev is unavailable in the installed browser-agent-core. Normal LLM mode and the pi bridge remain available.';
  }
  for (const [key, field] of Object.entries(fields)) {
    const value = stored[key] ?? DECISION_DEFAULTS[key];
    if (key === 'jevFallbackEnabled') field.checked = value;
    else if (key === 'jevHeaders' || key === 'jevRequestParams') field.value = JSON.stringify(value, null, 2);
    else field.value = value;
    field.addEventListener('input', () => {
      field.removeAttribute('aria-invalid');
      status.textContent = '';
    });
  }
  const useVision = document.getElementById('useVision');
  function updateDecisionMode() {
    // Keep the checked state as the saved normal-LLM preference. Jev escalation
    // is mandatory and does not use this checkbox.
    useVision.disabled = fields.decisionMode.value === 'jev';
  }
  updateDecisionMode();
  fields.decisionMode.addEventListener('change', updateDecisionMode);

  function read() {
    for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [
      key, key === 'jevFallbackEnabled' ? field.checked : field.value,
    ]));
    try {
      return validateDecisionSettings(values);
    } catch (error) {
      if (error instanceof DecisionValidationError) fields[error.field].setAttribute('aria-invalid', 'true');
      throw error;
    }
  }
  testButton.addEventListener('click', async () => {
    let settings;
    try {
      settings = read();
    } catch (error) {
      status.textContent = error instanceof DecisionValidationError ? error.message : 'Check the Jev settings.';
      status.style.color = '#dc2626';
      return;
    }
    testButton.disabled = true;
    status.textContent = 'Testing connection...';
    status.style.color = '#6b7280';
    // Test the current fields without saving or contacting the endpoint from the options page.
    const ok = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), settings.jevTimeoutMs + 1000);
      try {
        runtime.sendMessage({ type: 'test_jev_connection', config: toJevConnectionConfig(settings) }, response => {
          clearTimeout(timer);
          // Never display runtime errors or endpoint response text; either can include secrets.
          const failed = !!runtime.lastError;
          resolve(!failed && response?.ok === true);
        });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
    status.textContent = ok ? 'Jev connection successful.' : 'Jev connection failed. Check the endpoint, credentials, and server availability.';
    status.style.color = ok ? '#16a34a' : '#dc2626';
    testButton.disabled = false;
  });
  return { read };
}
