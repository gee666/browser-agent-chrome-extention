import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Link the real ES-module graphs, without evaluating Chrome APIs. Source-text
// mocks that strip imports missed the absent Jev file and service-worker export.
for (const entry of ['../background/sw.js', './options.js', './bridge-settings.js']) {
  test(`${entry} links against the actual checked-out submodules`, () => {
    const url = new URL(entry, import.meta.url).href;
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
      import { SourceTextModule } from 'node:vm';
      import { readFile } from 'node:fs/promises';
      const cache = new Map();
      async function get(url) {
        if (!cache.has(url)) cache.set(url, readFile(new URL(url), 'utf8').then(source =>
          new SourceTextModule(source, { identifier: url })));
        return await cache.get(url);
      }
      const root = await get(${JSON.stringify(url)});
      await root.link((specifier, parent) => get(new URL(specifier, parent.identifier).href));
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}
