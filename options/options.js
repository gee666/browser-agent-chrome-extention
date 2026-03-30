// Provider model defaults
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

// Which providers show Base URL
const SHOW_BASE_URL = ['ollama', 'openrouter', 'nvidia'];

// Which providers need API key
const NEEDS_API_KEY = ['openai', 'anthropic', 'openrouter', 'nvidia'];

// OAuth providers (no API key needed)
const OAUTH_PROVIDERS = ['openai-codex', 'anthropic-oauth', 'gemini-cli'];

// Internal OAuth key mapping (what sw.js uses)
const OAUTH_KEY_MAP = {
  'openai-codex': 'openai-codex',
  'anthropic-oauth': 'anthropic',
  'gemini-cli': 'gemini-cli',
};

function updateUIForProvider(provider) {
  const apiKeyGroup = document.getElementById('api-key-group');
  const baseUrlGroup = document.getElementById('base-url-group');
  const modelInput = document.getElementById('model');

  const isOAuth = OAUTH_PROVIDERS.includes(provider);

  // API key: show only for non-OAuth providers that need it
  if (apiKeyGroup) apiKeyGroup.style.display = (!isOAuth && NEEDS_API_KEY.includes(provider)) ? '' : 'none';
  // Base URL: show for providers that use it
  if (baseUrlGroup) baseUrlGroup.style.display = SHOW_BASE_URL.includes(provider) ? '' : 'none';
  // Model placeholder
  if (modelInput) modelInput.placeholder = MODEL_DEFAULTS[provider] || 'model-name';
}

document.addEventListener('DOMContentLoaded', async () => {
  // ── Load settings ──────────────────────────────────────────────────────────
  const keys = ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision'];
  const config = await new Promise(r => chrome.storage.local.get(keys, r));

  const providerSel = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const modelInput = document.getElementById('model');
  const baseUrlInput = document.getElementById('baseUrl');
  const maxIterInput = document.getElementById('maxIterations');
  const useVisionInput = document.getElementById('useVision');
  const saveBtn = document.getElementById('save-btn');
  const saveConfirm = document.getElementById('save-confirm');

  providerSel.value = config.provider || 'openai';
  apiKeyInput.value = config.apiKey || '';
  modelInput.value = config.model || '';
  baseUrlInput.value = config.baseUrl || '';
  maxIterInput.value = config.maxIterations || 20;
  useVisionInput.checked = config.useVision !== false;

  updateUIForProvider(providerSel.value);

  // ── Provider change ─────────────────────────────────────────────────────────
  let previousProvider = providerSel.value;
  providerSel.addEventListener('change', () => {
    const newProvider = providerSel.value;
    const prevDefault = MODEL_DEFAULTS[previousProvider] || '';
    const curModel = modelInput.value.trim();
    if (!curModel || curModel === prevDefault) {
      modelInput.value = MODEL_DEFAULTS[newProvider] || '';
    }
    updateUIForProvider(newProvider);
    previousProvider = newProvider;
  });

  // ── Save settings ───────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const provider = providerSel.value;
    const isOAuth = OAUTH_PROVIDERS.includes(provider);

    if (!isOAuth && NEEDS_API_KEY.includes(provider) && !apiKeyInput.value.trim()) {
      showError('Please enter an API key for this provider.');
      return;
    }

    chrome.storage.local.set({
      provider,
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim() || MODEL_DEFAULTS[provider],
      baseUrl: baseUrlInput.value.trim(),
      maxIterations: parseInt(maxIterInput.value, 10) || 20,
      useVision: useVisionInput.checked,
    }, () => {
      saveConfirm.textContent = 'Saved ✓';
      saveConfirm.style.color = '#16a34a';
      setTimeout(() => { saveConfirm.textContent = ''; }, 2000);
    });
  });

  // ── OAuth section ───────────────────────────────────────────────────────────
  await refreshOAuthStatus();

  // Listen for OAuth results from service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'oauth_result') {
      handleOAuthResult(msg.status);
    }
  });

  // Wire up login/logout buttons
  for (const [uiKey, storeKey] of Object.entries(OAUTH_KEY_MAP)) {
    const loginBtn = document.getElementById(`login-${uiKey}`);
    const logoutBtn = document.getElementById(`logout-${uiKey}`);

    loginBtn?.addEventListener('click', () => startOAuthLogin(uiKey, storeKey));
    logoutBtn?.addEventListener('click', () => doOAuthLogout(storeKey));
  }
});

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
  const badge = document.getElementById(`badge-${uiKey}`);
  const detail = document.getElementById(`detail-${uiKey}`);
  const loginBtn = document.getElementById(`login-${uiKey}`);
  const logoutBtn = document.getElementById(`logout-${uiKey}`);
  const statusEl = document.getElementById(`status-${uiKey}`);

  if (!badge) return;

  if (info.loggedIn) {
    badge.textContent = '✓ Logged in';
    badge.className = 'oauth-badge logged-in';
    const detailText = info.email ? `Email: ${info.email}` : (info.accountId ? `Account: ${info.accountId}` : '');
    if (detail) detail.textContent = detailText;
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

  // Map UI key to sw.js provider key
  const swProvider = storeKey; // 'openai-codex' | 'anthropic' | 'gemini-cli'

  chrome.runtime.sendMessage({ type: 'oauth_start', provider: swProvider }, (resp) => {
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
  // Find UI key for this store key
  const uiKey = Object.entries(OAUTH_KEY_MAP).find(([, v]) => v === provider)?.[0];
  if (!uiKey) return;

  const statusEl = document.getElementById(`status-${uiKey}`);
  const loginBtn = document.getElementById(`login-${uiKey}`);
  if (loginBtn) loginBtn.disabled = false;

  if (success) {
    if (statusEl) {
      statusEl.textContent = email ? `✓ Logged in as ${email}` : '✓ Login successful!';
      statusEl.style.color = '#16a34a';
    }
    refreshOAuthStatus();
  } else {
    if (statusEl) {
      statusEl.textContent = `✗ Login failed: ${error}`;
      statusEl.style.color = '#dc2626';
    }
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
