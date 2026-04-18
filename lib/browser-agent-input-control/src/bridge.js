// CdpInputControlBridge — drop-in replacement for
// browser-agent-core/background/input-control.js's InputControlBridge but
// backed by the Chrome DevTools Protocol instead of a native-messaging host.

import { InputControlAbortError, InputControlError, InputControlTimeoutError } from './errors.js';
import { CdpKeyboardBackend } from './backends/keyboard.js';
import { CdpMouseBackend } from './backends/mouse.js';
import { DebuggerTransport } from './debugger-transport.js';
import { Dispatcher } from './dispatcher.js';
import { SeededRandom } from './randomness.js';

function randomId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Cheap fallback for older Node in tests.
  return `cmd-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Timeout picker — matches the existing InputControlBridge semantics so
 * ActionExecutor doesn't need to know which bridge it got.
 */
function timeoutFor(command, params) {
  if (command === 'type' && typeof params?.text === 'string') {
    const wpm = params.wpm || 60;
    const chars = params.text.length;
    const typingMs = Math.ceil((chars / (wpm * 5)) * 60_000);
    return Math.max(30_000, typingMs + 10_000);
  }
  return 30_000;
}

export class CdpInputControlBridge {
  /**
   * @param {{
   *   bridge?: { getActiveTabId(): number | Promise<number> },
   *   transport?: object,
   *   rng?: object,
   *   mouseBackend?: object,
   *   keyboardBackend?: object,
   * }} [options]
   */
  constructor(options = {}) {
    this._browserBridge = options.bridge || null;
    this._rng = options.rng || new SeededRandom();
    this._transport = options.transport || new DebuggerTransport();
    this._activeTabId = null;

    const getTabId = () => {
      if (this._activeTabId == null) {
        throw new InputControlError('No active tab resolved for CDP command');
      }
      return this._activeTabId;
    };

    this._mouse = options.mouseBackend || new CdpMouseBackend({ transport: this._transport, getTabId, rng: this._rng });
    this._keyboard = options.keyboardBackend || new CdpKeyboardBackend({ transport: this._transport, getTabId, rng: this._rng });
    this._dispatcher = new Dispatcher({ mouseBackend: this._mouse, keyboardBackend: this._keyboard });

    this._pending = new Set(); // Set<{ reject, controller, timer }>
    this._closed = false;
  }

  async _resolveTabId() {
    if (!this._browserBridge || typeof this._browserBridge.getActiveTabId !== 'function') {
      throw new InputControlError('CdpInputControlBridge requires a bridge with getActiveTabId()');
    }
    const tabId = await this._browserBridge.getActiveTabId();
    if (typeof tabId !== 'number') {
      throw new InputControlError('getActiveTabId() did not return a numeric tab id');
    }
    this._activeTabId = tabId;
    return tabId;
  }

  /**
   * Execute one command. Resolves with { id, status: 'ok' } on success, or
   * rejects with an InputControlError / InputControlAbortError /
   * InputControlTimeoutError on failure.
   */
  execute(command, params, context) {
    if (this._closed) {
      return Promise.reject(new InputControlError('Bridge has been disconnected'));
    }
    const id = randomId();
    const envelope = { id, command, params: params || {}, context: context || {} };
    const controller = new AbortController();
    const timeoutMs = timeoutFor(command, params);

    return new Promise((resolve, reject) => {
      const entry = { reject, controller, timer: null };
      this._pending.add(entry);

      const settle = (fn) => (value) => {
        if (entry.timer) clearTimeout(entry.timer);
        this._pending.delete(entry);
        fn(value);
      };
      const resolveSafe = settle(resolve);
      const rejectSafe = settle(reject);

      entry.timer = setTimeout(() => {
        if (!this._pending.has(entry)) return;
        controller.abort();
        rejectSafe(new InputControlTimeoutError());
      }, timeoutMs);

      // Resolve tab id lazily on the first await so constructors stay sync.
      (async () => {
        try {
          await this._resolveTabId();
        } catch (err) {
          rejectSafe(err instanceof InputControlError ? err : new InputControlError(String(err && err.message || err)));
          return;
        }
        let response;
        try {
          response = await this._dispatcher.handle(envelope, controller.signal);
        } catch (err) {
          // Defensive: dispatcher.handle should never throw.
          rejectSafe(err instanceof Error ? err : new InputControlError(String(err)));
          return;
        }
        if (controller.signal.aborted && response && response.status === 'error' && response.error === 'Command cancelled') {
          rejectSafe(new InputControlAbortError());
          return;
        }
        if (response && response.status === 'error') {
          rejectSafe(new InputControlError(response.error || 'Unknown error'));
          return;
        }
        resolveSafe(response);
      })();
    });
  }

  /** Trip the abort controller for every in-flight execute(). */
  abort() {
    const entries = [...this._pending];
    this._pending.clear();
    const abortError = new InputControlAbortError();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.controller.abort();
      } catch {
        // ignore
      }
      entry.reject(abortError);
    }
    // Detach async; don't wait for it — consumers just want abort() to return
    // promptly so Run can be re-enabled.
    Promise.resolve()
      .then(() => this._transport.detach())
      .catch(() => {});
    this._activeTabId = null;
  }

  /** Detach debugger and permanently close the bridge. */
  disconnect() {
    this._closed = true;
    this.abort();
    try {
      if (typeof this._transport.dispose === 'function') this._transport.dispose();
    } catch {
      // ignore
    }
  }
}
