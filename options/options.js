const MODEL_DEFAULTS = {
  openai:      'gpt-4o',
  anthropic:   'claude-opus-4-5',
  ollama:      'llava',
  openrouter:  'openai/gpt-4o',
  nvidia:      'meta/llama-3.1-70b-instruct',
};

const SHOW_BASE_URL = ['ollama', 'openrouter', 'nvidia'];
const NEEDS_API_KEY = ['openai', 'anthropic', 'openrouter', 'nvidia'];

const providerEl     = document.getElementById('provider');
const apiKeyEl       = document.getElementById('apiKey');
const modelEl        = document.getElementById('model');
const baseUrlEl      = document.getElementById('baseUrl');
const maxIterEl      = document.getElementById('maxIterations');
const useVisionEl    = document.getElementById('useVision');
const saveBtn        = document.getElementById('save-btn');
const saveConfirm    = document.getElementById('save-confirm');
const apiKeyGroup    = document.getElementById('api-key-group');
const baseUrlGroup   = document.getElementById('base-url-group');
const appEl          = document.getElementById('app');

function updateUIForProvider(provider) {
  baseUrlGroup.hidden = !SHOW_BASE_URL.includes(provider);
  apiKeyGroup.hidden  = !NEEDS_API_KEY.includes(provider);
  modelEl.placeholder = MODEL_DEFAULTS[provider] || '';
}

function showError(msg) {
  let el = appEl.querySelector('.error-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'error-msg';
    saveBtn.parentElement.insertBefore(el, saveBtn);
  }
  el.textContent = msg;
}

function clearError() {
  const el = appEl.querySelector('.error-msg');
  if (el) el.remove();
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(
    ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision'],
    (data) => {
      const provider = data.provider || 'openai';
      providerEl.value      = provider;
      apiKeyEl.value        = data.apiKey || '';
      modelEl.value         = data.model  || MODEL_DEFAULTS[provider] || '';
      baseUrlEl.value       = data.baseUrl || '';
      maxIterEl.value       = data.maxIterations !== undefined ? data.maxIterations : 20;
      useVisionEl.checked   = data.useVision !== false;
      updateUIForProvider(provider);
    }
  );
});

providerEl.addEventListener('change', function () {
  const newProvider = this.value;
  const prevProvider = Object.keys(MODEL_DEFAULTS).find(
    (p) => MODEL_DEFAULTS[p] === modelEl.value
  );
  if (!modelEl.value || prevProvider) {
    modelEl.value = MODEL_DEFAULTS[newProvider] || '';
  }
  updateUIForProvider(newProvider);
});

saveBtn.addEventListener('click', () => {
  clearError();
  const provider      = providerEl.value;
  const apiKey        = apiKeyEl.value.trim();
  const model         = modelEl.value.trim() || MODEL_DEFAULTS[provider] || '';
  const baseUrl       = baseUrlEl.value.trim();
  const maxIterations = parseInt(maxIterEl.value, 10) || 20;
  const useVision     = useVisionEl.checked;

  if (NEEDS_API_KEY.includes(provider) && !apiKey) {
    showError('API key is required for this provider.');
    return;
  }

  chrome.storage.local.set(
    { provider, apiKey, model, baseUrl, maxIterations, useVision },
    () => {
      saveConfirm.textContent = 'Saved ✓';
      saveConfirm.style.color = '#16a34a';
      setTimeout(() => { saveConfirm.textContent = ''; }, 2000);
    }
  );
});
