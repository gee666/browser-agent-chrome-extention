// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_DEFAULTS = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4-5',
  ollama: 'llava',
  openrouter: 'openai/gpt-4o',
  nvidia: 'meta/llama-3.1-70b-instruct',
  'openai-codex': 'gpt-4o',
  'anthropic-oauth': 'claude-opus-4-5',
  'gemini-cli': 'gemini-2.0-flash',
};

const SHOW_BASE_URL = ['ollama', 'openrouter', 'nvidia'];
const NEEDS_API_KEY = ['openai', 'anthropic', 'openrouter', 'nvidia'];
const OAUTH_PROVIDERS = ['openai-codex', 'anthropic-oauth', 'gemini-cli'];
const OAUTH_KEY_MAP = {
  'openai-codex': 'openai-codex',
  'anthropic-oauth': 'anthropic',
  'gemini-cli': 'gemini-cli',
};

// ── UI helper ─────────────────────────────────────────────────────────────────

function updateUIForProvider(provider) {
  const apiKeyGroup = document.getElementById('api-key-group');
  const baseUrlGroup = document.getElementById('base-url-group');
  const isOAuth = OAUTH_PROVIDERS.includes(provider);
  if (apiKeyGroup) apiKeyGroup.style.display = (!isOAuth && NEEDS_API_KEY.includes(provider)) ? '' : 'none';
  if (baseUrlGroup) baseUrlGroup.style.display = SHOW_BASE_URL.includes(provider) ? '' : 'none';
}

// ── Model fetching ────────────────────────────────────────────────────────────

// ── Hardcoded model lists (from pi-ai models.generated.js) ───────────────────

const HARDCODED_MODELS = {
  'openai': ["o4-mini","o4-mini-deep-research","o3","o3-pro","o3-mini","o3-deep-research","o1","o1-pro","gpt-5","gpt-5-pro","gpt-5-mini","gpt-5-nano","gpt-5-codex","gpt-5-chat-latest","gpt-5.1","gpt-5.1-codex","gpt-5.1-codex-max","gpt-5.1-codex-mini","gpt-5.1-chat-latest","gpt-5.2","gpt-5.2-codex","gpt-5.2-pro","gpt-5.2-chat-latest","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.4","gpt-5.4-mini","gpt-5.4-nano","gpt-5.4-pro","gpt-4o","gpt-4o-2024-11-20","gpt-4o-2024-08-06","gpt-4o-2024-05-13","gpt-4o-mini","gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","gpt-4-turbo","gpt-4","codex-mini-latest"],
  'openai-codex': ["gpt-5.1","gpt-5.1-codex","gpt-5.1-codex-max","gpt-5.1-codex-mini","gpt-5.2","gpt-5.2-codex","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.4","gpt-5.4-mini"],
  'anthropic': ["claude-opus-4-6","claude-opus-4-5","claude-opus-4-5-20251101","claude-opus-4-1","claude-opus-4-1-20250805","claude-opus-4-0","claude-opus-4-20250514","claude-sonnet-4-6","claude-sonnet-4-5","claude-sonnet-4-5-20250929","claude-sonnet-4-0","claude-sonnet-4-20250514","claude-haiku-4-5","claude-haiku-4-5-20251001","claude-3-7-sonnet-latest","claude-3-7-sonnet-20250219","claude-3-5-sonnet-20241022","claude-3-5-sonnet-20240620","claude-3-5-haiku-latest","claude-3-5-haiku-20241022","claude-3-opus-20240229","claude-3-sonnet-20240229","claude-3-haiku-20240307"],
  'anthropic-oauth': ["claude-opus-4-6","claude-opus-4-5","claude-opus-4-5-20251101","claude-opus-4-1","claude-opus-4-1-20250805","claude-opus-4-0","claude-opus-4-20250514","claude-sonnet-4-6","claude-sonnet-4-5","claude-sonnet-4-5-20250929","claude-sonnet-4-0","claude-sonnet-4-20250514","claude-haiku-4-5","claude-haiku-4-5-20251001","claude-3-7-sonnet-latest","claude-3-7-sonnet-20250219","claude-3-5-sonnet-20241022","claude-3-5-haiku-latest","claude-3-haiku-20240307"],
  'gemini-cli': ["gemini-3.1-pro-preview","gemini-3-pro-preview","gemini-3-flash-preview","gemini-2.5-pro","gemini-2.5-flash","gemini-2.0-flash"],
  'openrouter': ["anthropic/claude-opus-4.6","anthropic/claude-opus-4.5","anthropic/claude-opus-4.1","anthropic/claude-opus-4","anthropic/claude-sonnet-4.6","anthropic/claude-sonnet-4.5","anthropic/claude-sonnet-4","anthropic/claude-haiku-4.5","anthropic/claude-3.7-sonnet","anthropic/claude-3.7-sonnet:thinking","anthropic/claude-3.5-sonnet","anthropic/claude-3.5-haiku","anthropic/claude-3-haiku","openai/gpt-5","openai/gpt-5-pro","openai/gpt-5-mini","openai/gpt-5.4","openai/gpt-5.4-mini","openai/gpt-5.4-nano","openai/gpt-5.4-pro","openai/gpt-5.3-codex","openai/gpt-5.3-chat","openai/gpt-5.2","openai/gpt-5.2-codex","openai/gpt-5.2-pro","openai/gpt-5.1","openai/gpt-5.1-codex","openai/gpt-5.1-codex-max","openai/gpt-5.1-codex-mini","openai/gpt-5.1-chat","openai/gpt-5-codex","openai/o4-mini","openai/o4-mini-deep-research","openai/o3","openai/o3-pro","openai/o3-mini","openai/o3-mini-high","openai/o3-deep-research","openai/o1","openai/gpt-4o","openai/gpt-4o-mini","openai/gpt-4o-2024-11-20","openai/gpt-4.1","openai/gpt-4.1-mini","openai/gpt-4.1-nano","openai/gpt-4-turbo","openai/gpt-oss-120b","openai/gpt-oss-20b","google/gemini-3.1-pro-preview","google/gemini-3-pro-preview","google/gemini-3-flash-preview","google/gemini-2.5-pro","google/gemini-2.5-pro-preview","google/gemini-2.5-flash","google/gemini-2.5-flash-lite","google/gemini-2.0-flash-001","google/gemini-2.0-flash-lite-001","deepseek/deepseek-r1","deepseek/deepseek-r1-0528","deepseek/deepseek-v3.2","deepseek/deepseek-v3.2-exp","deepseek/deepseek-v3.1-terminus","deepseek/deepseek-chat","deepseek/deepseek-chat-v3.1","meta-llama/llama-4-maverick","meta-llama/llama-4-scout","meta-llama/llama-3.3-70b-instruct","meta-llama/llama-3.1-70b-instruct","meta-llama/llama-3.1-8b-instruct","mistralai/mistral-large-2512","mistralai/mistral-large","mistralai/mistral-medium-3.1","mistralai/mistral-small-3.2-24b-instruct","mistralai/devstral-medium","mistralai/devstral-small","mistralai/codestral-2508","mistralai/mixtral-8x22b-instruct","mistralai/mixtral-8x7b-instruct","x-ai/grok-4","x-ai/grok-4-fast","x-ai/grok-4.1-fast","x-ai/grok-3","x-ai/grok-3-beta","x-ai/grok-3-mini","x-ai/grok-3-mini-beta","qwen/qwen3-235b-a22b","qwen/qwen3-32b","qwen/qwen3-14b","qwen/qwen3-8b","qwen/qwen3-coder","qwen/qwen3-max","qwen/qwq-32b","moonshotai/kimi-k2","moonshotai/kimi-k2.5","nvidia/llama-3.1-nemotron-70b-instruct","nvidia/nemotron-3-super-120b-a12b","openrouter/auto","openrouter/free"],
  'nvidia': ["meta/llama-3.1-70b-instruct","meta/llama-3.1-8b-instruct","meta/llama-3.3-70b-instruct","meta/llama-3.1-405b-instruct","meta/llama-4-scout","meta/llama-4-maverick","nvidia/llama-3.1-nemotron-70b-instruct","nvidia/llama-3.3-nemotron-super-49b-v1.5","nvidia/nemotron-3-super-120b-a12b","mistralai/mistral-large-2-instruct","mistralai/mistral-small-24b-instruct","google/gemma-3-27b-it","microsoft/phi-4","deepseek-ai/deepseek-r1","qwen/qwq-32b","moonshotai/kimi-k2"],
};

async function readOAuthToken(providerKey) {
  const data = await new Promise(r => chrome.storage.local.get(`oauth.${providerKey}`, r));
  const tok = data[`oauth.${providerKey}`];
  if (!tok) throw new Error(`Not logged in to ${providerKey}`);
  return tok;
}

/**
 * Fetch models from provider API. Throws on error.
 * Returns string[] of model IDs.
 * Only called for providers that support live listing reliably.
 */
async function fetchModelsLive(provider, apiKey, baseUrl) {
  switch (provider) {
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data
        .map(m => m.id)
        .filter(id => /^(gpt-|o[0-9]|chatgpt-)/.test(id))
        .sort((a, b) => b.localeCompare(a));
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort((a, b) => b.localeCompare(a));
    }
    case 'ollama': {
      const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.models || []).map(m => m.name).sort();
    }
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort();
    }
    case 'nvidia': {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort();
    }
    default:
      throw new Error(`No live fetch for ${provider}`);
  }
}

/**
 * Get models for a provider. Uses hardcoded list for OAuth providers and as
 * fallback; does live fetch for API-key providers.
 * Returns { models: string[], source: 'live'|'hardcoded'|'ollama' }
 */
async function fetchModels(provider, apiKey, baseUrl) {
  // Providers where we always use hardcoded (live fetch won't work)
  const hardcodedOnly = ['openai-codex', 'anthropic-oauth', 'gemini-cli'];
  if (hardcodedOnly.includes(provider)) {
    const models = HARDCODED_MODELS[provider] || [];
    if (!models.length) throw new Error('No models defined for this provider');
    return { models, source: 'hardcoded' };
  }

  // Ollama: always live (user-installed, can't hardcode)
  if (provider === 'ollama') {
    const models = await fetchModelsLive('ollama', '', baseUrl);
    return { models, source: 'ollama' };
  }

  // API-key providers: try live, fall back to hardcoded
  if (!apiKey) {
    // No key yet — return hardcoded so the dropdown isn't empty
    return { models: HARDCODED_MODELS[provider] || [], source: 'hardcoded' };
  }

  try {
    const models = await fetchModelsLive(provider, apiKey, baseUrl);
    return { models, source: 'live' };
  } catch (err) {
    const fallback = HARDCODED_MODELS[provider] || [];
    console.warn(`[models] Live fetch failed for ${provider}: ${err.message}. Using hardcoded list.`);
    return { models: fallback, source: 'hardcoded', fetchError: err.message };
  }
}

// ── Model select UI ───────────────────────────────────────────────────────────

let _modelFetchSeq = 0;

async function loadModels(provider, apiKey, baseUrl, savedModel) {
  const selectEl = document.getElementById('model-select');
  const statusEl = document.getElementById('model-status');
  const refreshBtn = document.getElementById('model-refresh-btn');
  if (!selectEl) return;

  const seq = ++_modelFetchSeq;
  selectEl.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (statusEl) statusEl.textContent = provider === 'ollama' ? 'Connecting to Ollama...' : 'Loading models...';
  selectEl.innerHTML = '<option value="">Loading...</option>';

  try {
    const { models, source, fetchError } = await fetchModels(provider, apiKey, baseUrl);
    if (seq !== _modelFetchSeq) return;

    if (source === 'ollama') {
      if (statusEl) statusEl.textContent = `${models.length} local model${models.length !== 1 ? 's' : ''} found`;
    } else if (source === 'live') {
      if (statusEl) statusEl.textContent = `${models.length} models loaded`;
    } else {
      // hardcoded
      if (fetchError) {
        if (statusEl) statusEl.textContent = `⚠ API error (${fetchError}) — showing built-in list`;
      } else {
        if (statusEl) statusEl.textContent = `${models.length} models available`;
      }
    }
    setTimeout(() => {
      if (statusEl && !statusEl.textContent.includes('⚠')) statusEl.textContent = '';
    }, 4000);

    populateModelSelect(models, savedModel || MODEL_DEFAULTS[provider] || '');
  } catch (err) {
    if (seq !== _modelFetchSeq) return;
    if (statusEl) statusEl.textContent = `⚠ ${err.message}`;
    populateModelSelect([], savedModel || MODEL_DEFAULTS[provider] || '');
  } finally {
    if (seq === _modelFetchSeq) {
      selectEl.disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function populateModelSelect(models, selected) {
  const selectEl = document.getElementById('model-select');
  const customInput = document.getElementById('model-custom');
  if (!selectEl) return;

  const allModels = [...models];
  // If saved model isn't in the list, prepend it
  if (selected && !allModels.includes(selected)) {
    allModels.unshift(selected);
  }

  selectEl.innerHTML =
    allModels.map(id => `<option value="${escHtml(id)}">${escHtml(id)}</option>`).join('') +
    '<option value="__custom__">✏\u00a0Enter custom model name...</option>';

  if (selected && allModels.includes(selected)) {
    selectEl.value = selected;
  } else if (allModels.length > 0) {
    selectEl.value = allModels[0];
  }

  // Custom entry toggle
  selectEl.onchange = () => {
    if (customInput) customInput.style.display = selectEl.value === '__custom__' ? '' : 'none';
    if (selectEl.value === '__custom__' && customInput) customInput.focus();
  };
  // Ensure custom input is hidden initially
  if (customInput) customInput.style.display = 'none';
}

function getSelectedModel() {
  const selectEl = document.getElementById('model-select');
  const customInput = document.getElementById('model-custom');
  if (!selectEl) return '';
  if (selectEl.value === '__custom__') return customInput?.value.trim() || '';
  return selectEl.value;
}

// ── Main ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const keys = ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision'];
  const config = await new Promise(r => chrome.storage.local.get(keys, r));

  const providerSel  = document.getElementById('provider');
  const apiKeyInput  = document.getElementById('apiKey');
  const baseUrlInput = document.getElementById('baseUrl');
  const maxIterInput = document.getElementById('maxIterations');
  const useVisionInput = document.getElementById('useVision');
  const saveBtn      = document.getElementById('save-btn');
  const saveConfirm  = document.getElementById('save-confirm');
  const refreshBtn   = document.getElementById('model-refresh-btn');

  providerSel.value    = config.provider || 'openai';
  apiKeyInput.value    = config.apiKey   || '';
  baseUrlInput.value   = config.baseUrl  || '';
  maxIterInput.value   = config.maxIterations || 20;
  useVisionInput.checked = config.useVision !== false;

  updateUIForProvider(providerSel.value);

  // Initial model load
  await loadModels(providerSel.value, apiKeyInput.value.trim(), baseUrlInput.value.trim(), config.model || '');

  // ── Provider change ─────────────────────────────────────────────────────────
  let previousProvider = providerSel.value;
  providerSel.addEventListener('change', () => {
    const newProvider = providerSel.value;
    updateUIForProvider(newProvider);
    loadModels(newProvider, apiKeyInput.value.trim(), baseUrlInput.value.trim(), MODEL_DEFAULTS[newProvider] || '');
    previousProvider = newProvider;
  });

  // ── API key change (debounced) ───────────────────────────────────────────────
  let apiKeyTimer = null;
  apiKeyInput.addEventListener('input', () => {
    clearTimeout(apiKeyTimer);
    apiKeyTimer = setTimeout(() => {
      if (apiKeyInput.value.trim().length > 8) {
        loadModels(providerSel.value, apiKeyInput.value.trim(), baseUrlInput.value.trim(), getSelectedModel());
      }
    }, 700);
  });
  apiKeyInput.addEventListener('blur', () => {
    clearTimeout(apiKeyTimer);
    if (apiKeyInput.value.trim()) {
      loadModels(providerSel.value, apiKeyInput.value.trim(), baseUrlInput.value.trim(), getSelectedModel());
    }
  });

  // ── Base URL change (Ollama) ─────────────────────────────────────────────────
  baseUrlInput.addEventListener('blur', () => {
    if (providerSel.value === 'ollama') {
      loadModels('ollama', '', baseUrlInput.value.trim(), getSelectedModel());
    }
  });

  // ── Refresh button ───────────────────────────────────────────────────────────
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadModels(providerSel.value, apiKeyInput.value.trim(), baseUrlInput.value.trim(), getSelectedModel());
    });
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const provider = providerSel.value;
    const isOAuth = OAUTH_PROVIDERS.includes(provider);
    const model = getSelectedModel();

    if (!isOAuth && NEEDS_API_KEY.includes(provider) && !apiKeyInput.value.trim()) {
      showError('Please enter an API key for this provider.');
      return;
    }
    if (!model) {
      showError('Please select or enter a model name.');
      return;
    }

    chrome.storage.local.set({
      provider,
      apiKey:         apiKeyInput.value.trim(),
      model,
      baseUrl:        baseUrlInput.value.trim(),
      maxIterations:  parseInt(maxIterInput.value, 10) || 20,
      useVision:      useVisionInput.checked,
    }, () => {
      saveConfirm.textContent = 'Saved ✓';
      saveConfirm.style.color = '#16a34a';
      setTimeout(() => { saveConfirm.textContent = ''; }, 2000);
    });
  });

  // ── OAuth section ─────────────────────────────────────────────────────────────
  await refreshOAuthStatus();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'oauth_result') handleOAuthResult(msg.status);
  });

  for (const [uiKey, storeKey] of Object.entries(OAUTH_KEY_MAP)) {
    document.getElementById(`login-${uiKey}`)?.addEventListener('click',  () => startOAuthLogin(uiKey, storeKey));
    document.getElementById(`logout-${uiKey}`)?.addEventListener('click', () => doOAuthLogout(storeKey));
  }
});

// ── OAuth helpers ─────────────────────────────────────────────────────────────

async function refreshOAuthStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'oauth_status' }, (statuses) => {
      if (chrome.runtime.lastError || !statuses) { resolve(); return; }
      for (const [uiKey, storeKey] of Object.entries(OAUTH_KEY_MAP)) {
        const info = statuses[storeKey];
        if (info) updateOAuthUI(uiKey, info);
      }
      resolve();
    });
  });
}

function updateOAuthUI(uiKey, info) {
  const badge    = document.getElementById(`badge-${uiKey}`);
  const detail   = document.getElementById(`detail-${uiKey}`);
  const loginBtn = document.getElementById(`login-${uiKey}`);
  const logoutBtn= document.getElementById(`logout-${uiKey}`);
  const statusEl = document.getElementById(`status-${uiKey}`);
  if (!badge) return;
  if (info.loggedIn) {
    badge.textContent = '✓ Logged in';
    badge.className = 'oauth-badge logged-in';
    if (detail) detail.textContent = info.email ? `Email: ${info.email}` : (info.accountId ? `Account: ${info.accountId}` : '');
    loginBtn?.setAttribute('hidden', '');
    logoutBtn?.removeAttribute('hidden');
  } else {
    badge.textContent = 'Not logged in';
    badge.className = 'oauth-badge';
    if (detail) detail.textContent = '';
    loginBtn?.removeAttribute('hidden');
    logoutBtn?.setAttribute('hidden', '');
  }
  if (statusEl) statusEl.textContent = '';
}

async function startOAuthLogin(uiKey, storeKey) {
  const statusEl = document.getElementById(`status-${uiKey}`);
  const loginBtn = document.getElementById(`login-${uiKey}`);
  if (statusEl) statusEl.textContent = 'Opening login window...';
  if (loginBtn) loginBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'oauth_start', provider: storeKey }, (resp) => {
    if (chrome.runtime.lastError || !resp?.started) {
      const err = resp?.error || chrome.runtime.lastError?.message || 'Unknown error';
      if (statusEl) statusEl.textContent = `Error: ${err}`;
      if (loginBtn) loginBtn.disabled = false;
    } else {
      if (statusEl) statusEl.textContent = 'Complete login in the browser window that opened...';
    }
  });
}

async function doOAuthLogout(storeKey) {
  const uiKey = Object.entries(OAUTH_KEY_MAP).find(([, v]) => v === storeKey)?.[0];
  const statusEl = document.getElementById(`status-${uiKey}`);
  chrome.runtime.sendMessage({ type: 'oauth_logout', provider: storeKey }, async () => {
    if (statusEl) statusEl.textContent = 'Logged out.';
    await refreshOAuthStatus();
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
  });
}

function handleOAuthResult(status) {
  const { provider, success, error, email } = status;
  const uiKey = Object.entries(OAUTH_KEY_MAP).find(([, v]) => v === provider)?.[0];
  if (!uiKey) return;
  const statusEl = document.getElementById(`status-${uiKey}`);
  const loginBtn = document.getElementById(`login-${uiKey}`);
  if (loginBtn) loginBtn.disabled = false;
  if (success) {
    if (statusEl) { statusEl.textContent = email ? `✓ Logged in as ${email}` : '✓ Login successful!'; statusEl.style.color = '#16a34a'; }
    refreshOAuthStatus();
    // Re-load models now that we're authenticated
    const providerSel = document.getElementById('provider');
    if (providerSel) loadModels(providerSel.value, '', '', getSelectedModel());
  } else {
    if (statusEl) { statusEl.textContent = `✗ Login failed: ${error}`; statusEl.style.color = '#dc2626'; }
  }
}

function showError(msg) {
  const confirm = document.getElementById('save-confirm');
  if (confirm) {
    confirm.textContent = msg;
    confirm.style.color = '#dc2626';
    setTimeout(() => { confirm.textContent = ''; }, 4000);
  }
}
