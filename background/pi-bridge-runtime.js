import { BrowserBridge } from '../lib/browser-agent-core/background/browser-bridge.js';
import {
  CdpInspector,
} from '../lib/pi-browser-agent-bridge/src/index.js';
import { createBridgeDispatcher } from '../lib/pi-browser-agent-bridge/src/dispatcher.js';
import { createObservabilityLifecycle } from '../lib/pi-browser-agent-bridge/src/buffers/lifecycle.js';
import { createBufferedObservabilityHandlers } from '../lib/pi-browser-agent-bridge/src/handlers/observability-family.js';
import { createJsNavigationDestructiveHandlers } from '../lib/pi-browser-agent-bridge/src/handlers/js-navigation-family.js';
import { createReadOnlyHandlers } from '../lib/pi-browser-agent-bridge/src/handlers/read-only/index.js';

const AGENT_TAB_STORAGE_KEY = 'piBridge.agentTabId';
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const SETTLE_DELAY_MS = 500;
const SERIAL_REQUEST_TYPES = [
  'browser_get_screenshot',
  'browser_get_html',
  'browser_get_dom_info',
  'browser_get_computed_styles',
  'browser_wait_for',
  'browser_get_accessibility_tree',
  'browser_get_performance_metrics',
  'browser_evaluate_js',
  'browser_run_js',
  'browser_navigate',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_reload',
  'browser_reload_extension',
  'browser_clear_site_data',
];

function createProtocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeWaitUntil(waitUntil) {
  if (!waitUntil) return 'settle';
  if (['load', 'networkidle', 'settle', 'none'].includes(waitUntil)) {
    return waitUntil;
  }
  throw createProtocolError('E_VALIDATION', `Unsupported wait_until value: ${waitUntil}`);
}

function removeTabListeners(tabsApi, listeners) {
  try {
    tabsApi?.onUpdated?.removeListener?.(listeners.onUpdated);
    tabsApi?.onRemoved?.removeListener?.(listeners.onRemoved);
  } catch {
    // ignore listener cleanup failures
  }
}

function buildContentScriptFunctionBody(mode) {
  if (mode === 'html') {
    return function collectHtml({ selector, selectorAll, strip }) {
      const cloneNode = (node) => node.cloneNode(true);
      const stripClone = (root, stripValues) => {
        const stripSet = new Set(Array.isArray(stripValues) ? stripValues : []);
        if (stripSet.has('script')) {
          root.querySelectorAll('script').forEach((element) => element.remove());
        }
        if (stripSet.has('style')) {
          root.querySelectorAll('style').forEach((element) => element.remove());
        }
        if (stripSet.has('comments')) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
          const comments = [];
          while (walker.nextNode()) comments.push(walker.currentNode);
          comments.forEach((comment) => comment.remove());
        }
      };

      if (!selector) {
        const root = cloneNode(document.documentElement);
        stripClone(root, strip);
        return {
          html: root.outerHTML,
          url: location.href,
          title: document.title,
        };
      }

      const elements = Array.from(document.querySelectorAll(selector));
      const selected = selectorAll ? elements : elements.slice(0, 1);
      const html = selected.map((element) => {
        const root = cloneNode(element);
        stripClone(root, strip);
        return root.outerHTML;
      }).join('\n');
      return {
        html,
        matches: elements.length,
        selector,
        url: location.href,
        title: document.title,
      };
    };
  }

  if (mode === 'domInfo') {
    return function collectDomInfo({ selector, selectorAll, limit, include }) {
      const includeSet = new Set(Array.isArray(include) && include.length > 0
        ? include
        : ['attributes', 'rect', 'textContent', 'accessibility', 'visibility', 'event_listeners']);
      const elements = Array.from(document.querySelectorAll(selector)).slice(0, selectorAll ? limit : 1);
      const results = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const computed = window.getComputedStyle(element);
        const attributes = {};
        const notes = [];
        if (includeSet.has('attributes')) {
          for (const attribute of element.getAttributeNames()) {
            attributes[attribute] = element.getAttribute(attribute);
          }
        }
        if (includeSet.has('event_listeners')) {
          notes.push('event_listeners are not available from this bridge runtime');
        }
        return {
          tag: element.tagName.toLowerCase(),
          selector,
          attributes: includeSet.has('attributes') ? attributes : undefined,
          rect: includeSet.has('rect') ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          } : undefined,
          textContent: includeSet.has('textContent') ? (element.textContent || '').trim() : undefined,
          innerHTML: includeSet.has('innerHTML') ? element.innerHTML : undefined,
          outer_html: includeSet.has('outer_html') ? element.outerHTML : undefined,
          visibility: includeSet.has('visibility') ? {
            display: computed.display,
            visibility: computed.visibility,
            opacity: computed.opacity,
            hidden: computed.display === 'none' || computed.visibility === 'hidden' || rect.width === 0 || rect.height === 0,
          } : undefined,
          accessibility: includeSet.has('accessibility') ? {
            role: element.getAttribute('role') || undefined,
            ariaLabel: element.getAttribute('aria-label') || undefined,
            ariaDescription: element.getAttribute('aria-description') || undefined,
            ariaLabelledBy: element.getAttribute('aria-labelledby') || undefined,
          } : undefined,
          notes: notes.length > 0 ? notes : undefined,
        };
      });

      return {
        selector,
        count: results.length,
        elements: results,
        url: location.href,
        title: document.title,
      };
    };
  }

  if (mode === 'computedStyles') {
    return function collectComputedStyles({ selector, properties, pseudo, includeMatchedRules, includeInherited, includeBoxModel }) {
      const element = document.querySelector(selector);
      if (!element) {
        return { selector, found: false, properties: {} };
      }

      const style = window.getComputedStyle(element, pseudo || undefined);
      const propertyNames = Array.isArray(properties) && properties.length > 0
        ? properties
        : Array.from(style);
      const computed = {};
      for (const property of propertyNames) {
        computed[property] = style.getPropertyValue(property);
      }
      const rect = element.getBoundingClientRect();
      const notes = [];
      if (includeMatchedRules) {
        notes.push('matched_rules are not currently available from this bridge runtime');
      }
      if (includeInherited) {
        notes.push('inherited styles are not currently available from this bridge runtime');
      }
      return {
        selector,
        found: true,
        pseudo: pseudo || null,
        properties: computed,
        matched_rules: includeMatchedRules ? [] : undefined,
        inherited: includeInherited ? [] : undefined,
        notes: notes.length > 0 ? notes : undefined,
        box_model: includeBoxModel ? {
          width: rect.width,
          height: rect.height,
          marginTop: style.marginTop,
          marginRight: style.marginRight,
          marginBottom: style.marginBottom,
          marginLeft: style.marginLeft,
          paddingTop: style.paddingTop,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          borderTopWidth: style.borderTopWidth,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          borderLeftWidth: style.borderLeftWidth,
        } : undefined,
      };
    };
  }

  if (mode === 'selectorRect') {
    return function getSelectorRect({ selector }) {
      if (!selector) return null;
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: window.scrollX + rect.left,
        y: window.scrollY + rect.top,
        width: rect.width,
        height: rect.height,
      };
    };
  }

  return function unknownMode() {
    return null;
  };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPiBridgeRuntime({
  chromeApi = chrome,
  logger = console,
  storageArea = chrome.storage.local,
  onRunTask,
} = {}) {
  const tabsApi = chromeApi.tabs;
  const windowsApi = chromeApi.windows;
  const scriptingApi = chromeApi.scripting;
  const debuggerApi = chromeApi.debugger;
  const browsingDataApi = chromeApi.browsingData;
  const runtimeApi = chromeApi.runtime;

  const inspector = new CdpInspector({ debuggerApi });
  const observability = createObservabilityLifecycle({
    inspector,
    storageArea,
    tabsApi,
    logger,
  });

  let hooksAttached = false;
  let warmed = false;
  let cachedAgentTabId = null;

  async function storageGet(keys) {
    return await new Promise((resolve) => {
      storageArea.get(keys, (value) => resolve(value || {}));
    });
  }

  async function storageSet(value) {
    return await new Promise((resolve) => {
      storageArea.set(value, () => resolve());
    });
  }

  async function executeInTab(tabId, mode, params = {}) {
    const [{ result } = {}] = await scriptingApi.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: buildContentScriptFunctionBody(mode),
      args: [params],
    }).catch((error) => {
      throw createProtocolError('E_INTERNAL', `Failed to execute content script for ${mode}`, error);
    });
    return result;
  }

  async function getTab(tabId) {
    return await tabsApi.get(tabId).catch(() => null);
  }

  async function persistAgentTabId(tabId) {
    cachedAgentTabId = tabId;
    await storageSet({ [AGENT_TAB_STORAGE_KEY]: tabId }).catch(() => {});
  }

  async function getStoredAgentTabId() {
    if (typeof cachedAgentTabId === 'number') {
      return cachedAgentTabId;
    }
    const stored = await storageGet([AGENT_TAB_STORAGE_KEY]);
    cachedAgentTabId = Number.isFinite(stored?.[AGENT_TAB_STORAGE_KEY]) ? stored[AGENT_TAB_STORAGE_KEY] : null;
    return cachedAgentTabId;
  }

  async function ensureAgentTab() {
    const storedTabId = await getStoredAgentTabId();
    const storedTab = typeof storedTabId === 'number' ? await getTab(storedTabId) : null;
    if (storedTab && typeof storedTab.id === 'number') {
      const storedUrl = typeof storedTab.url === 'string' ? storedTab.url : '';
      const needsMigration = storedUrl === 'about:blank' || storedUrl.startsWith('chrome://') || storedUrl.startsWith('edge://');

      if (!needsMigration) {
        if (!storedTab.pinned) {
          try {
            await tabsApi.update(storedTab.id, { pinned: true });
          } catch {
            // best effort only
          }
        }
        return storedTab;
      }

      try {
        await tabsApi.remove(storedTab.id);
      } catch {
        // best effort only
      }
      cachedAgentTabId = null;
      await storageSet({ [AGENT_TAB_STORAGE_KEY]: null }).catch(() => {});
    }

    const created = await tabsApi.create({ url: 'https://example.com/', pinned: true, active: false }).catch((error) => {
      throw createProtocolError('E_NO_ACTIVE_TAB', 'Failed to create the dedicated agent tab', error);
    });
    await persistAgentTabId(created.id);
    return created;
  }

  async function resolveTarget(options = {}) {
    let resolved;

    if (typeof options.tabId === 'number') {
      const tab = await getTab(options.tabId);
      if (!tab) {
        throw createProtocolError('E_NO_ACTIVE_TAB', `Tab ${options.tabId} was not found`, { tabId: options.tabId });
      }
      resolved = { tabId: tab.id, tab };
    } else if (options.useActiveTab) {
      const [tab] = await tabsApi.query({ active: true, currentWindow: true }).catch(() => []);
      if (!tab || typeof tab.id !== 'number') {
        throw createProtocolError('E_NO_ACTIVE_TAB', 'No active tab is available');
      }
      resolved = { tabId: tab.id, tab };
    } else {
      const agentTab = await ensureAgentTab();
      resolved = { tabId: agentTab.id, tab: agentTab };
    }

    return resolved;
  }

  async function focusTab(tabId) {
    const tab = await tabsApi.update(tabId, { active: true }).catch((error) => {
      throw createProtocolError('E_NO_ACTIVE_TAB', `Failed to focus tab ${tabId}`, error);
    });
    if (tab?.windowId && windowsApi?.update) {
      try {
        await windowsApi.update(tab.windowId, { focused: true });
      } catch {
        // best effort only
      }
    }
    return tab;
  }

  async function waitForTabSettled(tabId, { waitUntil = 'settle', timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, skipImmediateComplete = false } = {}) {
    const mode = normalizeWaitUntil(waitUntil);
    if (mode === 'none') {
      return await tabsApi.get(tabId);
    }

    const existing = await tabsApi.get(tabId).catch(() => null);
    if (!skipImmediateComplete && existing?.status === 'complete') {
      if (mode === 'settle' || mode === 'networkidle') {
        await delay(SETTLE_DELAY_MS);
      }
      return existing;
    }

    let timer = null;
    return await new Promise((resolve, reject) => {
      const listeners = {
        onUpdated(updatedTabId, changeInfo, tab) {
          if (updatedTabId !== tabId || changeInfo?.status !== 'complete') {
            return;
          }
          cleanup();
          const finish = async () => {
            if (mode === 'settle' || mode === 'networkidle') {
              await delay(SETTLE_DELAY_MS);
            }
            resolve(tab);
          };
          void finish();
        },
        onRemoved(removedTabId) {
          if (removedTabId !== tabId) return;
          cleanup();
          reject(createProtocolError('E_NO_ACTIVE_TAB', `Tab ${tabId} was closed while waiting for navigation`));
        },
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        removeTabListeners(tabsApi, listeners);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(createProtocolError('E_NAV_TIMEOUT', `Timed out while waiting for tab ${tabId} to ${mode}`));
      }, timeoutMs);
      timer.unref?.();

      tabsApi.onUpdated.addListener(listeners.onUpdated);
      tabsApi.onRemoved.addListener(listeners.onRemoved);
    });
  }

  async function navigate({ tabId, url, waitUntil = 'settle', timeoutMs = DEFAULT_WAIT_TIMEOUT_MS }) {
    const mode = normalizeWaitUntil(waitUntil);
    if (mode === 'none') {
      return await tabsApi.update(tabId, { url }).catch((error) => {
        throw createProtocolError('E_INTERNAL', `Failed to navigate tab ${tabId}`, error);
      });
    }

    let timer = null;
    return await new Promise((resolve, reject) => {
      const listeners = {
        onUpdated(updatedTabId, changeInfo, tab) {
          if (updatedTabId !== tabId || changeInfo?.status !== 'complete') {
            return;
          }
          cleanup();
          const finish = async () => {
            if (mode === 'settle' || mode === 'networkidle') {
              await delay(SETTLE_DELAY_MS);
            }
            resolve(tab);
          };
          void finish();
        },
        onRemoved(removedTabId) {
          if (removedTabId !== tabId) return;
          cleanup();
          reject(createProtocolError('E_NO_ACTIVE_TAB', `Tab ${tabId} was closed while waiting for navigation`));
        },
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        removeTabListeners(tabsApi, listeners);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(createProtocolError('E_NAV_TIMEOUT', `Timed out while waiting for tab ${tabId} to ${mode}`));
      }, timeoutMs);
      timer.unref?.();

      tabsApi.onUpdated.addListener(listeners.onUpdated);
      tabsApi.onRemoved.addListener(listeners.onRemoved);
      tabsApi.update(tabId, { url }).catch((error) => {
        cleanup();
        reject(createProtocolError('E_INTERNAL', `Failed to navigate tab ${tabId}`, error));
      });
    });
  }

  async function normalizeScreenshot(base64, mime, { maxWidth = 1280, quality = 0.7 } = {}) {
    const blob = await fetch(`data:${mime};base64,${base64}`).then((response) => response.blob());
    const image = await createImageBitmap(blob);
    const targetWidth = Math.min(image.width, maxWidth || image.width);
    const targetHeight = Math.max(1, Math.round(image.height * (targetWidth / image.width)));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const outputMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const outputBlob = await canvas.convertToBlob({ type: outputMime, quality });
    const bytes = new Uint8Array(await outputBlob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      data_base64: btoa(binary),
      mime: outputMime,
      width: targetWidth,
      height: targetHeight,
    };
  }

  async function captureScreenshot({ tabId, selector, fullPage, waitUntil, format, quality, maxWidth }) {
    await focusTab(tabId);
    await waitForTabSettled(tabId, { waitUntil, timeoutMs: 20_000 });
    let clip;
    if (selector) {
      clip = await executeInTab(tabId, 'selectorRect', { selector });
      if (!clip || !clip.width || !clip.height) {
        throw createProtocolError('E_VALIDATION', `Selector ${selector} was not found for screenshot capture`);
      }
    }

    const cdpResult = await inspector.send(tabId, 'Page.captureScreenshot', {
      format: format === 'png' ? 'png' : 'jpeg',
      quality: format === 'png' ? undefined : Math.max(1, Math.min(100, Math.round((quality ?? 0.7) * 100))),
      captureBeyondViewport: !!fullPage,
      fromSurface: true,
      clip: clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 } : undefined,
    }).catch((error) => {
      throw createProtocolError('E_INTERNAL', `Failed to capture screenshot for tab ${tabId}`, error);
    });

    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const normalized = await normalizeScreenshot(cdpResult.data, mime, {
      maxWidth: maxWidth ?? 1280,
      quality: quality ?? 0.7,
    });
    const tab = await tabsApi.get(tabId).catch(() => null);
    return {
      ...normalized,
      url: tab?.url,
      title: tab?.title,
    };
  }

  async function listTabs() {
    const tabs = await tabsApi.query({});
    const agentTabId = await getStoredAgentTabId();
    return tabs.map((tab) => ({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      active: !!tab.active,
      pinned: !!tab.pinned,
      isAgentTab: typeof agentTabId === 'number' && tab.id === agentTabId,
    }));
  }

  async function waitFor({ tabId, selector, text, urlMatches, state, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await scriptingApi.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: ({ selectorValue, textValue, urlPattern, stateValue }) => {
          const payload = { matched: false, selector: selectorValue, text: textValue, url_matches: urlPattern, state: stateValue };
          if (urlPattern) {
            try {
              if (new RegExp(urlPattern).test(location.href)) {
                return { matched: true, kind: 'url', value: location.href };
              }
            } catch {
              return { matched: false, invalidRegex: true };
            }
          }
          if (selectorValue) {
            const element = document.querySelector(selectorValue);
            const attached = !!element;
            const visible = !!element && (() => {
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            })();
            const stateMap = { attached, detached: !attached, visible, hidden: !visible };
            if (stateMap[stateValue || 'visible']) {
              return { matched: true, kind: 'selector', selector: selectorValue, state: stateValue || 'visible' };
            }
          }
          if (textValue) {
            const bodyText = document.body?.innerText || document.body?.textContent || '';
            if (bodyText.includes(textValue)) {
              return { matched: true, kind: 'text', text: textValue };
            }
          }
          return payload;
        },
        args: [{ selectorValue: selector, textValue: text, urlPattern: urlMatches, stateValue: state }],
      }).catch((error) => {
        throw createProtocolError('E_INTERNAL', `Failed while waiting on tab ${tabId}`, error);
      });
      const match = result?.[0]?.result;
      if (match?.invalidRegex) {
        throw createProtocolError('E_VALIDATION', 'url_matches must be a valid regular expression');
      }
      if (match?.matched) {
        return {
          status: 'matched',
          matched: match,
          elapsedMs: Math.max(0, timeoutMs - (deadline - Date.now())),
          tabId,
        };
      }
      await delay(100);
    }

    throw createProtocolError('E_TIMEOUT', `Timed out waiting for condition on tab ${tabId}`);
  }

  async function getAccessibilityTree({ tabId, rootSelector, interestingOnly, maxDepth, include }) {
    await inspector.ensureAttached(tabId, { requireLease: false });
    await inspector.sendCommand(tabId, 'Accessibility.enable', {}, { requireLease: false }).catch(() => {});
    let nodes = [];
    if (rootSelector) {
      const documentNode = await inspector.sendCommand(tabId, 'DOM.getDocument', {}, { requireLease: false });
      const nodeId = await inspector.sendCommand(tabId, 'DOM.querySelector', {
        nodeId: documentNode?.root?.nodeId,
        selector: rootSelector,
      }, { requireLease: false });
      nodes = (await inspector.sendCommand(tabId, 'Accessibility.getPartialAXTree', {
        nodeId: nodeId?.nodeId,
        fetchRelatives: true,
        interestingOnly: interestingOnly !== false,
      }, { requireLease: false }))?.nodes || [];
    } else {
      nodes = (await inspector.sendCommand(tabId, 'Accessibility.getFullAXTree', {
        depth: maxDepth ?? 40,
        interestingOnly: interestingOnly !== false,
      }, { requireLease: false }))?.nodes || [];
    }

    const includeSet = new Set(Array.isArray(include) && include.length > 0 ? include : ['role', 'name', 'value', 'description', 'properties', 'children']);
    return {
      tabId,
      root_selector: rootSelector,
      interesting_only: interestingOnly !== false,
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId,
        ignored: node.ignored,
        role: includeSet.has('role') ? node.role : undefined,
        name: includeSet.has('name') ? node.name : undefined,
        value: includeSet.has('value') ? node.value : undefined,
        description: includeSet.has('description') ? node.description : undefined,
        properties: includeSet.has('properties') ? node.properties : undefined,
        childIds: includeSet.has('children') ? node.childIds : undefined,
      })),
    };
  }

  async function getPerformanceMetrics({ tabId, include }) {
    await inspector.ensureAttached(tabId, { requireLease: false });
    await inspector.sendCommand(tabId, 'Performance.enable', {}, { requireLease: false }).catch(() => {});
    const includeSet = new Set(Array.isArray(include) && include.length > 0 ? include : ['metrics', 'timing', 'web_vitals', 'layout', 'memory', 'paint']);
    const result = {};

    if (includeSet.has('metrics')) {
      const metrics = await inspector.sendCommand(tabId, 'Performance.getMetrics', {}, { requireLease: false }).catch(() => ({ metrics: [] }));
      result.metrics = Object.fromEntries((metrics?.metrics || []).map((entry) => [entry.name, entry.value]));
    }

    if (includeSet.has('layout')) {
      const layout = await inspector.sendCommand(tabId, 'Page.getLayoutMetrics', {}, { requireLease: false }).catch(() => ({}));
      result.layout = layout;
    }

    if (includeSet.has('timing') || includeSet.has('memory') || includeSet.has('paint') || includeSet.has('web_vitals')) {
      const runtime = await inspector.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(() => ({
          timing: performance.timing ? { ...performance.timing } : null,
          navigation: performance.getEntriesByType('navigation')[0] || null,
          paint: performance.getEntriesByType('paint') || [],
          memory: performance.memory ? { ...performance.memory } : null,
          webVitals: performance.getEntriesByType('largest-contentful-paint') || []
        }))()`,
        returnByValue: true,
        awaitPromise: false,
      }, { requireLease: false }).catch(() => ({ result: { value: {} } }));
      const value = runtime?.result?.value || {};
      if (includeSet.has('timing')) result.timing = { timing: value.timing, navigation: value.navigation };
      if (includeSet.has('memory')) result.memory = value.memory;
      if (includeSet.has('paint')) result.paint = value.paint;
      if (includeSet.has('web_vitals')) result.web_vitals = { entries: value.webVitals, note: 'LCP is best-effort without a long-lived observer' };
    }

    return result;
  }

  function attachHooks() {
    if (hooksAttached) return;
    hooksAttached = true;

    tabsApi.onRemoved?.addListener?.((tabId) => {
      void observability.handleTabRemoved(tabId, 'tab_removed');
      if (cachedAgentTabId === tabId) {
        cachedAgentTabId = null;
        void storageSet({ [AGENT_TAB_STORAGE_KEY]: null }).catch(() => {});
      }
    });

    debuggerApi.onDetach?.addListener?.((source, reason) => {
      if (typeof source?.tabId === 'number') {
        observability.handleDisconnect(source.tabId, reason || 'debugger_detached');
      }
    });

    runtimeApi.onSuspend?.addListener?.(() => {
      void observability.handleSuspend();
    });
  }

  async function warmUp() {
    attachHooks();
    if (warmed) return;
    warmed = true;
  }

  async function setEnabled(enabled) {
    if (enabled) {
      await warmUp();
      return;
    }

    warmed = false;
    await observability.stop().catch((error) => {
      logger.warn?.('[pi-bridge] failed to stop observability while disabling bridge', error);
    });
  }

  const taskHandlers = {
    async browser_run_task(params = {}) {
      if (typeof onRunTask !== 'function') {
        throw createProtocolError('E_UNKNOWN_TYPE', 'browser_run_task is not configured');
      }
      return await onRunTask(params);
    },
    async browser_reload_extension(params = {}) {
      const timeoutMs = Number(params?.timeout_ms ?? 15_000);
      setTimeout(() => {
        try {
          runtimeApi.reload();
        } catch (error) {
          logger.error?.('[pi-bridge] failed to reload extension', error);
        }
      }, 100);

      return {
        extensionId: runtimeApi.id,
        reloading: true,
        requestedAt: Date.now(),
        timeoutMs,
      };
    },
  };

  const readOnlyHandlers = createReadOnlyHandlers({
    resolveTarget,
    navigate: async ({ tabId, url, waitUntil }) => await navigate({ tabId, url, waitUntil, timeoutMs: DEFAULT_WAIT_TIMEOUT_MS }),
    captureScreenshot,
    getHtml: async ({ tabId, selector, selectorAll, strip }) => await executeInTab(tabId, 'html', { selector, selectorAll, strip }),
    getDomInfo: async ({ tabId, selector, selectorAll, limit, include }) => await executeInTab(tabId, 'domInfo', { selector, selectorAll, limit, include }),
    getComputedStyles: async ({ tabId, selector, properties, pseudo, includeMatchedRules, includeInherited, includeBoxModel }) => await executeInTab(tabId, 'computedStyles', { selector, properties, pseudo, includeMatchedRules, includeInherited, includeBoxModel }),
    listTabs,
    waitFor,
    getAccessibilityTree,
    getPerformanceMetrics,
  });

  const observabilityHandlers = createBufferedObservabilityHandlers({
    consoleBuffer: observability.consoleBuffer,
    networkBuffer: observability.networkBuffer,
    resolveTabId: async (params = {}) => {
      const target = await resolveTarget({ tabId: params.tab_id, useActiveTab: params.use_active_tab === true });
      await observability.armTab(target.tabId).catch((error) => {
        logger.warn?.('[pi-bridge] failed to arm observability for tab', { tabId: target.tabId, error });
      });
      if (typeof params.url === 'string' && params.url) {
        await navigate({ tabId: target.tabId, url: params.url, waitUntil: 'settle', timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
      }
      return target.tabId;
    },
  });

  const jsNavigationHandlers = createJsNavigationDestructiveHandlers({
    tabsApi,
    windowsApi,
    inspector,
    browsingDataApi,
    armObservability: async (tabId) => {
      await observability.armTab(tabId).catch((error) => {
        logger.warn?.('[pi-bridge] failed to arm observability for tab', { tabId, error });
      });
    },
    resolveDefaultTabId: async () => (await ensureAgentTab()).id,
    waitForTabSettled,
  });

  const dispatcher = createBridgeDispatcher({
    handlers: {
      ...taskHandlers,
      ...readOnlyHandlers,
      ...observabilityHandlers,
      ...jsNavigationHandlers,
    },
    serialRequestTypes: SERIAL_REQUEST_TYPES,
    tabIdResolver: async (frame) => {
      const params = frame?.params || {};
      const explicit = params.tab_id;
      if (typeof explicit === 'number') return explicit;
      try {
        return (await resolveTarget({ tabId: params.tab_id, useActiveTab: params.use_active_tab === true })).tabId;
      } catch {
        return null;
      }
    },
    logger,
  });

  return {
    inspector,
    capabilities: Object.freeze(Object.keys({
      ...taskHandlers,
      ...readOnlyHandlers,
      ...observabilityHandlers,
      ...jsNavigationHandlers,
    })),
    async warmUp() {
      await warmUp();
    },
    async setEnabled(enabled) {
      await setEnabled(enabled);
    },
    async handleRequest(frame) {
      await warmUp();
      return await dispatcher.handle(frame);
    },
    async createAgentBrowserBridge(targetTabId) {
      const bridge = new BrowserBridge();
      bridge.getActiveTabId = async () => targetTabId;
      await observability.armTab(targetTabId).catch((error) => {
        logger.warn?.('[pi-bridge] failed to arm observability for task tab', { tabId: targetTabId, error });
      });
      bridge.navigate = async (url, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => {
        await observability.armTab(targetTabId).catch((error) => {
          logger.warn?.('[pi-bridge] failed to arm observability before task navigation', { tabId: targetTabId, error });
        });
        await navigate({ tabId: targetTabId, url, waitUntil: 'settle', timeoutMs });
      };
      return bridge;
    },
    async resolveRunTaskTab(params = {}) {
      const usingOverride = typeof (params.tabId ?? params.tab_id) === 'number' || params.useActiveTab === true || params.use_active_tab === true;
      const target = await resolveTarget({ tabId: params.tabId ?? params.tab_id, useActiveTab: params.useActiveTab ?? params.use_active_tab });
      if (typeof target.tabId === 'number' && !usingOverride) {
        await persistAgentTabId(target.tabId);
      }
      return target;
    },
    async dispose() {
      await observability.stop().catch(() => {});
      await inspector.dispose().catch(() => {});
    },
  };
}
