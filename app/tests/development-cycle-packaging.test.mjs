// Run against both private source and a clean public export; no build-job helpers are required.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
test('development-cycle export carries the CLI, protected runtime and browser check', () => {
  for (const name of ['harness/bin/development-cycle.mjs',
    'app/development-cycle/node-check-bootstrap.cjs',
    'app/development-cycle/node-check-hooks.mjs',
    'app/development-cycle/node-check-runtime.mjs',
    'app/development-cycle/node-check-reporter.mjs',
    'app/development-cycle/worker-adapter.mjs',
    'app/tests/development-cycle.spec.mjs']) {
    assert.ok(fs.statSync(new URL(name, root)).isFile(), `missing export: ${name}`);
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts['test:development-cycle:browser'], 'node app/tests/development-cycle.spec.mjs');
  const manifest = new URL('public.txt', root);
  if (fs.existsSync(manifest)) {
    assert.ok(fs.readFileSync(manifest, 'utf8').split('\n').includes('harness/bin/development-cycle.mjs'),
      `private export allowlist omits CLI in ${fileURLToPath(manifest)}`);
  }
});
