// Shared storage-to-core mapping. Credentials remain in chrome.storage.local.
export const DECISION_CONFIG_KEYS = [
  'decisionMode', 'jevBaseUrl', 'jevApiKey', 'jevModel', 'jevHeaders',
  'jevRequestParams', 'jevTimeoutMs', 'jevFallbackEnabled', 'helperModel',
];

export function decisionOptions(config, createProvider, llm) {
  const decisionMode = config.decisionMode || 'llm';
  if (!['llm', 'jev'].includes(decisionMode)) throw new Error('Invalid decision mode');
  return {
    decisionMode,
    decisionConfig: {
      baseUrl: config.jevBaseUrl || 'http://localhost:8765',
      apiKey: config.jevApiKey || '',
      model: config.jevModel || 'jev-latest',
      headers: config.jevHeaders ?? {},
      requestParams: config.jevRequestParams ?? {},
      timeoutMs: config.jevTimeoutMs ?? 1200000,
      fallbackEnabled: config.jevFallbackEnabled ?? true,
    },
    helperLlm: decisionMode === 'jev' && config.helperModel?.trim()
      ? createProvider({ ...config, model: config.helperModel.trim() }) : llm,
  };
}

// Entries are already redacted by the core. Bound both entry size and retention.
export function appendDiscoveryReport(existing, entry) {
  const safe = JSON.parse(JSON.stringify(entry));
  const serialized = JSON.stringify(safe);
  if (serialized.length > 50000) throw new Error('Discovery report exceeds storage limit');
  const reports = Array.isArray(existing) ? existing : [];
  const id = typeof safe.discoveryId === 'string' ? safe.discoveryId : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return [...reports.filter(r => r.discoveryId !== id), { ...safe, discoveryId: id }].slice(-50);
}
