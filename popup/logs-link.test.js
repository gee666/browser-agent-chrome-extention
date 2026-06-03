import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('popup View Logs target exists', async () => {
  const popupJs = await readFile(path.join(ROOT, 'popup/popup.js'), 'utf8');
  assert.match(popupJs, /chrome\.runtime\.getURL\(['"]log-viewer\/viewer\.html['"]\)/);
  await access(path.join(ROOT, 'log-viewer/viewer.html'), constants.R_OK);
  await access(path.join(ROOT, 'log-viewer/viewer.js'), constants.R_OK);
  await access(path.join(ROOT, 'log-viewer/viewer.css'), constants.R_OK);
});

test('log viewer can read extension OPFS logs directory', async () => {
  const viewerJs = await readFile(path.join(ROOT, 'log-viewer/viewer.js'), 'utf8');
  assert.match(viewerJs, /navigator\.storage\?\.getDirectory/);
  assert.match(viewerJs, /getDirectoryHandle\(['"]logs['"]/);
});
