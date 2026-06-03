const statusEl = document.getElementById('status');
const listEl = document.getElementById('log-list');
const titleEl = document.getElementById('log-title');
const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
const screenshotEl = document.getElementById('screenshot');
const refreshBtn = document.getElementById('refresh-btn');
const deleteAllBtn = document.getElementById('delete-all-btn');

let logsDir = null;
let activeUrl = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#fca5a5' : '#9ca3af';
}

async function getLogsDir({ create = false } = {}) {
  if (!navigator.storage?.getDirectory) {
    throw new Error('This browser does not support the Origin Private File System API used for debug logs.');
  }
  const root = await navigator.storage.getDirectory();
  try {
    logsDir = await root.getDirectoryHandle('logs', { create });
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
  return logsDir;
}

async function readEntries() {
  const dir = await getLogsDir({ create: false });
  if (!dir) return [];
  const entries = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
    const file = await handle.getFile();
    entries.push({ name, handle, file, modified: file.lastModified, size: file.size });
  }
  entries.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  return entries;
}

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}

async function findScreenshotFromMarkdown(markdown) {
  const match = markdown.match(/!\[[^\]]*\]\(\.\/([^\)]+\.jpg)\)/i);
  if (!match || !logsDir) return null;
  try {
    const handle = await logsDir.getFileHandle(match[1]);
    const file = await handle.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

async function openLog(entry, button) {
  document.querySelectorAll('.log-list button').forEach((el) => el.classList.remove('active'));
  button?.classList.add('active');
  activeUrl = null;
  const markdown = await entry.file.text();
  titleEl.textContent = entry.name;
  metaEl.textContent = `${formatTime(entry.modified)} · ${entry.size.toLocaleString()} bytes`;
  contentEl.textContent = markdown;
  screenshotEl.textContent = '';
  const screenshotUrl = await findScreenshotFromMarkdown(markdown);
  if (screenshotUrl) {
    activeUrl = screenshotUrl;
    const img = document.createElement('img');
    img.alt = `Screenshot for ${entry.name}`;
    img.src = screenshotUrl;
    screenshotEl.appendChild(img);
  }
}

async function loadLogs() {
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = null;
  listEl.textContent = '';
  titleEl.textContent = 'Select a log';
  metaEl.textContent = '';
  screenshotEl.textContent = '';
  contentEl.textContent = '';
  setStatus('Loading logs…');

  try {
    const entries = await readEntries();
    if (!entries.length) {
      setStatus('No debug logs found. Enable Debug in the popup and run a task first.');
      listEl.innerHTML = '<li class="empty">No logs yet</li>';
      return;
    }
    setStatus(`${entries.length} log${entries.length === 1 ? '' : 's'} found`);
    for (const entry of entries) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span class="log-name"></span><span class="log-sub"></span>`;
      btn.querySelector('.log-name').textContent = entry.name;
      btn.querySelector('.log-sub').textContent = `${formatTime(entry.modified)} · ${entry.size.toLocaleString()} bytes`;
      btn.addEventListener('click', () => openLog(entry, btn));
      li.appendChild(btn);
      listEl.appendChild(li);
    }
    const firstButton = listEl.querySelector('button');
    if (firstButton) firstButton.click();
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), true);
  }
}

async function deleteAllLogs() {
  if (!confirm('Delete all Browser Agent debug logs?')) return;
  const dir = await getLogsDir({ create: false });
  if (dir) {
    for await (const [name] of dir.entries()) {
      await dir.removeEntry(name).catch(console.warn);
    }
  }
  await loadLogs();
}

refreshBtn.addEventListener('click', loadLogs);
deleteAllBtn.addEventListener('click', deleteAllLogs);
loadLogs();
