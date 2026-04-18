// Wraps chrome.debugger so backends can send CDP commands without caring
// about attach/detach bookkeeping. Exposes a small surface so tests can
// swap in a FakeTransport.

import { InputControlError } from './errors.js';

const DEBUGGER_PROTOCOL_VERSION = '1.3';

/**
 * @typedef {Object} ChromeDebuggerLike
 * @property {(target: object, version: string) => Promise<void>} attach
 * @property {(target: object) => Promise<void>} detach
 * @property {(target: object, method: string, params?: object) => Promise<any>} sendCommand
 * @property {{ addListener: Function, removeListener: Function }} [onDetach]
 */

export class DebuggerTransport {
  /**
   * @param {{ debuggerApi?: ChromeDebuggerLike }} [options]
   */
  constructor(options = {}) {
    this._api = options.debuggerApi || (typeof chrome !== 'undefined' ? chrome.debugger : null);
    if (!this._api) {
      // Don't throw here — test code may inject a fake transport instead of
      // going through this class. Real constructions without chrome.debugger
      // will surface an error on the first attach attempt.
    }
    this._attached = new Set(); // Set<number> of tabIds we attached ourselves.
    this._onDetachHandler = null;
    if (this._api && this._api.onDetach && typeof this._api.onDetach.addListener === 'function') {
      this._onDetachHandler = (source, _reason) => {
        if (source && typeof source.tabId === 'number') {
          this._attached.delete(source.tabId);
        }
      };
      this._api.onDetach.addListener(this._onDetachHandler);
    }
  }

  /** Ensure we are attached to the given tab. No-op if already attached. */
  async ensureAttached(tabId) {
    if (!this._api) {
      throw new InputControlError('chrome.debugger API is unavailable');
    }
    if (typeof tabId !== 'number') {
      throw new InputControlError('tabId must be a number');
    }
    if (this._attached.has(tabId)) return;
    try {
      await this._api.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      this._attached.add(tabId);
    } catch (err) {
      throw new InputControlError(
        `Failed to attach debugger to tab ${tabId}: ${err && err.message ? err.message : err}`
      );
    }
  }

  /** Send a CDP command on the given tab; attach first if needed. */
  async send(tabId, method, params = {}) {
    await this.ensureAttached(tabId);
    try {
      return await this._api.sendCommand({ tabId }, method, params);
    } catch (err) {
      throw new InputControlError(
        `CDP command ${method} failed: ${err && err.message ? err.message : err}`
      );
    }
  }

  /** Detach from a single tab (or all attached tabs). */
  async detach(tabId) {
    if (!this._api) return;
    const targets = tabId != null ? [tabId] : [...this._attached];
    for (const id of targets) {
      try {
        await this._api.detach({ tabId: id });
      } catch {
        // ignore — tab may already be gone
      }
      this._attached.delete(id);
    }
  }

  /** Fully tear down state and stop listening for onDetach events. */
  dispose() {
    if (this._api && this._onDetachHandler && this._api.onDetach && typeof this._api.onDetach.removeListener === 'function') {
      this._api.onDetach.removeListener(this._onDetachHandler);
    }
    this._onDetachHandler = null;
    this._attached.clear();
  }

  /** Is this transport currently attached to the given tab? */
  isAttached(tabId) {
    return this._attached.has(tabId);
  }
}
