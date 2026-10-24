import { normalizePiBridgeConfig, readPiBridgeConfig } from '../lib/pi-browser-agent-bridge/src/config.js';

// Bridge setup must work independently of model credentials and optional core
// features. A broken provider settings page must not strand the recovery path.
export async function initBridgeSettings(document, chromeApi) {
  const enabled = document.getElementById('piBridgeEnabled');
  const urls = document.getElementById('piBridgeUrl');
  const save = document.getElementById('piBridgeSave');
  const status = document.getElementById('piBridgeStatus');
  save.disabled = true;
  try {
    const config = await readPiBridgeConfig(chromeApi.storage.local);
    enabled.checked = config.enabled;
    urls.value = config.urls.join('\n');
    save.disabled = false;
  } catch {
    status.textContent = 'Could not load bridge settings. Reload this page to retry.';
    return;
  }

  save.addEventListener('click', async () => {
    const config = normalizePiBridgeConfig({ enabled: enabled.checked, urls: urls.value });
    try {
      for (const value of config.urls) {
        const url = new URL(value);
        if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
          throw new Error('Invalid bridge URL');
        }
      }
    } catch {
      status.textContent = 'Enter WebSocket URLs such as ws://127.0.0.1:7878, one per line.';
      return;
    }
    save.disabled = true;
    try {
      await new Promise((resolve, reject) => {
        chromeApi.storage.local.set({ piBridgeConfig: config }, () => {
          const error = chromeApi.runtime.lastError;
          if (error) reject(new Error('Storage write failed'));
          else resolve();
        });
      });
      urls.value = config.urls.join('\n');
      status.textContent = 'Bridge settings saved. The bridge reconnects automatically.';
    } catch {
      status.textContent = 'Could not save bridge settings. Try again.';
    } finally {
      save.disabled = false;
    }
  });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => initBridgeSettings(document, chrome));
}
