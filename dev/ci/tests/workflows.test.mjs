import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = name => parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const ci = read('ci.yml'), desktop = read('desktop.yml'), warm = read('desktop-cache.yml'), browser = read('browser.yml');
const action = (job, prefix) => job.steps.find(s => s.uses?.startsWith(prefix));

test('every original Node/Python/platform combination remains', () => {
  const matrix = ci.jobs.tests.strategy.matrix;
  assert.deepEqual(matrix.os, ['ubuntu-latest']);
  assert.deepEqual(matrix.node, ['22.13.0', '22.x', '24.x']);
  assert.deepEqual(matrix.python, ['3.11', '3.12', '3.13', '3.14', '3.15-dev']);
  assert.deepEqual(matrix.include, [
    { os: 'macos-latest', node: '22.13.0', python: '3.11' },
    { os: 'macos-latest', node: '24.x', python: '3.15-dev' },
    { os: 'windows-latest', node: '22.13.0', python: '3.11' },
    { os: 'windows-latest', node: '24.x', python: '3.15-dev' },
  ]);
  assert.equal(matrix.exclude, undefined);
  const tests = ci.jobs.tests.steps.filter(s => s.run?.includes('npm test'));
  assert.equal(tests.length, 2);
  assert.equal(tests[0].if, "runner.os != 'Linux'");
  assert.equal(tests[1].if, "runner.os == 'Linux'");
  assert.match(tests[1].run, /PYTHONWARNINGS=error::DeprecationWarning npm test/);
});
test('both isolated fresh-copy jobs are retained', () => {
  assert.ok(ci.jobs['published-copy'], 'published-copy lane is required');
  assert.deepEqual(ci.jobs['published-copy'].strategy.matrix.os, ['macos-latest', 'windows-latest']);
  assert.match(ci.jobs['published-copy'].steps.at(-1).run, /USERPROFILE=.*TMPDIR=.*npm test/);
});
test('release validation calls the full exact-commit CI workflow, including browser smoke', () => {
  assert.ok(Object.hasOwn(ci.on, 'workflow_call'));
  assert.equal(desktop.jobs.verify.uses, './.github/workflows/ci.yml');
  assert.equal(desktop.jobs.prepare.needs, 'verify');
  assert.deepEqual(desktop.jobs.build.needs, ['verify', 'prepare']);
  assert.match(desktop.jobs.prepare.steps.at(-1).run, /publish-release\.mjs --check-draft$/);
  assert.equal(desktop.concurrency['cancel-in-progress'], false);
  assert.deepEqual(desktop.jobs.publish.needs, ['verify', 'build']);
  assert.equal(ci.jobs.browser.uses, './.github/workflows/browser.yml');
  assert.equal(ci.jobs.browser.needs, 'privacy');
  assert.ok(Object.hasOwn(browser.on, 'workflow_call'));
  for (const job of Object.values(desktop.jobs)) {
    assert.equal(job['continue-on-error'], undefined);
    assert.doesNotMatch(job.if ?? '', /always\(/);
  }
});
test('installers remain draft until all platforms and the native smoke succeed', () => {
  const build = desktop.jobs.build;
  const tauri = action(build, 'tauri-apps/tauri-action@');
  assert.equal(tauri.with.releaseDraft, true);
  assert.equal(tauri.with.tauriScript, 'npx --yes --package @tauri-apps/cli@2.12.4 tauri');
  assert.match(tauri.with.args, /-- --locked$/);
  const smoke = build.steps.find(s => s.run?.includes('node desktop/smoke-test.mjs'));
  assert.equal(smoke.if, "runner.os == 'Linux'");
  assert.ok(build.steps.indexOf(smoke) > build.steps.indexOf(tauri));
  assert.equal(desktop.jobs.publish.steps.at(-1).run, 'node dev/ci/publish-release.mjs');
  assert.equal(desktop.permissions.contents, 'read');
  assert.equal(desktop.jobs.publish.permissions.contents, 'write');
});
test('cache warmer is manual, main-only, unbundled and cannot publish', () => {
  assert.deepEqual(Object.keys(warm.on), ['workflow_dispatch']);
  assert.equal(warm.jobs.warm.if, "github.ref == 'refs/heads/main'");
  assert.equal(warm.permissions.contents, 'read');
  assert.deepEqual(warm.jobs.warm.strategy.matrix.os, desktop.jobs.build.strategy.matrix.include.map(c => c.os));
  const body = JSON.stringify(warm);
  assert.match(body, /--no-bundle -- --locked/);
  assert.doesNotMatch(body, /tauri-apps\/tauri-action|gh release|publish-release\.mjs/);
});
test('warming and release restore share profile, target and cache identity', () => {
  const a = action(warm.jobs.warm, 'Swatinem/rust-cache@');
  const b = action(desktop.jobs.build, 'Swatinem/rust-cache@');
  assert.deepEqual(a.with, b.with);
  assert.equal(a.with.workspaces, 'desktop -> target');
  assert.equal(a.with['save-if'], "${{ github.ref == 'refs/heads/main' }}");
  assert.equal(a.with['cache-bin'], 'false');
  assert.match(a.with['shared-key'], /runner.os.*runner.arch/);
  assert.deepEqual(warm.jobs.warm.env, desktop.jobs.build.env);
});
test('browser tools are pinned and smoke runs fixture specs once in one Linux lane', () => {
  const job = browser.jobs.smoke;
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job.strategy, undefined);
  assert.match(action(job, 'actions/setup-node@').with['cache-dependency-path'], /dev\/ci\/package-lock.json/);
  const body = job.steps.find(s => s.name === 'Fixture-backed browser smoke').run;
  assert.match(body, /for spec in skills-editor-xss send-to-agent inbox-resend/);
  assert.match(body, /timeout --kill-after=10s 120s/);
  assert.match(body, /export HOME=.*browser-home/);
  assert.match(body, /exit "\$failed"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'dev/ci/package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'dev/ci/package-lock.json')));
  assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
  for (const version of Object.values(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
});
test('private export allowlist carries the new CI source files', () => {
  const manifest = path.join(root, 'public.txt');
  if (!fs.existsSync(manifest)) return;
  const entries = fs.readFileSync(manifest, 'utf8').split('\n');
  assert.ok(entries.includes('.github/workflows/browser.yml'));
  assert.ok(entries.includes('.github/workflows/desktop-cache.yml'));
  assert.ok(entries.includes('dev/ci/'));
});

test('branch and PR CI bundle every desktop platform without a release token or uploads', () => {
  const build = ci.jobs['desktop-build'];
  assert.equal(build.needs, 'privacy');
  assert.equal(build.permissions.contents, 'read');
  assert.deepEqual(build.strategy.matrix, desktop.jobs.build.strategy.matrix);
  const tauri = action(build, 'tauri-apps/tauri-action@');
  const release = action(desktop.jobs.build, 'tauri-apps/tauri-action@');
  assert.equal(tauri.with.projectPath, release.with.projectPath);
  assert.equal(tauri.with.tauriScript, release.with.tauriScript);
  assert.equal(tauri.with.args, release.with.args);
  assert.equal(tauri.with.uploadWorkflowArtifacts, false);
  for (const key of ['releaseId', 'tagName', 'releaseName', 'releaseDraft']) assert.equal(tauri.with[key], undefined);
  assert.doesNotMatch(JSON.stringify(build), /GITHUB_TOKEN|GH_TOKEN|publish-release|contents.*write/);
  assert.deepEqual(action(build, 'Swatinem/rust-cache@').with, action(desktop.jobs.build, 'Swatinem/rust-cache@').with);
  const smoke = build.steps.find(s => s.run?.includes('node desktop/smoke-test.mjs'));
  assert.equal(smoke.if, "runner.os == 'Linux'");
  assert.ok(build.steps.indexOf(smoke) > build.steps.indexOf(tauri));
});
