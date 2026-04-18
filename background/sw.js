import {
  AgentCore, BrowserBridge, ActionExecutor, InputControlBridge,
  OpenAIProvider, AnthropicProvider, OllamaProvider, OpenRouterProvider, NvidiaProvider,
  OpenAICodexOAuthProvider, AnthropicOAuthProvider, GeminiOAuthProvider,
  buildOpenAIAuthUrl, buildAnthropicAuthUrl, buildGeminiAuthUrl,
  exchangeOpenAICode, exchangeAnthropicCode, exchangeGeminiCode,
  OPENAI_REDIRECT_URI, ANTHROPIC_REDIRECT_URI, GEMINI_REDIRECT_URI,
  setPendingOAuth, setPendingOAuthTabId, getPendingOAuth, clearPendingOAuth,
  storeOAuthTokens, getOAuthTokens, clearOAuthTokens, parseRedirectUrl,
  formatDebugEntry, makeDebugFilename,
} from '../lib/browser-agent-core/background/index.js';
import { CdpInputControlBridge } from '../lib/browser-agent-input-control/index.js';

const DEFAULT_INPUT_BACKEND = 'cdp';

let currentAgent = null;
let currentInputControl = null;

/**
 * Create an input-control bridge based on the configured backend.
 *   - 'native' -> InputControlBridge (python-input-control via native messaging)
 *   - 'cdp'    -> CdpInputControlBridge (Chrome DevTools Protocol) — default
 */
function createInputControl({ inputBackend, bridge }) {
  if (inputBackend === 'native') {
    return new InputControlBridge();
  }
  return new CdpInputControlBridge({ bridge });
}

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
      ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision', 'debugMode', 'inputBackend'],
      (config) => {
        // Resolve input backend. If unset (fresh install / upgrade), default to
        // 'cdp' and persist it so the Settings UI reflects reality on first open.
        let inputBackend = config.inputBackend;
        if (!inputBackend) {
          inputBackend = DEFAULT_INPUT_BACKEND;
          chrome.storage.local.set({ inputBackend: DEFAULT_INPUT_BACKEND });
        }

        const llm = createProvider(config);
        const bridge = new BrowserBridge();
        currentInputControl = createInputControl({ inputBackend, bridge });
        const executor = new ActionExecutor({ bridge, inputControl: currentInputControl });

        // ── Debug logging ────────────────────────────────────────────────────
        // Enabled either by the popup checkbox (message.debugMode) or the
        // persisted storage flag (config.debugMode).
        const isDebug = !!(message.debugMode || config.debugMode);
        // Debug logs are written to the Origin Private File System (OPFS).
        // This is silent — no download dialogs, no interaction with Chrome's
        // "Ask where to save" setting.  Logs are browsed via the in-extension
        // viewer page (popup → "View Logs" link).
        const debugLog = isDebug ? async (entry) => {
          try {
            const baseName    = makeDebugFilename(entry).replace(/\.md$/, '');
            const mdFilename  = baseName + '.md';
            const jpgFilename = baseName + '.jpg';

            const root     = await self.navigator.storage.getDirectory();
            const logsDir  = await root.getDirectoryHandle('logs', { create: true });

            // Save annotated screenshot (base64 JPEG data URL → raw bytes)
            let screenshotFile = null;
            if (entry.screenshot) {
              try {
                const b64    = entry.screenshot.split(',')[1];
                const binary = atob(b64);
                const bytes  = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const fh = await logsDir.getFileHandle(jpgFilename, { create: true });
                const wr = await fh.createWritable();
                await wr.write(bytes.buffer);
                await wr.close();
                screenshotFile = jpgFilename;
              } catch (imgErr) {
                console.warn('[sw] screenshot OPFS write failed:', imgErr);
              }
            }

            // Save markdown log
            const content = formatDebugEntry({ ...entry, screenshotFile });
            const mh = await logsDir.getFileHandle(mdFilename, { create: true });
            const mw = await mh.createWritable();
            await mw.write(content);
            await mw.close();

          } catch (e) {
            console.warn('[sw] debugLog OPFS write failed:', e);
          }
        } : null;
        // ─────────────────────────────────────────────────────────────────────

        currentAgent = new AgentCore({
          llm, bridge, executor,
          onStatus: (status) => bridge.sendStatus(status),
          maxIterations: config.maxIterations || 20,
          useVision: config.useVision !== false,
          debugLog,
        });

        // Capture the bridge we just created so `finally` can tear it down
        // even if `stop_task` swapped `currentInputControl` to null meanwhile.
        const runInputControl = currentInputControl;
        currentAgent.run(message.task)
          .catch((err) => {
            bridge.sendStatus({
              state: 'error', message: err.message, timestamp: Date.now(),
              task: message.task, iteration: 0, maxIterations: 20,
              url: null, title: null, actionsCount: null,
            });
          })
          .finally(() => {
            // End-of-task cleanup: disconnect the input-control bridge so the
            // CDP backend detaches chrome.debugger (yellow banner goes away)
            // and the native backend closes its stdio port. This runs on
            // every terminal path — success (done), failure, stop, max-iters,
            // and uncaught errors — so we never leave the debugger attached.
            try {
              if (runInputControl && typeof runInputControl.disconnect === 'function') {
                runInputControl.disconnect();
              }
            } catch (e) {
              console.warn('[sw] inputControl.disconnect() threw:', e);
            }
            // Only clear the module-level refs if they're still pointing at
            // this run (stop_task may already have nulled them out).
            if (currentInputControl === runInputControl) currentInputControl = null;
          });
      }
    );
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'stop_task') {
    if (currentAgent) currentAgent.stop();
    // Abort the native input-control bridge immediately: this rejects any
    // in-flight executor promise (so the agent loop unblocks right away) and
    // disconnects the port (sending EOF to Python, stopping any ongoing typing
    // or mouse movement within one inter-key delay).
    if (currentInputControl) {
      currentInputControl.abort();
      currentInputControl = null;
    }
    currentAgent = null;
    // Always reset stored status to 'stopped' so the popup re-enables the Run
    // button even if the service worker was restarted and has no running agent
    // (the previous run was force-killed, leaving stale 'running' in storage).
    const stoppedStatus = {
      state: 'stopped', timestamp: Date.now(),
      task: null, iteration: 0, maxIterations: 0, url: null, title: null,
    };
    chrome.storage.local.set({ agentStatus: stoppedStatus });
    chrome.runtime.sendMessage({ type: 'agent_status', status: stoppedStatus }).catch(() => {});
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
