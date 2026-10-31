import * as core from '../lib/browser-agent-core/background/index.js';
import { decisionOptions } from './decision-settings.js';
import { CdpInputControlBridge } from '../lib/browser-agent-input-control/index.js';

// Shared by task and script execution. Unset settings retain the CDP default.
export function createConfiguredInputControl({ inputBackend = 'cdp', bridge, inspector } = {}) {
  if (inputBackend === 'native') return new core.InputControlBridge();
  if (inputBackend === 'cdp') return new CdpInputControlBridge({ bridge, inspector });
  throw runtimeError('E_INPUT_BACKEND', 'Unknown input backend in extension settings');
}

// Jev makes browser choices, not text completions. Script translation uses
// the same configured helper LLM as normal Jev helper tasks.
export function createNativeScriptProvider(config, createProvider) {
  const llm = createProvider(config);
  return decisionOptions(config, createProvider, llm).helperLlm;
}

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || runtimeError('E_SCRIPT_ABORTED', 'Native script execution was aborted');
  }
}

/**
 * Own the desktop input lock from provider setup through script completion.
 * Factories are trusted embedding dependencies, never tool request fields.
 */
export function createNativeScriptRuntime({
  loadProvider,
  loadConfiguration = async () => ({}),
  isTaskRunning = () => false,
  createInputControl = () => new core.InputControlBridge(),
  createService = (options) => new core.NativeScriptService(options),
} = {}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async executeExternalScript(request) {
      throwIfAborted(request.signal);
      if (busy || isTaskRunning()) {
        throw runtimeError('E_BUSY', 'Desktop input is owned by another browser task or script');
      }
      busy = true;
      let inputControl;
      const onAbort = () => {
        try { Promise.resolve(inputControl?.abort()).catch(() => {}); } catch { /* best-effort cancellation cleanup */ }
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const config = await loadConfiguration();
        throwIfAborted(request.signal);
        const llm = await loadProvider(config);
        throwIfAborted(request.signal);
        inputControl = await createInputControl({ config, tabId: request.tabId });
        throwIfAborted(request.signal);
        const service = createService({ llm, inputControl });
        return await service.executeExternalScript(request);
      } finally {
        request.signal?.removeEventListener('abort', onAbort);
        try {
          await inputControl?.disconnect();
        } finally {
          busy = false;
        }
      }
    },
  };
}
