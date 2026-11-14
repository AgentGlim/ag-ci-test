// v0.2.18: GitHub's Windows runners put TEMP under the 8.3 short name of the profile folder (RUNNER~1) while HOME and
// git use the long name (runneradmin). `npm run update` compared git's top-level path with its own path as strings
// and called its own checkout "not a git checkout"; a test treated the ~ in RUNNER~1 as an unexpanded home folder.
// These tests rebuild both situations on every OS (and with a real short name on Windows when the volume has them).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const win = process.platform === 'win32';
const have = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

// A clone of a tiny "release" repo that is one commit behind its origin, plus an isolated HOME / data / run folder.
function updateFixture(t, root) {
  const genv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global') };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], { cwd, env: genv, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  const src = path.join(root, 'src');
  fs.cpSync(path.join(REPO, 'app'), path.join(src, 'app'), { recursive: true, filter: (p) => !/[/\\](tests|node_modules)([/\\]|$)/.test(p) });
  for (const d of ['tools', 'harness', 'skills']) fs.cpSync(path.join(REPO, d), path.join(src, d), { recursive: true, filter: (p) => !/node_modules/.test(p) });
  fs.writeFileSync(path.join(src, 'version.txt'), 'v0\n');
  g(src, 'init', '-q', '-b', 'main'); g(src, 'add', '-A'); g(src, 'commit', '-qm', 'base');
  const clone = path.join(root, 'a-long-checkout-folder-name');
  g(root, 'clone', '-q', '--branch', 'main', src, clone);
  fs.writeFileSync(path.join(src, 'version.txt'), 'v1\n'); g(src, 'commit', '-qam', 'the new release');
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...genv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_RUN: path.join(root, 'run'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_ENV_FILE: path.join(home, 'env') };
  fs.writeFileSync(env.AGENTGLIM_CONFIG, '{}'); fs.writeFileSync(env.AGENTGLIM_ENV_FILE, '');
  return { clone, env, version: () => fs.readFileSync(path.join(clone, 'version.txt'), 'utf8').trim() };
}

const runUpdate = (script, env) => spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });

test('npm run update recognises its own checkout when git spells the top-level path differently (any OS)', (t) => {
  if (win) return t.skip('the real 8.3 short-name case runs below on Windows');
  if (!have('git')) return t.skip('git is not available here');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0218-spell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = updateFixture(t, root);
  // A git that reports the top level under a spelling node cannot map back to the script's own path, as git for
  // Windows does with the long profile name (runneradmin) for a script started through its short name (RUNNER~1).
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --show-toplevel "*) "$REAL_GIT" "$@" >/dev/null || exit $?; echo /elsewhere/LONGNAME-not-the-same-spelling/checkout; exit 0;; esac\nexec "$REAL_GIT" "$@"\n`, { mode: 0o755 });
  const env = { ...fx.env, REAL_GIT: realGit, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = runUpdate(path.join(fx.clone, 'tools', 'update.mjs'), env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /not a git checkout/);
  assert.equal(fx.version(), 'v1', 'the checkout was pulled');
  // still refuses a copy nested inside another checkout
  const nested = path.join(fx.clone, 'archive', 'tools'); fs.mkdirSync(nested, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'tools', 'update.mjs'), path.join(nested, 'update.mjs'));
  const n = runUpdate(path.join(nested, 'update.mjs'), env);
  assert.equal(n.status, 1); assert.match(n.stderr, /not a git checkout/);
});

test('npm run update names git\'s "dubious ownership" refusal instead of calling the checkout a tarball', (t) => {
  if (win) return t.skip('uses a POSIX shell stand-in for git');
  if (!have('git')) return t.skip('git is not available here');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0218-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = updateFixture(t, root);
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "fatal: detected dubious ownership in repository at '$PWD'" >&2\necho "To add an exception for this directory, call: git config --global --add safe.directory '$PWD'" >&2\nexit 128\n`, { mode: 0o755 });
  const r = runUpdate(path.join(fx.clone, 'tools', 'update.mjs'), { ...fx.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dubious ownership/); assert.match(r.stderr, /safe\.directory/);
  assert.doesNotMatch(r.stderr, /tarball/);
  assert.equal(fx.version(), 'v0', 'nothing was pulled');
});

// Windows: start update.mjs through the 8.3 short name of its checkout, as on GitHub's runners.
const shortName = (p) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:AG_P).ShortPath'], { env: { ...process.env, AG_P: p }, encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? r.stdout.trim() : '';
};

test('Windows: npm run update started through an 8.3 short path (a RUNNER~1 style folder) still pulls', (t) => {
  if (!win) return t.skip('8.3 short names exist on Windows only');
  if (!have('git')) return t.skip('git is not available here');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0218-shortname-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = updateFixture(t, root);
  const short = shortName(fx.clone);
  if (!short || short.toLowerCase() === fx.clone.toLowerCase()) return t.skip('this volume has no 8.3 short names');
  assert.notEqual(path.basename(short).toLowerCase(), path.basename(fx.clone).toLowerCase());
  const r = runUpdate(path.join(short, 'tools', 'update.mjs'), fx.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fx.version(), 'v1', 'the checkout was pulled');
});

test('a ~ inside HOME itself (RUNNER~1) is kept: only a leading ~ of a saved path expands', async () => {
  // the ~\ form (Windows Setup) expands since v0.2.17's expandHome; older paths.mjs only expand ~/
  const forms = (await import('../paths.mjs')).expandHome ? ['~\\plansdir', '~/plansdir'] : ['~/plansdir'];
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0218-home-'));
  const home = path.join(parent, 'RUNNER~1'), data = path.join(home, 'data'); fs.mkdirSync(data, { recursive: true });
  try {
    for (const saved of forms) {
      fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify({ plans: { path: saved } }));
      const code = `const p = await import(${JSON.stringify(new URL(`file://${path.join(REPO, 'app', 'paths.mjs')}`).href)}); console.log(JSON.stringify({ plans: p.PLANS }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: REPO, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: data, XDG_CONFIG_HOME: path.join(home, 'cfg') }, encoding: 'utf8', timeout: 30e3 });
      assert.equal(r.status, 0, r.stderr);
      const { plans } = JSON.parse(r.stdout);
      assert.ok(plans.startsWith(home), plans);
      assert.match(plans.slice(home.length), /^[\\/]plansdir$/, `${saved} -> ${plans}`);
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
