import {
  AgentCore, BrowserBridge, ActionExecutor, InputControlBridge,
  OpenAIProvider, AnthropicProvider, OllamaProvider, OpenRouterProvider, NvidiaProvider,
  OpenAICodexOAuthProvider, AnthropicOAuthProvider, GeminiOAuthProvider,
  buildOpenAIAuthUrl, buildAnthropicAuthUrl, buildGeminiAuthUrl,
  exchangeOpenAICode, exchangeAnthropicCode, exchangeGeminiCode,
  OPENAI_REDIRECT_URI, ANTHROPIC_REDIRECT_URI, GEMINI_REDIRECT_URI,
  setPendingOAuth, setPendingOAuthTabId, getPendingOAuth, clearPendingOAuth,
  storeOAuthTokens, getOAuthTokens, clearOAuthTokens, parseRedirectUrl,
} from '../lib/browser-agent-core/background/index.js';

let currentAgent = null;

// ─── OAuth callback interception ─────────────────────────────────────────────
// Registered at TOP LEVEL so it survives service worker restarts.
// State is stored in chrome.storage.session so it persists across restarts.

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only process main frame navigations
  if (details.frameId !== 0) return;

  const pending = await getPendingOAuth();
  if (!pending) return;
  if (details.tabId !== pending.tabId) return;

  const { url } = details;
  const redirectUri = getRedirectUri(pending.provider);
  if (!url.startsWith(redirectUri)) return;

  // We got the callback! Clean up pending state immediately.
  await clearPendingOAuth();

  // Close the auth tab gracefully
  chrome.tabs.remove(details.tabId).catch(() => {});

  // Parse code + state from URL
  const { code, state, error } = parseRedirectUrl(url);

  if (error || !code) {
    await notifyOAuthResult(pending.provider, { success: false, error: error || 'No code in redirect URL' });
    return;
  }

  // Validate state
  if (state && pending.state && state !== pending.state) {
    await notifyOAuthResult(pending.provider, { success: false, error: 'OAuth state mismatch (CSRF protection)' });
    return;
  }

  try {
    let tokens;
    switch (pending.provider) {
      case 'openai-codex':
        tokens = await exchangeOpenAICode(code, pending.verifier);
        break;
      case 'anthropic':
        tokens = await exchangeAnthropicCode(code, state || pending.verifier, pending.verifier);
        break;
      case 'gemini-cli':
        tokens = await exchangeGeminiCode(code, pending.verifier);
        break;
      default:
        throw new Error(`Unknown OAuth provider: ${pending.provider}`);
    }

    await storeOAuthTokens(pending.provider, tokens);
    await notifyOAuthResult(pending.provider, { success: true, email: tokens.email || tokens.accountId || null });
  } catch (err) {
    await notifyOAuthResult(pending.provider, { success: false, error: err.message });
  }
});

function getRedirectUri(provider) {
  switch (provider) {
    case 'openai-codex': return OPENAI_REDIRECT_URI;
    case 'anthropic':    return ANTHROPIC_REDIRECT_URI;
    case 'gemini-cli':   return GEMINI_REDIRECT_URI;
    default: return '';
  }
}

async function notifyOAuthResult(provider, result) {
  const status = { provider, ...result, timestamp: Date.now() };
  await chrome.storage.local.set({ lastOAuthResult: status });
  chrome.runtime.sendMessage({ type: 'oauth_result', status }).catch(() => {});
}

// ─── Message handler ──────────────────────────────────────────────────────────

function createProvider(config) {
  switch (config.provider) {
    case 'openai-codex':    return new OpenAICodexOAuthProvider({ model: config.model });
    case 'anthropic-oauth': return new AnthropicOAuthProvider({ model: config.model });
    case 'gemini-cli':      return new GeminiOAuthProvider({ model: config.model || 'gemini-2.0-flash' });
    case 'anthropic':       return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
    case 'ollama':          return new OllamaProvider({ baseUrl: config.baseUrl, model: config.model });
    case 'openrouter':      return new OpenRouterProvider({ apiKey: config.apiKey, model: config.model });
    case 'nvidia':          return new NvidiaProvider({ apiKey: config.apiKey, model: config.model });
    default:                return new OpenAIProvider({ apiKey: config.apiKey, model: config.model });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Agent control ────────────────────────────────────────────────────────────
  if (message.type === 'start_task') {
    chrome.storage.local.get(
      ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision'],
      (config) => {
        const llm = createProvider(config);
        const bridge = new BrowserBridge();
        const inputControl = new InputControlBridge();
        const executor = new ActionExecutor({ bridge, inputControl });

        currentAgent = new AgentCore({
          llm, bridge, executor,
          onStatus: (status) => bridge.sendStatus(status),
          maxIterations: config.maxIterations || 20,
          useVision: config.useVision !== false,
        });

        currentAgent.run(message.task).catch((err) => {
          bridge.sendStatus({
            state: 'error', message: err.message, timestamp: Date.now(),
            task: message.task, iteration: 0, maxIterations: 20,
            url: null, title: null, actionsCount: null,
          });
        });
      }
    );
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'stop_task') {
    if (currentAgent) currentAgent.stop();
    sendResponse({ stopped: true });
    return true;
  }

  // ── OAuth ────────────────────────────────────────────────────────────────────
  if (message.type === 'oauth_start') {
    const provider = message.provider; // 'openai-codex' | 'anthropic' | 'gemini-cli'
    handleOAuthStart(provider)
      .then(() => sendResponse({ started: true }))
      .catch(err => sendResponse({ started: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (message.type === 'oauth_logout') {
    const provider = message.provider;
    clearOAuthTokens(provider)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'oauth_status') {
    // Return login status for all three providers
    Promise.all([
      getOAuthTokens('openai-codex'),
      getOAuthTokens('anthropic'),
      getOAuthTokens('gemini-cli'),
    ]).then(([openai, anthropic, gemini]) => {
      sendResponse({
        'openai-codex': openai ? { loggedIn: true, accountId: openai.accountId || null, email: openai.email || null } : { loggedIn: false },
        'anthropic':    anthropic ? { loggedIn: true } : { loggedIn: false },
        'gemini-cli':   gemini ? { loggedIn: true, email: gemini.email || null, projectId: gemini.projectId || null } : { loggedIn: false },
      });
    });
    return true;
  }

});

async function handleOAuthStart(provider) {
  let authInfo;
  switch (provider) {
    case 'openai-codex': authInfo = await buildOpenAIAuthUrl(); break;
    case 'anthropic':    authInfo = await buildAnthropicAuthUrl(); break;
    case 'gemini-cli':   authInfo = await buildGeminiAuthUrl(); break;
    default: throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  const { url, verifier, state } = authInfo;

  // Store pending OAuth state BEFORE opening the tab
  await setPendingOAuth(provider, { verifier, state });

  // Open the auth tab
  const tab = await chrome.tabs.create({ url });

  // Update pending state with the tab ID
  await setPendingOAuthTabId(tab.id);
}
