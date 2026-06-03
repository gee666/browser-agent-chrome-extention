const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const taskInput = document.getElementById('task-input');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const messagesEl = document.getElementById('messages');
const activityCard = document.getElementById('activity-card');
const activityTitle = document.getElementById('activity-title');
const activityMessage = document.getElementById('activity-message');
const currentUrlEl = document.getElementById('current-url');
const iterationCounter = document.getElementById('iteration-counter');
const settingsLink = document.getElementById('settings-link');
const logsLink = document.getElementById('logs-link');
const debugCheckbox = document.getElementById('debug-checkbox');
const inputBackendNameEl = document.getElementById('input-backend-name');
const inputBackendChangeEl = document.getElementById('input-backend-change');
const composer = document.getElementById('composer');
const newChatBtn = document.getElementById('new-chat-btn');

const DOT_CLASSES = ['grey', 'yellow', 'blue', 'green', 'red'];
let latestStatus = null;
let latestMessages = [];

function setDot(color, pulse = false) {
  statusDot.classList.remove(...DOT_CLASSES, 'pulse');
  statusDot.classList.add(color);
  if (pulse) statusDot.classList.add('pulse');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(ts) {
  try { return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function messageTitle(msg) {
  if (msg.role === 'user') return msg.kind === 'steer' ? 'You · steer' : 'You';
  if (msg.role === 'system') return 'System';
  if (msg.kind === 'error') return 'Agent · error';
  return 'Agent';
}

function renderMessages(messages = []) {
  latestMessages = messages;
  if (!messages.length) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-glow"></div>
        <h1>What should the browser do?</h1>
        <p>Start with a task, then keep chatting: ask follow-ups, correct course, or steer the agent while it is working.</p>
      </div>`;
    return;
  }

  messagesEl.innerHTML = messages.map((msg) => `
    <article class="msg ${escapeHtml(msg.role || 'system')} ${escapeHtml(msg.kind || '')}">
      <div class="msg-meta">
        <span>${escapeHtml(messageTitle(msg))}</span>
        <time>${escapeHtml(formatTime(msg.timestamp))}</time>
      </div>
      <div class="msg-bubble">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>
    </article>
  `).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderInputBackend(backend) {
  const resolved = backend || 'cdp';
  inputBackendNameEl.textContent = resolved === 'native' ? 'Native' : 'CDP';
}

function isBusy(status) {
  return ['running', 'thinking', 'acting', 'stopping'].includes(status?.state);
}

function describeStatus(status) {
  if (!status || status.state === 'idle' || status.state === undefined) return 'Idle';
  if (status.state === 'thinking') return `Thinking · ${status.iteration + 1 || 1}/${status.maxIterations || '?'}`;
  if (status.state === 'acting') return 'Acting in browser';
  if (status.state === 'running') return 'Working';
  if (status.state === 'stopping') return 'Stopping';
  if (status.state === 'done') return 'Done';
  if (status.state === 'error') return 'Error';
  if (status.state === 'stopped') return 'Stopped';
  return status.state;
}

function renderStatus(status) {
  latestStatus = status || { state: 'idle' };
  const busy = isBusy(latestStatus);

  if (!latestStatus || latestStatus.state === 'idle' || latestStatus.state === undefined) {
    setDot('grey');
  } else if (latestStatus.state === 'done') {
    setDot('green');
  } else if (latestStatus.state === 'error') {
    setDot('red');
  } else if (latestStatus.state === 'acting') {
    setDot('blue', true);
  } else {
    setDot('yellow', busy);
  }

  statusText.textContent = describeStatus(latestStatus);
  stopBtn.disabled = !busy;
  runBtn.disabled = false;
  taskInput.placeholder = busy ? 'Send a steer or correction…' : 'Ask a follow-up or start a new task…';

  if (busy) {
    activityCard.hidden = false;
    activityTitle.textContent = latestStatus.state === 'acting' ? 'Doing' : 'Thinking';
    activityMessage.textContent = latestStatus.message || latestStatus.nextGoal || 'The agent is reading the page and planning.';
    currentUrlEl.textContent = latestStatus.url || '';
    iterationCounter.textContent = Number.isFinite(latestStatus.iteration)
      ? `${latestStatus.iteration + 1}/${latestStatus.maxIterations || '?'}`
      : '';
  } else {
    activityCard.hidden = true;
  }
}

function sendMessage(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, (response) => resolve(response || {})));
}

function autosize() {
  taskInput.style.height = 'auto';
  taskInput.style.height = `${Math.min(taskInput.scrollHeight, 120)}px`;
}

debugCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ debugMode: debugCheckbox.checked });
});

taskInput.addEventListener('input', () => {
  chrome.storage.local.set({ lastTask: taskInput.value });
  autosize();
});

taskInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = taskInput.value.trim();
  if (!text) return;

  chrome.storage.local.set({ lastTask: '' });
  taskInput.value = '';
  autosize();

  chrome.storage.local.get(['provider', 'apiKey', 'debugMode'], async (config) => {
    const provider = config.provider || 'openai';
    const oauthProviders = ['openai-codex', 'anthropic-oauth', 'gemini-cli'];
    const needsKey = !oauthProviders.includes(provider) && provider !== 'ollama';
    if (needsKey && !config.apiKey) {
      renderMessages([...latestMessages, { role: 'system', kind: 'error', content: 'Please set your API key in Settings.', timestamp: Date.now() }]);
      return;
    }
    const response = await sendMessage({ type: 'chat_send', message: text, debugMode: debugCheckbox.checked });
    if (!response.ok) {
      renderMessages([...latestMessages, { role: 'system', kind: 'error', content: response.error || 'Could not send message.', timestamp: Date.now() }]);
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop_task' });
});

newChatBtn.addEventListener('click', async () => {
  if (isBusy(latestStatus) && !confirm('The agent is still working. Stop it and clear the chat?')) return;
  if (isBusy(latestStatus)) chrome.runtime.sendMessage({ type: 'stop_task' });
  await sendMessage({ type: 'chat_clear' });
  renderMessages([]);
  renderStatus({ state: 'idle' });
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

logsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('log-viewer/viewer.html') });
});

inputBackendChangeEl.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#input-backend') });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'agent_status') renderStatus(message.status);
  if (message.type === 'chat_messages') renderMessages(message.messages || []);
});

document.addEventListener('DOMContentLoaded', async () => {
  chrome.storage.local.get(['inputBackend', 'debugMode', 'lastTask'], (data) => {
    renderInputBackend(data.inputBackend);
    debugCheckbox.checked = !!data.debugMode;
    if (data.lastTask) taskInput.value = data.lastTask;
    autosize();
  });

  const initial = await sendMessage({ type: 'chat_get' });
  renderMessages(initial.messages || []);
  renderStatus(initial.status || { state: 'idle' });

  setInterval(() => {
    chrome.storage.local.get('agentStatus', (data) => renderStatus(data.agentStatus));
  }, 750);
});
