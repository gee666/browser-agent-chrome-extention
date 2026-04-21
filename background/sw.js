import {
  AgentCore, ActionExecutor, InputControlBridge,
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
// TODO(public-api): importing from the package `src/` entry reaches across
// the pi-browser-agent-bridge package boundary. The sub-library maintainers
// should expose `createBridgeController` and `startBridge` from the package
// entry point so the extension can depend on a stable public API rather than
// internal file paths. Refactor is intentionally out of scope here.
import { createBridgeController, startBridge } from '../lib/pi-browser-agent-bridge/src/index.js';
import { createPiBridgeRuntime } from './pi-bridge-runtime.js';
import {
  createTaskError,
  isSettledByStatus,
  buildTaskResult,
  buildTaskResultFromRun,
  throwIfCancelled,
  TaskCancelledError,
} from './task-lifecycle.js';

const DEFAULT_INPUT_BACKEND = 'cdp';

let currentAgent = null;
let currentInputControl = null;
let currentTaskRun = null;

const piBridgeRuntime = createPiBridgeRuntime({
  chromeApi: chrome,
  logger: console,
  async onRunTask(params) {
    return await startAgentTask(params || {});
  },
});

function publishAgentStatus(status) {
  chrome.storage.local.set({ agentStatus: status });
  chrome.runtime.sendMessage({ type: 'agent_status', status }).catch(() => {});
}

function normalizeTaskError(error, fallbackCode = 'E_RUNTIME') {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return {
      code: typeof error.code === 'string' ? error.code : fallbackCode,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    details: error,
  };
}

function summarizeAgentHistory(agent) {
  // TODO(public-api): AgentCore currently exposes no public history accessor,
  // so we read the private `_history` field. browser-agent-core should add a
  // public `getHistorySummary()` (or equivalent) and this function should
  // call it. Refactor is intentionally out of scope here — this is a
  // documented cross-boundary read, not a new API addition.
  const historyFromPublicApi = typeof agent?.getHistorySummary === 'function'
    ? agent.getHistorySummary()
    : null;
  if (historyFromPublicApi && Array.isArray(historyFromPublicApi.recentSteps)) {
    return historyFromPublicApi;
  }
  const history = Array.isArray(agent?._history) ? agent._history : [];
  const entries = history.slice(-8).map((step) => ({
    stepNumber: typeof step?.stepNumber === 'number' ? step.stepNumber : null,
    evaluation: typeof step?.evaluation === 'string' ? step.evaluation : '',
    memory: typeof step?.memory === 'string' ? step.memory : '',
    nextGoal: typeof step?.nextGoal === 'string' ? step.nextGoal : '',
    actionResult: typeof step?.actionResult === 'string' ? step.actionResult : '',
  }));

  const lines = entries.map((entry, index) => {
    const parts = [];
    const num = typeof entry.stepNumber === 'number' ? entry.stepNumber + 1 : index + 1;
    if (entry.evaluation) parts.push(`evaluation: ${entry.evaluation}`);
    if (entry.nextGoal) parts.push(`next: ${entry.nextGoal}`);
    if (entry.actionResult) parts.push(`result: ${entry.actionResult}`);
    else if (entry.memory) parts.push(`memory: ${entry.memory}`);
    return `${num}. ${parts.join(' | ') || 'step recorded'}`;
  });

  return {
    steps: history.length,
    recentSteps: entries,
    text: lines.join('\n'),
  };
}

function stopCurrentTask() {
  const hadRunningTask = !!currentTaskRun;
  if (currentTaskRun) currentTaskRun.cancelRequested = true;
  if (currentAgent) currentAgent.stop();
  if (currentInputControl) {
    currentInputControl.abort();
    currentInputControl = null;
  }
  currentAgent = null;

  const status = {
    state: hadRunningTask ? 'stopping' : 'stopped', timestamp: Date.now(),
    task: hadRunningTask ? currentTaskRun?.task || null : null,
    iteration: 0, maxIterations: 0, url: null, title: null,
  };
  publishAgentStatus(status);
  return status;
}

function createDebugLogger(isDebug) {
  return isDebug ? async (entry) => {
    try {
      const baseName = makeDebugFilename(entry).replace(/\.md$/, '');
      const mdFilename = baseName + '.md';
      const jpgFilename = baseName + '.jpg';

      const root = await self.navigator.storage.getDirectory();
      const logsDir = await root.getDirectoryHandle('logs', { create: true });

      let screenshotFile = null;
      if (entry.screenshot) {
        try {
          const b64 = entry.screenshot.split(',')[1];
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
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

      const content = formatDebugEntry({ ...entry, screenshotFile });
      const mh = await logsDir.getFileHandle(mdFilename, { create: true });
      const mw = await mh.createWritable();
      await mw.write(content);
      await mw.close();
    } catch (e) {
      console.warn('[sw] debugLog OPFS write failed:', e);
    }
  } : null;
}

async function loadAgentConfig() {
  return await new Promise((resolve, reject) => {
    chrome.storage.local.get(
      ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision', 'debugMode', 'inputBackend'],
      (config) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(config);
      },
    );
  });
}

async function startAgentTask({
  taskId = null,
  task,
  debugMode = false,
  url = null,
  tabId = null,
  tab_id = null,
  useActiveTab = false,
  use_active_tab = false,
  maxIterations: maxIterationsOverride = null,
  max_iterations = null,
  useVision = null,
  use_vision = null,
} = {}) {
  if (currentTaskRun) {
    throw createTaskError('E_BUSY', `Browser task ${currentTaskRun.taskId || 'current'} is already running`, {
      taskId: currentTaskRun.taskId || null,
      task: currentTaskRun.task || null,
    });
  }

  const taskRun = {
    taskId,
    task,
    startedAt: Date.now(),
    terminalResult: null,
    settled: false,
    cancelRequested: false,
    resolve: null,
    reject: null,
    promise: null,
    finish: null,
  };
  taskRun.promise = new Promise((resolve, reject) => {
    taskRun.resolve = resolve;
    taskRun.reject = reject;
  });
  currentTaskRun = taskRun;

  const settle = (result) => {
    if (taskRun.settled) return taskRun.terminalResult;
    taskRun.settled = true;
    taskRun.terminalResult = result;
    if (currentTaskRun === taskRun) {
      currentTaskRun = null;
      currentAgent = null;
    }
    taskRun.resolve(result);
    return result;
  };
  taskRun.finish = settle;

  try {
    const config = await loadAgentConfig();
    throwIfCancelled(taskRun, 'config load');

    let inputBackend = config.inputBackend;
    if (!inputBackend) {
      inputBackend = DEFAULT_INPUT_BACKEND;
      chrome.storage.local.set({ inputBackend: DEFAULT_INPUT_BACKEND });
    }

    const llm = createProvider(config);
    const target = await piBridgeRuntime.resolveRunTaskTab({
      tabId: tabId ?? tab_id,
      useActiveTab: useActiveTab || use_active_tab,
    });
    throwIfCancelled(taskRun, 'tab resolution');

    const bridge = await piBridgeRuntime.createAgentBrowserBridge(target.tabId);
    throwIfCancelled(taskRun, 'bridge creation');

    await chrome.tabs.update(target.tabId, { active: true }).catch(() => {});
    if (url) {
      try {
        await bridge.navigate(url);
      } catch (error) {
        throw createTaskError('E_NAV_TIMEOUT', error?.message || `Failed to navigate task tab to ${url}`, { url, tabId: target.tabId });
      }
      throwIfCancelled(taskRun, 'initial navigation');
    }

    currentInputControl = createInputControl({ inputBackend, bridge, inspector: piBridgeRuntime.inspector });
    const executor = new ActionExecutor({ bridge, inputControl: currentInputControl });
    const runInputControl = currentInputControl;
    const maxIterations = (maxIterationsOverride ?? max_iterations ?? config.maxIterations) || 20;
    const debugLog = createDebugLogger(!!(debugMode || config.debugMode));

    let lastStatus = null;

    // Final cancellation gate before constructing / running the agent.
    throwIfCancelled(taskRun, 'agent construction');

    currentAgent = new AgentCore({
      llm,
      bridge,
      executor,
      onStatus: (status) => {
        const terminalState = status.state;
        // TODO(public-api): we copy the status into lastStatus and then mutate
        // the original `status` passed in by AgentCore to map recoverable
        // errors to a non-terminal 'thinking' state. This relies on the
        // AgentCore callback contract allowing in-place mutation. The
        // sub-library should expose a structured recoverable-error signal so
        // this mutation is not needed. Refactor is intentionally out of scope
        // here.
        lastStatus = { ...status };

        if (terminalState === 'error') {
          status.state = 'thinking';
          status.recoverable = true;
          status.recoverableErrorMessage = status.message || null;
        }

        if (isSettledByStatus(terminalState)) {
          settle(buildTaskResult(taskRun, terminalState, {
            message: status.message || null,
            finalStatus: lastStatus,
            historySummary: summarizeAgentHistory(currentAgent),
          }));
        }
      },
      maxIterations,
      useVision: (useVision ?? use_vision ?? config.useVision) !== false,
      debugLog,
    });

    currentAgent.run(task)
      .then((runResult) => {
        const result = {
          ...buildTaskResultFromRun(taskRun, { runResult, lastStatus }),
          historySummary: summarizeAgentHistory(currentAgent),
        };
        if (result.finalStatus) publishAgentStatus(result.finalStatus);
        settle(result);
      })
      .catch((err) => {
        const normalizedError = normalizeTaskError(err);
        const errorStatus = {
          state: 'error', message: normalizedError.message, timestamp: Date.now(),
          task, iteration: 0, maxIterations,
          url: null, title: null, actionsCount: null,
        };
        bridge.sendStatus(errorStatus);
        settle(buildTaskResult(taskRun, 'error', {
          message: normalizedError.message,
          error: createTaskError(normalizedError.code, normalizedError.message, normalizedError.details),
          finalStatus: errorStatus,
          historySummary: summarizeAgentHistory(currentAgent),
        }));
      })
      .finally(() => {
        try {
          if (runInputControl && typeof runInputControl.disconnect === 'function') {
            runInputControl.disconnect();
          }
        } catch (e) {
          console.warn('[sw] inputControl.disconnect() threw:', e);
        }
        if (currentInputControl === runInputControl) currentInputControl = null;
      });
  } catch (error) {
    if (error instanceof TaskCancelledError) {
      const cancelStatus = {
        state: 'stopped',
        message: error.message,
        timestamp: Date.now(),
        task,
        iteration: 0,
        maxIterations: 0,
        url: null,
        title: null,
      };
      publishAgentStatus(cancelStatus);
      settle(buildTaskResult(taskRun, 'stopped', {
        cancelled: true,
        message: error.message,
        finalStatus: cancelStatus,
      }));
    } else {
      const normalizedError = normalizeTaskError(error);
      const errorStatus = {
        state: 'error',
        message: normalizedError.message,
        timestamp: Date.now(),
        task,
        iteration: 0,
        maxIterations: 0,
        url: null,
        title: null,
        actionsCount: null,
      };
      publishAgentStatus(errorStatus);
      const result = buildTaskResult(taskRun, 'error', {
        message: normalizedError.message,
        error: createTaskError(normalizedError.code, normalizedError.message, normalizedError.details),
        finalStatus: errorStatus,
        historySummary: summarizeAgentHistory(currentAgent),
      });
      settle(result);
    }
  }

  return await taskRun.promise;
}

const piBridgeController = createBridgeController({
  storageArea: chrome.storage.local,
  logger: console,
  startBridgeImpl(config) {
    return startBridge({
      enabled: config.enabled,
      url: config.url,
      autoConnect: true,
      logger: console,
      helloPayload: {
        v: 1,
        kind: 'hello',
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        capabilities: [...piBridgeRuntime.capabilities],
      },
      async handleRequest(frame) {
        try {
          return await piBridgeRuntime.handleRequest(frame);
        } catch (error) {
          throw error?.code ? error : createTaskError('E_INTERNAL', error?.message || String(error), error);
        }
      },
    });
  },
});

const PI_BRIDGE_RECONNECT_ALARM = 'pi-bridge-reconnect';

async function ensurePiBridgeReconnectAlarm() {
  try {
    await chrome.alarms.create(PI_BRIDGE_RECONNECT_ALARM, { periodInMinutes: 0.4 });
  } catch (error) {
    console.warn('[sw] failed to schedule pi bridge reconnect alarm', error);
  }
}

async function bootPiBridge() {
  try {
    await ensurePiBridgeReconnectAlarm();
    const bridge = await piBridgeController.refreshFromStorage();
    await piBridgeRuntime.setEnabled(bridge?.config?.enabled !== false);
  } catch (error) {
    console.error('[sw] pi bridge startup failed', error);
  }
}

chrome.runtime.onStartup.addListener(() => {
  void bootPiBridge();
});

chrome.runtime.onInstalled.addListener(() => {
  void bootPiBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PI_BRIDGE_RECONNECT_ALARM) return;
  const bridge = piBridgeController.getCurrentBridge();
  if (!bridge?.config?.enabled) {
    return;
  }
  if (bridge?.client?.isConnected) {
    bridge.client.send({ v: 1, kind: 'probe', id: `keepalive-${Date.now()}` });
    return;
  }
  void bootPiBridge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.piBridgeConfig) {
    void bootPiBridge();
  }
});

void bootPiBridge();

/**
 * Create an input-control bridge based on the configured backend.
 *   - 'native' -> InputControlBridge (python-input-control via native messaging)
 *   - 'cdp'    -> CdpInputControlBridge (Chrome DevTools Protocol) — default
 */
function createInputControl({ inputBackend, bridge, inspector }) {
  if (inputBackend === 'native') {
    return new InputControlBridge();
  }
  return new CdpInputControlBridge({ bridge, inspector });
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

  // Validate state. When a pending state was generated and stored, the
  // returned state MUST match exactly. A callback with no state at all must
  // fail closed — CSRF protection should not be skippable by omitting the
  // parameter.
  if (pending.state && state !== pending.state) {
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
    if (currentTaskRun) {
      sendResponse({
        started: false,
        error: `Browser task ${currentTaskRun.taskId || 'current'} is already running`,
        code: 'E_BUSY',
      });
      return true;
    }

    startAgentTask({ task: message.task, debugMode: message.debugMode, useActiveTab: true })
      .catch((error) => {
        console.warn('[sw] start_task failed', error);
      });
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'stop_task') {
    stopCurrentTask();
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
