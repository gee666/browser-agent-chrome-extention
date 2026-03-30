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

async function readOAuthToken(providerKey) {
  const data = await new Promise(r => chrome.storage.local.get(`oauth.${providerKey}`, r));
  const tok = data[`oauth.${providerKey}`];
  if (!tok) throw new Error(`Not logged in to ${providerKey}`);
  return tok;
}

async function fetchModels(provider, apiKey, baseUrl) {
  switch (provider) {
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}`);
      const data = await res.json();
      return data.data
        .map(m => m.id)
        .filter(id => /^(gpt-|o[0-9]|chatgpt-)/.test(id))
        .sort((a, b) => b.localeCompare(a)); // newest-first alphabetically
    }

    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort((a, b) => b.localeCompare(a));
    }

    case 'ollama': {
      const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = await res.json();
      return (data.models || []).map(m => m.name).sort();
    }

    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort();
    }

    case 'nvidia': {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort();
    }

    case 'openai-codex': {
      const tok = await readOAuthToken('openai-codex');
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${tok.access}` },
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}`);
      const data = await res.json();
      return data.data
        .map(m => m.id)
        .filter(id => /^(gpt-|o[0-9]|chatgpt-)/.test(id))
        .sort((a, b) => b.localeCompare(a));
    }

    case 'anthropic-oauth': {
      const tok = await readOAuthToken('anthropic');
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { Authorization: `Bearer ${tok.access}`, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      return data.data.map(m => m.id).sort((a, b) => b.localeCompare(a));
    }

    case 'gemini-cli': {
      const tok = await readOAuthToken('gemini-cli');
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { Authorization: `Bearer ${tok.access}` },
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json();
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''))
        .sort((a, b) => b.localeCompare(a));
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
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
  if (statusEl) statusEl.textContent = 'Loading models...';
  selectEl.innerHTML = '<option value="">Loading...</option>';

  try {
    const models = await fetchModels(provider, apiKey, baseUrl);
    if (seq !== _modelFetchSeq) return; // superseded
    if (statusEl) {
      statusEl.textContent = `${models.length} model${models.length !== 1 ? 's' : ''} available`;
      setTimeout(() => { if (statusEl.textContent.includes('available')) statusEl.textContent = ''; }, 3000);
    }
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
