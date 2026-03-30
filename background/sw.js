import { AgentCore, BrowserBridge, ActionExecutor, InputControlBridge,
         OpenAIProvider, AnthropicProvider, OllamaProvider,
         OpenRouterProvider, NvidiaProvider }
  from '../lib/browser-agent-core/background/index.js';

let currentAgent = null;

function createProvider(config) {
  switch (config.provider) {
    case 'anthropic':  return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
    case 'ollama':     return new OllamaProvider({ baseUrl: config.baseUrl, model: config.model });
    case 'openrouter': return new OpenRouterProvider({ apiKey: config.apiKey, model: config.model });
    case 'nvidia':     return new NvidiaProvider({ apiKey: config.apiKey, model: config.model });
    default:           return new OpenAIProvider({ apiKey: config.apiKey, model: config.model });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'start_task') {
    chrome.storage.local.get(
      ['provider', 'apiKey', 'model', 'baseUrl', 'maxIterations', 'useVision'],
      (config) => {
        const llm = createProvider(config);
        const bridge = new BrowserBridge();
        const inputControl = new InputControlBridge();
        const executor = new ActionExecutor({ bridge, inputControl });

        currentAgent = new AgentCore({
          llm,
          bridge,
          executor,
          onStatus: (status) => bridge.sendStatus(status),
          maxIterations: config.maxIterations || 20,
          useVision: config.useVision !== false,
        });

        currentAgent.run(message.task).catch((err) => {
          bridge.sendStatus({
            state: 'error',
            message: err.message,
            timestamp: Date.now(),
            task: message.task,
            iteration: 0,
            maxIterations: 20,
            url: null,
            title: null,
            actionsCount: null,
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
});
