import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REPORTS_STORAGE_KEY, formatReportTimestamp, reportHash, initDiscoveryReports,
} from './discovery-reports.js';

const html = await readFile(new URL('./discovery-reports.html', import.meta.url), 'utf8');

function element(tag = 'div') {
  return {
    tag, hidden: false, disabled: false, textContent: '', href: '',
    children: [], listeners: new Map(), attributes: new Map(),
    set innerHTML(_) { assert.fail('Report data must not be rendered through innerHTML'); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, handler) { this.listeners.set(event, handler); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

function report(id = 'session:2', timestamp = 1700000000000) {
  return {
    discoveryId: id, timestamp, url: 'https://example.com/reset/[redacted]', operation: 'CLICK',
    locator: 'html > body:nth-of-type(1) > button:nth-of-type(2)',
    relevantDOM: { tag: 'button', index: 5, target: { tag: 'button', childCount: 0 } },
    originalListedIndices: [0, 2, 3], originalListedCount: 3, originalElementCount: 7,
    reason: 'Resolved a unique visible DOM target after TARGET_NOT_LISTED', executionResult: 'executed',
    screenshotCaptured: true, screenshotSaved: false,
    screenshotPrivacy: 'Not persisted because reliable pixel redaction is unavailable.',
  };
}

function page(stored = [], hash = '', get) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const fields = new Map(ids.map(id => [id, element()]));
  const created = [];
  const window = {
    location: { hash }, listeners: new Map(),
    addEventListener(event, handler) { this.listeners.set(event, handler); },
  };
  const document = {
    getElementById(id) { assert.ok(fields.has(id), `Missing DOM ID ${id}`); return fields.get(id); },
    createElement(tag) { created.push(tag); return element(tag); },
  };
  let changed;
  const runtime = {};
  const reads = [];
  const storage = {
    local: {
      get(keys, callback) {
        reads.push(keys);
        assert.deepEqual(keys, [REPORTS_STORAGE_KEY], 'Viewer must not read provider credentials or task logs');
        if (get) get(callback, runtime);
        else callback({ [REPORTS_STORAGE_KEY]: stored });
      },
      set() { assert.fail('Viewer must not persist report data'); },
    },
    onChanged: { addListener(handler) { changed = handler; } },
  };
  const ui = initDiscoveryReports({ document, window, storage, runtime });
  return {
    fields, window, created, reads, ui,
    hashchange(hash) { window.location.hash = hash; window.listeners.get('hashchange')(); },
    changed(value, area = 'local') { changed({ [REPORTS_STORAGE_KEY]: { newValue: value } }, area); },
    credentialChange() { changed({ jevApiKey: { newValue: 'secret-marker' } }, 'local'); },
  };
}

const selectedJSON = page => page.fields.get('report-json').textContent;
const rows = page => page.fields.get('reports-list').children;

test('viewer page and options link expose the report route and required IDs', async () => {
  const options = await readFile(new URL('./options.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('./discovery-reports.js', import.meta.url), 'utf8');
  assert.match(options, /id="discovery-reports-link" href="discovery-reports.html"/);
  assert.match(html, /src="discovery-reports.js" type="module"/);
  assert.match(html, /href="options.html"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|\.click\(|\.focus\(|dispatchEvent|storage\.local\.set/);
});

test('empty, missing, and malformed storage show an empty viewer', async () => {
  for (const stored of [undefined, null, {}, 'bad-data', [], [null, {}, { discoveryId: 2 }, { discoveryId: '\ud800' }]]) {
    const p = page(stored);
    await p.ui.ready;
    assert.equal(p.fields.get('reports-table').hidden, true);
    assert.equal(p.fields.get('report-detail').hidden, true);
    assert.equal(p.fields.get('reports-status').textContent, 'No DOM discovery reports yet.');
    assert.equal(selectedJSON(p), '');
  }
});

test('newest-first list contains timestamp, sanitized URL, and outcome; JSON retains diagnostic fields', async () => {
  const older = report('old', 1700000000000);
  const newer = report('new', 1700000001000);
  const p = page([older, newer]);
  await p.ui.ready;
  assert.equal(rows(p).length, 2);
  const first = rows(p)[0].children;
  assert.equal(first[0].children[0].textContent, new Date(newer.timestamp).toISOString());
  assert.equal(first[0].children[0].href, '#new');
  assert.equal(first[1].textContent, newer.url);
  assert.equal(first[1].tag, 'td', 'Sanitized URLs must be text, not external navigation links');
  assert.equal(first[2].textContent, 'executed');
  assert.deepEqual(JSON.parse(selectedJSON(p)), newer);
  assert.match(p.fields.get('report-privacy').textContent, /reliable pixel redaction/);
  assert.equal(first[0].children[0].attributes.get('aria-current'), 'true');
  assert.ok(p.created.every(tag => ['tr', 'td', 'a'].includes(tag)));
});

test('encoded deep links inspect the requested report and hash changes update selection', async () => {
  const special = report('session:1 /#%?=&+');
  const latest = report('latest');
  assert.equal(reportHash(special.discoveryId), `#${encodeURIComponent(special.discoveryId)}`);
  const p = page([special, latest], reportHash(special.discoveryId));
  await p.ui.ready;
  assert.deepEqual(JSON.parse(selectedJSON(p)), special);
  assert.equal(rows(p)[1].children[0].children[0].attributes.get('aria-current'), 'true');
  p.hashchange('#latest');
  assert.deepEqual(JSON.parse(selectedJSON(p)), latest);
  assert.equal(rows(p)[1].children[0].children[0].attributes.has('aria-current'), false);
  p.hashchange('');
  assert.deepEqual(JSON.parse(selectedJSON(p)), latest);
});

test('unknown or malformed deep links do not echo their contents', async () => {
  const p = page([report()]);
  await p.ui.ready;
  for (const hash of ['#secret-marker', '#%E0%A4%A', '#%ZZ']) {
    p.hashchange(hash);
    assert.equal(p.fields.get('report-detail').hidden, true);
    assert.equal(selectedJSON(p), '');
    assert.equal(p.fields.get('reports-status').textContent, 'Report not found. It may have been removed from the 50-report history.');
  }
});

test('HTML-like URL, outcome, privacy notice, and structural excerpt remain literal text', async () => {
  const value = report('<img src=x onerror=alert(1)>');
  value.url = 'https://example.com/<script>alert(1)</script>';
  value.executionResult = '<svg onload=alert(1)>';
  value.relevantDOM.excerpt = '<button onclick="alert(1)">';
  value.screenshotPrivacy = '<img src=x onerror=alert(1)>';
  const p = page([value], reportHash(value.discoveryId));
  await p.ui.ready;
  assert.deepEqual(JSON.parse(selectedJSON(p)), value);
  assert.equal(rows(p)[0].children[1].textContent, value.url);
  assert.equal(rows(p)[0].children[2].textContent, value.executionResult);
  assert.ok(p.fields.get('report-privacy').textContent.includes(value.screenshotPrivacy));
  assert.equal(rows(p)[0].children[0].children[0].href, reportHash(value.discoveryId));
  assert.ok(!p.created.includes('img'));
  assert.ok(!p.created.includes('script'));
  assert.ok(!p.created.includes('svg'));
});

test('retention is bounded to 50 reports and invalid timestamps have a safe label', async () => {
  const p = page(Array.from({ length: 60 }, (_, index) => report(String(index))));
  await p.ui.ready;
  assert.equal(rows(p).length, 50);
  assert.equal(rows(p)[0].children[0].children[0].href, '#59');
  assert.equal(rows(p)[49].children[0].children[0].href, '#10');
  for (const value of [undefined, 'secret-marker', NaN, Infinity, 1e20]) {
    assert.equal(formatReportTimestamp(value), 'Unknown timestamp');
  }
  assert.equal(formatReportTimestamp(0), '1970-01-01T00:00:00.000Z');
});

test('live storage updates retain selection, ignore other storage/credentials, and handle removals', async () => {
  const selected = report('selected');
  const p = page([selected], '#selected');
  await p.ui.ready;
  p.credentialChange();
  p.changed([report('other')], 'sync');
  assert.deepEqual(JSON.parse(selectedJSON(p)), selected);
  const updated = { ...selected, executionResult: 'execution failed' };
  p.changed([updated, report('newer')]);
  assert.deepEqual(JSON.parse(selectedJSON(p)), updated);
  p.changed([]);
  assert.equal(p.fields.get('report-detail').hidden, true);
  assert.match(p.fields.get('reports-status').textContent, /^Report not found/);
});

test('storage failures and thrown errors display a fixed message without error details', async () => {
  for (const get of [
    (callback, runtime) => { runtime.lastError = { message: 'secret-marker' }; callback(undefined); },
    () => { throw new Error('secret-marker'); },
  ]) {
    const p = page([], '', get);
    await p.ui.ready;
    assert.equal(p.fields.get('reports-status').textContent, 'Could not load reports. Try refreshing.');
    assert.equal(p.fields.get('reports-refresh-btn').disabled, false);
    assert.equal(selectedJSON(p), '');
  }
});

test('refresh reads current storage and stale pending reads cannot replace live updates', async () => {
  const callbacks = [];
  const p = page([], '', callback => callbacks.push(callback));
  assert.equal(p.fields.get('reports-refresh-btn').disabled, true);
  const current = report('current');
  p.changed([current]);
  callbacks.shift()({ [REPORTS_STORAGE_KEY]: [report('stale')] });
  await p.ui.ready;
  assert.deepEqual(JSON.parse(selectedJSON(p)), current);
  const refresh = p.fields.get('reports-refresh-btn').listeners.get('click')();
  callbacks.shift()({ [REPORTS_STORAGE_KEY]: [report('refreshed')] });
  await refresh;
  assert.equal(JSON.parse(selectedJSON(p)).discoveryId, 'refreshed');
  assert.equal(p.reads.length, 2);
  assert.equal(p.fields.get('reports-refresh-btn').disabled, false);
});
