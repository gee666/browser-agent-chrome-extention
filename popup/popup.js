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

// Initial load
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get('agentStatus', (data) => {
    const status = data.agentStatus;
    renderStatus(status);
    if (status && ['running', 'thinking', 'acting'].includes(status.state)) {
      taskInput.value = status.task || '';
    }
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

  chrome.storage.local.get(['provider', 'apiKey'], (config) => {
    const provider = config.provider || 'openai';
    const needsKey = provider !== 'ollama';
    if (needsKey && !config.apiKey) {
      showErrorMsg('Please set your API key in ⚙ Settings');
      return;
    }
    chrome.runtime.sendMessage({ type: 'start_task', task });
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
