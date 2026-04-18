const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const taskInput = document.getElementById('task-input');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const taskForm = document.getElementById('task-form');
const progressPanel = document.getElementById('progress-panel');
const resultPanel = document.getElementById('result-panel');
const resultMessage = document.getElementById('result-message');
const currentUrlEl = document.getElementById('current-url');
const iterationCounter = document.getElementById('iteration-counter');
const settingsLink = document.getElementById('settings-link');
const logsLink     = document.getElementById('logs-link');
const debugCheckbox = document.getElementById('debug-checkbox');
const inputBackendNameEl   = document.getElementById('input-backend-name');
const inputBackendChangeEl = document.getElementById('input-backend-change');

const DOT_CLASSES = ['grey', 'yellow', 'blue', 'green', 'red'];

function setDot(color, pulse = false) {
  statusDot.classList.remove(...DOT_CLASSES, 'pulse');
  statusDot.classList.add(color);
  if (pulse) statusDot.classList.add('pulse');
}

function showErrorMsg(msg) {
  let el = taskForm.querySelector('.error-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'error-msg';
    taskForm.appendChild(el);
  }
  el.textContent = msg;
}

function clearErrorMsg() {
  const el = taskForm.querySelector('.error-msg');
  if (el) el.remove();
}

function renderStatus(status) {
  if (!status || status.state === 'idle' || status.state === undefined) {
    setDot('grey');
    statusText.textContent = 'Idle';
    taskForm.hidden = false;
    progressPanel.hidden = true;
    resultPanel.hidden = true;
    runBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  switch (status.state) {
    case 'running':
    case 'thinking': {
      setDot('yellow', true);
      statusText.textContent = `Thinking... (${status.iteration}/${status.maxIterations})`;
      taskForm.hidden = false;
      progressPanel.hidden = false;
      resultPanel.hidden = true;
      runBtn.disabled = true;
      stopBtn.disabled = false;
      currentUrlEl.textContent = status.url || '';
      iterationCounter.textContent = `Iteration ${status.iteration} of ${status.maxIterations}`;
      break;
    }
    case 'acting': {
      setDot('blue', true);
      statusText.textContent = `Acting (${status.actionsCount} actions)...`;
      taskForm.hidden = false;
      progressPanel.hidden = false;
      resultPanel.hidden = true;
      runBtn.disabled = true;
      stopBtn.disabled = false;
      currentUrlEl.textContent = status.url || '';
      iterationCounter.textContent = `Iteration ${status.iteration} of ${status.maxIterations}`;
      break;
    }
    case 'done': {
      setDot('green');
      statusText.textContent = 'Done';
      progressPanel.hidden = true;
      resultPanel.hidden = false;
      resultPanel.classList.remove('error');
      resultMessage.textContent = status.message || '';
      runBtn.disabled = false;
      stopBtn.disabled = true;
      break;
    }
    case 'error': {
      setDot('red');
      statusText.textContent = 'Error';
      progressPanel.hidden = true;
      resultPanel.hidden = false;
      resultPanel.classList.add('error');
      resultMessage.textContent = status.message || '';
      runBtn.disabled = false;
      stopBtn.disabled = true;
      break;
    }
    case 'stopped': {
      setDot('grey');
      statusText.textContent = 'Stopped';
      progressPanel.hidden = true;
      resultPanel.hidden = true;
      runBtn.disabled = false;
      stopBtn.disabled = true;
      break;
    }
    default:
      break;
  }
}

// Persist debug checkbox state
debugCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ debugMode: debugCheckbox.checked });
});

// Persist task text while the user types
taskInput.addEventListener('input', () => {
  chrome.storage.local.set({ lastTask: taskInput.value });
});

// Render the input-backend indicator line above the footer.
function renderInputBackend(backend) {
  if (!inputBackendNameEl) return;
  const resolved = backend || 'cdp';
  inputBackendNameEl.textContent = resolved === 'native' ? 'Native' : 'CDP';
}

// Initial load
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get('inputBackend', (data) => {
    renderInputBackend(data.inputBackend);
  });

  chrome.storage.local.get(['agentStatus', 'debugMode', 'lastTask'], (data) => {
    const status = data.agentStatus;
    renderStatus(status);

    // Always restore the last task text the user typed, regardless of agent state
    if (data.lastTask !== undefined && data.lastTask !== null) {
      taskInput.value = data.lastTask;
    } else if (status && status.task) {
      // Fallback: use the task embedded in the status (older sessions)
      taskInput.value = status.task;
    }

    // Restore debug mode checkbox
    debugCheckbox.checked = !!data.debugMode;
  });

  // Poll every 500ms as fallback
  setInterval(() => {
    chrome.storage.local.get('agentStatus', (data) => renderStatus(data.agentStatus));
  }, 500);
});

// Listen for live status messages
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'agent_status') {
    renderStatus(message.status);
  }
});

// Run button
runBtn.addEventListener('click', () => {
  clearErrorMsg();
  const task = taskInput.value.trim();
  if (!task) {
    showErrorMsg('Please enter a task.');
    return;
  }

  // Persist the task text so it survives popup close/reopen
  chrome.storage.local.set({ lastTask: task });

  chrome.storage.local.get(['provider', 'apiKey', 'debugMode'], (config) => {
    const provider = config.provider || 'openai';
    const oauthProviders = ['openai-codex', 'anthropic-oauth', 'gemini-cli'];
    const needsKey = !oauthProviders.includes(provider) && provider !== 'ollama';
    if (needsKey && !config.apiKey) {
      showErrorMsg('Please set your API key in ⚙ Settings');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'start_task',
      task,
      debugMode: debugCheckbox.checked,
    });
  });
});

// Stop button
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop_task' });
});

// Settings link
settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Logs link
logsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('logs/viewer.html') });
});

// Input-backend [change] deep-link to options#input-backend.
// Use chrome.tabs.create with a hash URL since openOptionsPage does not
// reliably support URL hashes.
if (inputBackendChangeEl) {
  inputBackendChangeEl.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({
      url: chrome.runtime.getURL('options/options.html#input-backend'),
    });
  });
}
