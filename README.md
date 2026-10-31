# Browser Agent

An LLM-driven browser automation framework built on Chrome Extensions and [`python-input-control`](./python-input-control).

You describe a task in plain language. The agent opens the page, reads every interactive element, asks an LLM what to do, and performs the actions using real OS-level mouse and keyboard input — not JavaScript injection.

## Repositories in this folder

| Folder | Role |
|---|---|
| `python-input-control` | Python native messaging host — executes OS-level mouse, keyboard, scroll. Complete, no changes needed. |
| `browser-agent-core` | Reusable JS framework — page extraction, LLM providers, action executor, agent loop. Install as a git submodule. |
| `browser-agent-ext` | Reference Chrome extension — popup UI + wires the framework. Use as a template for your own extensions. |

---

## How it works

```
┌─────────────────────────────┐
│  Extension Popup            │
│  "Login to facebook.com"    │
└────────────┬────────────────┘
             │ chrome.runtime.sendMessage
             ▼
┌─────────────────────────────────────────────────────────────┐
│  Service Worker (browser-agent-core)                        │
│                                                             │
│  1. Navigate to page          chrome.tabs.update            │
│  2. Read page elements  ◄───  content/extractor.js (DOM)    │
│  3. Take screenshot     ◄───  captureVisibleTab             │
│  4. Ask LLM             ────► fetch() to OpenAI/Anthropic/… │
│  5. Execute actions     ────► connectNative()               │
│  6. Repeat until done                                       │
└───────────────────────────┬─────────────────────────────────┘
                            │ Native Messaging (stdio)
                            ▼
             ┌──────────────────────────┐
             │  python-input-control    │
             │  OS mouse & keyboard     │
             └──────────────────────────┘
```

The extension reads the DOM — it never injects fake click events. All input goes through an input-control backend (see below), which moves the mouse on a Bézier curve, types at human-like WPM, and respects timing constraints.

---

## Input backends

The agent supports two interchangeable input backends. Both honour the same contract (`execute` / `abort`) and both avoid synthetic DOM events — they drive real mouse and keyboard input. Pick one in **⚙ Settings → Input Backend**, or from the popup’s `Input:` indicator.

### `browser-agent-input-control` — Chrome DevTools Protocol (default)

Uses Chrome’s built-in [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (via the `chrome.debugger` API) to dispatch mouse and keyboard events directly to the target tab. No external installation is required — ship the extension and it works.

Caveats:
- While the agent is running, Chrome shows a yellow “**extension is debugging this browser**” banner on the target tab. This is Chrome’s mandatory notice; you cannot suppress it.
- The debugger can attach to a given tab only once. If you have DevTools open on the target tab, close it before running a task — otherwise the backend cannot attach.

This is the right default for most users.

### `python-input-control` — native, OS-level

A Python native-messaging host that moves the real OS mouse cursor and types on the real OS keyboard. This drives the browser exactly the way a human would — useful when you need OS-level input (e.g. file pickers, non-Chrome windows), or when you explicitly want the extra realism.

Caveats:
- Requires a one-time install of the `python-input-control` host and registration against your extension ID (see **Quick start** below).
- On macOS, you must grant Accessibility permission.
- While running, it controls the real cursor — don’t try to use the mouse at the same time.

Pick this if you explicitly need OS-level input, or you’re doing automation that the CDP backend can’t reach.

---

## Quick start

### 1. Install python-input-control

The native host installs **once per machine** — no extension ID is required at
install time. You'll grant access to specific extension IDs in step 3.

```bash
cd python-input-control
python3 install.py
```

Requires Python 3.11+. On macOS, grant Accessibility permission when prompted.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `browser-agent-ext` folder
5. Note the **Extension ID** shown under the extension name (e.g. `abcdefghijklmnopqrstuvwxyz123456`)

### 3. Register the native host with your extension ID

Add your extension ID to the host's allow-list (repeat for any additional
extensions that should share the same host):

```bash
python-input-control-install allow abcdefghijklmnopqrstuvwxyz123456
```

Inspect or revoke access at any time:

```bash
python-input-control-install list-allowed
python-input-control-install disallow abcdefghijklmnopqrstuvwxyz123456
```

Verify the overall registration:
```bash
python-input-control-install verify --extension-id abcdefghijklmnopqrstuvwxyz123456
```

### 4. Configure the extension

Click the extension icon → **⚙ Settings** and fill in:

- **LLM Provider** — choose one (see provider setup below)
- **API Key** — your key for the chosen provider
- **Model** — leave default or choose another (e.g. `claude-opus-4-5`)

### 5. Run a task

Click the extension icon. Type a task and click **Run Task**:

```
Login to https://the-internet.herokuapp.com/login with username tomsmith and password SuperSecretPassword!
```

The popup shows live status. The agent loops — reading the page, asking the LLM, performing actions — until it declares the task done or hits the iteration limit.

---

## LLM provider setup

### OpenAI
- Provider: `openai`
- API key: from https://platform.openai.com/api-keys
- Model: `gpt-4o` (default), `gpt-4o-mini`, `gpt-4-turbo`
- Vision: supported on all `gpt-4o` models

### Anthropic
- Provider: `anthropic`
- API key: from https://console.anthropic.com/
- Model: `claude-opus-4-5` (default), `claude-sonnet-4-5`, `claude-haiku-3-5`
- Vision: supported on all models

### Ollama (local, free)
- Provider: `ollama`
- Base URL: `http://localhost:11434` (default)
- Model: `llava` (default, supports vision), `llama3.2`, `mistral`
- Install Ollama: https://ollama.ai — then `ollama pull llava`
- No API key needed

### OpenRouter
- Provider: `openrouter`
- API key: from https://openrouter.ai/keys
- Model: `openai/gpt-4o`, `anthropic/claude-opus-4-5`, `meta-llama/llama-3.1-70b-instruct`, etc.
- Access to hundreds of models through one API key

### NVIDIA NIM
- Provider: `nvidia`
- API key: from https://build.nvidia.com/
- Model: `meta/llama-3.1-70b-instruct`, `nvidia/nemotron-4-340b-instruct`

---

## Creating a new extension

`browser-agent-core` is designed to be installed as a git submodule into any Chrome extension.

### 1. Create your extension repository

```bash
mkdir my-extension && cd my-extension
git init
```

### 2. Add browser-agent-core as a submodule

```bash
git submodule add https://github.com/yourorg/browser-agent-core lib/browser-agent-core
```

Or if working locally:
```bash
git submodule add ../browser-agent-core lib/browser-agent-core
```

### 3. Set up your manifest.json

The only required entry from the framework is the content script:

```json
{
  "manifest_version": 3,
  "name": "My Specialist Agent",
  "version": "0.1.0",
  "permissions": ["tabs", "activeTab", "scripting", "storage", "webNavigation", "nativeMessaging"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/sw.js",
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["lib/browser-agent-core/content/extractor.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup/popup.html" }
}
```

### 4. Write your service worker

Minimal wiring:

```javascript
// background/sw.js
import { AgentCore, BrowserBridge, ActionExecutor, InputControlBridge, OpenAIProvider }
  from '../lib/browser-agent-core/background/index.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'start_task') {
    const bridge = new BrowserBridge();
    const agent = new AgentCore({
      llm: new OpenAIProvider({ apiKey: message.apiKey }),
      bridge,
      executor: new ActionExecutor({ bridge, inputControl: new InputControlBridge() }),
      onStatus: (s) => bridge.sendStatus(s),
    });
    agent.run(message.task);
    sendResponse({ started: true });
    return true;
  }
});
```

### 5. Specialise the agent (optional)

Subclass `AgentCore` to change the system prompt or message format:

```javascript
import { AgentCore } from '../lib/browser-agent-core/background/index.js';

class TaxFormAgent extends AgentCore {
  systemPrompt() {
    return `You specialise in filling out government tax forms.
            Always move through fields in tab order.
            Never skip mandatory fields.
            If a field has validation, check it before moving on.
            \n\n` + super.systemPrompt();
  }

  buildUserMessage(task, pageState, iteration, history) {
    // prepend domain-specific context
    const context = 'Focus only on form fields. Ignore navigation menus.';
    return context + '\n\n' + super.buildUserMessage(task, pageState, iteration, history);
  }
}
```

### 6. Write your popup (optional)

Your popup can be anything — it just needs to send `{ type: 'start_task', task: '...' }` to the service worker and listen for `{ type: 'agent_status', status: {...} }` messages (or read `agentStatus` from `chrome.storage.local`).

You can copy `browser-agent-ext/popup/` as a starting point.

---

## `browser-agent-core` API reference

### `AgentCore`

```javascript
new AgentCore({
  llm,                  // LLMProvider instance — required
  bridge,               // BrowserBridge instance — required
  executor,             // ActionExecutor instance — required
  onStatus,             // function(status) — required
  maxIterations,        // number, default 20
  useVision,            // boolean, default true
  actionSettleMs,       // ms to wait after executing actions, default 1500
  navigationTimeoutMs,  // ms to wait for page load, default 30000
})
```

| Method | Description |
|---|---|
| `run(task)` | Start the agent loop. Returns a promise that resolves with the final message string. |
| `stop()` | Signal the loop to stop after the current iteration. |
| `systemPrompt()` | Returns the system prompt. Override in subclass. |
| `buildUserMessage(task, pageState, iteration, history)` | Builds the user message for each iteration. Override in subclass. |

**Status object** (passed to `onStatus` and written to `chrome.storage.local['agentStatus']`):

```javascript
{
  state: 'idle' | 'running' | 'thinking' | 'acting' | 'done' | 'error' | 'stopped',
  task: string | null,
  iteration: number,
  maxIterations: number,
  url: string | null,
  title: string | null,
  message: string | null,
  actionsCount: number | null,
  timestamp: number,
}
```

### `BrowserBridge`

| Method | Description |
|---|---|
| `getActiveTabId()` | Returns the current active tab ID. |
| `getPageState(tabId)` | Returns `PageState` from the content script. |
| `takeScreenshot()` | Returns base64 PNG data URL, or `null` on failure. |
| `navigate(url, timeoutMs?)` | Navigates active tab to URL and waits for load. |
| `waitForPageSettle(tabId, ms?)` | Waits for DOM mutations to stop. |
| `sendStatus(status)` | Writes status to storage and attempts to notify popup. |

### `ActionExecutor`

```javascript
new ActionExecutor({ bridge, inputControl })
```

| Method | Description |
|---|---|
| `execute(actions, pageState)` | Executes an array of LLM action objects against the current page state. Handles scroll, mouse_move prepending, context injection, and pauses automatically. |

### `InputControlBridge`

| Method | Description |
|---|---|
| `connect()` | Opens native messaging port to `python-input-control`. |
| `execute(command, params, context)` | Sends a single command to python-input-control and awaits response. |
| `disconnect()` | Closes the native messaging port. |

### LLM Providers

All providers implement the same interface:
```javascript
await provider.complete({ system, messages, screenshot })
// Returns: string (raw LLM response)
```

| Class | Required options | Optional options |
|---|---|---|
| `OpenAIProvider` | `apiKey` | `model`, `baseUrl`, `maxTokens`, `temperature` |
| `AnthropicProvider` | `apiKey` | `model`, `maxTokens`, `temperature` |
| `OllamaProvider` | — | `baseUrl`, `model`, `temperature` |
| `OpenRouterProvider` | `apiKey` | `model`, `maxTokens`, `temperature` |
| `NvidiaProvider` | `apiKey` | `model`, `baseUrl`, `maxTokens`, `temperature` |

---

## Driving from pi

You can expose `browser-agent-ext` to a pi session through the local `pi-browser-agent` broker.

### Pieces

- `pi-browser-agent/` — pi extension that starts the local WebSocket broker and lazily registers `browser_*` tools
- `browser-agent-ext/` — Chrome extension runtime
- `browser-agent-ext/lib/pi-browser-agent-bridge/` — bridge loaded by the extension service worker

### Quick start

1. Load `browser-agent-ext` unpacked in Chrome.
2. Open the extension options and make sure **Enable pi bridge** is on.
3. Leave the default bridge URL as `ws://127.0.0.1:7878` unless you need a custom host/port.
4. Enable `pi-browser-agent` in your pi setup.
5. In the pi session, call `browser_agent_tools` first.

That first meta-tool probes the broker/bridge and then registers the full browser toolkit for the session.

### Typical pi flow

```text
browser_agent_tools
browser_list_tabs
browser_get_html
browser_get_console_logs
browser_run_task
```

### WSL note

If pi runs inside WSL and Chrome runs on Windows, loopback usually works. If it does not, bind the broker explicitly and point the extension at the WSL IP:

```bash
PI_BA_HOST=0.0.0.0 pi
```

Then set the extension bridge URL to `ws://<wsl-ip>:7878`.

## Pi scripts and native input

Scripts supplied through Pi's `browser_evaluate_js` and `browser_run_js` tools go through AI translation into a validated action/read plan. External JavaScript is never executed directly. The interpreter sends mouse movement, clicks, typing, keys, shortcuts, pauses and scrolling through the input backend selected in extension settings, either CDP or Python. It scrolls off-screen elements into view and checks their coordinates before interaction. Native-input failures stop execution rather than switching to DOM events.

Normal mode uses the browser LLM. Jev mode uses its configured helper LLM for script translation, while Jev continues to make task choices. Scripts and ordinary tasks use the same backend setting. CDP does not require Python installation. Only Python input requires the native host and affects the foreground desktop.

The translator supports bounded actions, fixed DOM reads and result expressions. It rejects unsupported JavaScript instead of guessing or running it directly. Dedicated inspection tools remain available for broader read-only inspection without AI translation. Script timeouts default to 120 seconds and include translation time.

Both task decision modes include a manual CAPTCHA handoff. Choosing it captures a screenshot for the user when possible, returns a `paused` task with `manualRequired: true`, and stops further model calls and input. There is no automatic CAPTCHA solver. Complete the challenge manually, then start a new task.

## Development

### Run framework tests

```bash
cd browser-agent-core
npm install      # installs jest dev dependency
npm test
```

### Reload extension after code changes

Go to `chrome://extensions` and click the reload button (↺) on the Browser Agent card. Changes to content scripts take effect on the next page load.

### Updating the submodule

```bash
cd lib/browser-agent-core
git pull origin main
cd ../..
git add lib/browser-agent-core
git commit -m "update browser-agent-core"
```

### Cloning an extension that uses the submodule

```bash
git clone --recurse-submodules <your-extension-repo>
```

Or if you already cloned without the flag:
```bash
git submodule update --init --recursive
```

---

## Troubleshooting

**"Native host has exited" or actions not working**
- Verify python-input-control is registered: `python-input-control-install verify --extension-id <id>`
- Inspect the host's allow-list: `python-input-control-install list-allowed`
- On macOS: check Accessibility permission — run `python-input-control --check-permissions`
- Check that the extension ID in the manifest registration matches the ID in `chrome://extensions`

**Extension shows "Thinking" but nothing happens on screen**
- The LLM may be returning malformed JSON — open DevTools → Service Worker → Console for errors
- Try switching to a smarter model (e.g. `gpt-4o` instead of `gpt-3.5-turbo`)

**Content script not injecting**
- Reload the page after loading/reloading the extension
- Some pages (chrome://, file://) block content scripts — try a regular http/https page

**Popup shows stale status after reload**
- Clear extension storage: DevTools → Application → Storage → Clear site data, then reload

**Ollama not responding**
- Ensure Ollama is running: `ollama serve`
- Ensure the model is pulled: `ollama pull llava`
- Default base URL is `http://localhost:11434` — update in Settings if you changed it
