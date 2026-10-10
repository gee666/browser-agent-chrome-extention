export const REPORTS_STORAGE_KEY = 'domDiscoveryReports';

export function reportHash(discoveryId) {
  return `#${encodeURIComponent(discoveryId)}`;
}

function retainedReports(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).filter(report => {
    if (!report || typeof report !== 'object' || typeof report.discoveryId !== 'string' || !report.discoveryId) return false;
    try { reportHash(report.discoveryId); return true; } catch { return false; }
  }).reverse();
}

export function formatReportTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'Unknown timestamp';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Unknown timestamp' : date.toISOString();
}

export function initDiscoveryReports({ document, window, storage, runtime }) {
  const list = document.getElementById('reports-list');
  const table = document.getElementById('reports-table');
  const status = document.getElementById('reports-status');
  const detail = document.getElementById('report-detail');
  const json = document.getElementById('report-json');
  const privacy = document.getElementById('report-privacy');
  const refresh = document.getElementById('reports-refresh-btn');
  let reports = [];
  let links = [];
  let readSequence = 0;

  function selectedReport() {
    if (!window.location.hash || window.location.hash === '#') return reports[0];
    try {
      const id = decodeURIComponent(window.location.hash.slice(1));
      return reports.find(report => report.discoveryId === id);
    } catch {
      return undefined;
    }
  }

  function renderSelection() {
    const selected = selectedReport();
    for (const { report, link } of links) {
      if (report === selected) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    detail.hidden = !selected;
    json.textContent = '';
    privacy.textContent = '';
    if (selected) {
      // Runtime/core own redaction. Read only their persistence-safe reports,
      // never provider credentials, screenshots, raw DOM, or task logs.
      try { json.textContent = JSON.stringify(selected, null, 2); }
      catch { json.textContent = 'This report could not be displayed.'; }
      privacy.textContent = typeof selected.screenshotPrivacy === 'string'
        ? `Screenshot not saved. ${selected.screenshotPrivacy}`
        : 'Screenshot not saved because reliable pixel redaction is unavailable.';
      status.textContent = `${reports.length} stored report${reports.length === 1 ? '' : 's'}.`;
    } else if (window.location.hash && window.location.hash !== '#') {
      status.textContent = 'Report not found. It may have been removed from the 50-report history.';
    } else {
      status.textContent = 'No DOM discovery reports yet.';
    }
  }

  function render(value) {
    reports = retainedReports(value);
    links = [];
    list.replaceChildren();
    table.hidden = reports.length === 0;
    for (const report of reports) {
      const row = document.createElement('tr');
      const timestamp = document.createElement('td');
      const link = document.createElement('a');
      link.href = reportHash(report.discoveryId);
      link.textContent = formatReportTimestamp(report.timestamp);
      timestamp.append(link);
      const url = document.createElement('td');
      url.textContent = typeof report.url === 'string' ? report.url : 'Unknown URL';
      const outcome = document.createElement('td');
      outcome.textContent = typeof report.executionResult === 'string' ? report.executionResult : 'Unknown outcome';
      row.append(timestamp, url, outcome);
      list.append(row);
      links.push({ report, link });
    }
    renderSelection();
  }

  function reload() {
    const sequence = ++readSequence;
    refresh.disabled = true;
    status.textContent = 'Loading reports...';
    return new Promise(resolve => {
      function failed() {
        if (sequence === readSequence) {
          render([]);
          status.textContent = 'Could not load reports. Try refreshing.';
          refresh.disabled = false;
        }
        resolve();
      }
      try {
        storage.local.get([REPORTS_STORAGE_KEY], stored => {
          // Never echo storage error details, even if they contain sensitive data.
          const error = !!runtime.lastError;
          if (error) { failed(); return; }
          if (sequence === readSequence) {
            render(stored?.[REPORTS_STORAGE_KEY]);
            refresh.disabled = false;
          }
          resolve();
        });
      } catch {
        failed();
      }
    });
  }

  refresh.addEventListener('click', reload);
  window.addEventListener('hashchange', renderSelection);
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, REPORTS_STORAGE_KEY)) return;
    // Ignore a stale pending read if the stored reports have changed meanwhile.
    readSequence++;
    refresh.disabled = false;
    render(changes[REPORTS_STORAGE_KEY].newValue);
  });
  return { reload, ready: reload() };
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  initDiscoveryReports({ document, window, storage: chrome.storage, runtime: chrome.runtime });
}
