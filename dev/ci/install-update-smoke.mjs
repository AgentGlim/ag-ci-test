import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForServerReady } from '../../app/tests/helpers/server-ready.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'agentglim-install-'));
const origin = path.join(scratch, 'origin.git');

function run(cwd, env, command, ...args) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 90_000 }).trim();
}

function installation(name) {
  const home = path.join(scratch, name);
  const data = path.join(home, 'data');
  const plans = path.join(home, 'plans');
  const temp = path.join(home, 'tmp');
  for (const folder of [data, plans, temp]) fs.mkdirSync(folder, { recursive: true });
  const env = {
    PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', CI: 'true',
    HOME: home, USERPROFILE: home, TMPDIR: temp, GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    AGENTGLIM_DATA: data, AGENTGLIM_PLANS: plans, AGENTGLIM_RUN: path.join(plans, '_run'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_ENV_FILE: path.join(home, '.env'),
    AGENTGLIM_NO_UPDATE_CHECK: '1',
  };
  const repo = path.join(home, 'agentglim');
  run(home, env, 'git', 'clone', '--quiet', '--no-hardlinks', '--branch', 'main', origin, repo);
  return { repo, env, data };
}

async function checkDashboard({ repo, env, data }, newInstall) {
  const server = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(server, 'close');
  try {
    const port = await waitForServerReady(server);
    server.stdout.resume();
    server.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    async function request(route, body) {
      const headers = { connection: 'close' };
      const options = { headers, signal: AbortSignal.timeout(25_000) };
      if (body !== undefined) {
        Object.assign(headers, { origin: base, 'content-type': 'application/json' });
        Object.assign(options, { method: 'POST', body: JSON.stringify(body) });
      }
      const response = await fetch(base + route, options);
      assert.equal(response.status, 200, `${route}: ${response.status}`);
      return response;
    }
    assert.match(await (await request('/')).text(), /<title>[^<]*AgentGlim/i);
    const { config } = await (await request('/api/setup')).json();
    if (newInstall) {
      assert.equal(config.firstRun, true);
      await (await request('/api/setup', { ...config, budget: { apiDailyUsd: 3 } })).json();
      console.log(run(repo, env, 'npm', 'run', 'scaffold-harness'));
    }
    const { config: saved } = await (await request('/api/setup')).json();
    assert.equal(saved.setupComplete, true);
    assert.equal(saved.budget.apiDailyUsd, 3);

    const { ask } = await (await request('/api/status-refresh', {})).json();
    assert.ok(ask && !ask.answeredAt);
    console.log(run(repo, env, process.execPath, path.join(env.AGENTGLIM_RUN, 'bin/status-write.mjs'),
      '--done', 'release smoke', '--running', 'watching plans', '--blocked', 'none', '--next', 'continue'));
    const reply = JSON.parse(fs.readFileSync(path.join(data, 'status.json'), 'utf8'));
    assert.equal(reply.lines.done, 'release smoke');
    assert.equal(reply.source, 'asked');
    assert.ok((await (await request('/api/status-ask')).json()).ask.answeredAt);
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await closed;
  }
}

const git = (...args) => run(source, process.env, 'git', ...args);
const candidate = git('rev-parse', 'HEAD');
assert.equal(candidate, process.env.GITHUB_SHA || candidate);
const parent = git('rev-parse', `${candidate}^`);
let previous = parent;
try {
  previous = git('describe', '--first-parent', '--tags', '--abbrev=0', '--match', 'v[0-9]*', parent);
} catch (error) {
  // The shared CI test repository may not carry release tags.
  if (!/No names found|No tags can describe/.test(error.stderr || '')) throw error;
}
const previousCommit = git('rev-parse', `${previous}^{commit}`);
console.log(`Install/update smoke in ${scratch}: ${previous} (${previousCommit}) -> ${candidate}`);
git('clone', '--quiet', '--bare', '--no-hardlinks', source, origin);
git('--git-dir', origin, 'update-ref', 'refs/heads/main', candidate);

const fresh = installation('fresh');
assert.equal(run(fresh.repo, fresh.env, 'git', 'rev-parse', 'HEAD'), candidate);
await checkDashboard(fresh, true);
console.log('PASS fresh install, setup and Refresh');

git('--git-dir', origin, 'update-ref', 'refs/heads/main', previousCommit);
const existing = installation('previous');
await checkDashboard(existing, true);
const sentinel = path.join(existing.data, 'preserve.txt');
fs.writeFileSync(sentinel, 'keep this user data\n');
const before = fs.readdirSync(existing.data, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && !/-wal$|-shm$/.test(entry.name))
  .map(entry => path.join(entry.parentPath, entry.name));

git('--git-dir', origin, 'update-ref', 'refs/heads/main', candidate);
console.log(run(existing.repo, existing.env, 'npm', 'run', 'update'));
assert.equal(run(existing.repo, existing.env, 'git', 'rev-parse', 'HEAD'), candidate);
await checkDashboard(existing, false);
assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep this user data\n');
for (const file of before) assert.ok(fs.existsSync(file), `Missing after update: ${file}`);
console.log('PASS in-place update, restart, Refresh and data preservation');
