import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { archiveDirectory } from './helpers/archive-directory.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = new URL('../server.mjs', import.meta.url).href;
async function fixturePort() {
  for (let port = 19360; port < 19379; port += 2) {
    const reserved = [];
    try {
      for (const value of [port, port + 1]) {
        const socket = net.createServer();
        await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(value, '127.0.0.1', resolve); });
        reserved.push(socket);
      }
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(reserved.map(socket => new Promise(resolve => socket.close(resolve))));
    }
  }
  throw Error('No fixture port pair available in 19360-19379');
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-native-paths-'));
  const write = (relative, data) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    return file;
  };
  write('env', '');
  write('harness.json', '{}');
  write('data/setup.json', '{}');
  write('data/integrations.json', '{}');
  fs.mkdirSync(path.join(home, 'proc'), { recursive: true });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    await archiveDirectory(home);
  });
  const start = async (code, { profileOnly = false, procFixture = true } = {}) => {
    const port = await fixturePort();
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw Error('unexpected outbound fetch'); };
      ${code}
      process.argv[2] = ${JSON.stringify(String(port))};
      await import(${JSON.stringify(SERVER)});
    `], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        ...(profileOnly ? {} : { HOME: home }), USERPROFILE: home,
        AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
        AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'),
        AGENTGLIM_PROJECTS: home, ...(procFixture ? { AGENTGLIM_PROC: path.join(home, 'proc') } : {}), AGENTGLIM_DEV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    const bound = await waitForServerReady(child, port);
    const readSnapshot = async () => {
      const response = await fetch(`http://127.0.0.1:${bound}/api/snapshot`);
      assert.equal(response.status, 200);
      return response.json();
    };
    return { snapshot: await readSnapshot(), readSnapshot, output: () => output };
  };
  return { home, write, start };
}

test('USERPROFILE-only startup opens Claude, Codex and OpenCode fixture storage', async t => {
  const { home, write, start } = fixture(t);
  write('plans/77-fixture/PLAN.md', '# Fixture\n');
  const claude = write('.claude/projects/fixture/session.jsonl', '{"type":"user","message":{"content":"fixture"}}\n');
  const today = new Date();
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('/');
  const codex = write(`.codex/sessions/${date}/rollout.jsonl`, '{"type":"session_meta","payload":{"cwd":"fixture"}}\n');
  const opencode = write('.local/share/opencode/opencode.db', '');
  const db = new DatabaseSync(opencode);
  try {
    db.exec('create table session (id text, directory text); create table message (session_id text, time_created integer, data text);');
    db.prepare('insert into session values (?, ?)').run('fixture', path.join(home, 'plans') + '/77-fixture');
    db.prepare('insert into message values (?, ?, ?)').run('fixture', Date.now(), JSON.stringify({
      role: 'assistant', modelID: 'fixture-model', tokens: { input: 11, output: 3 }, cost: 0,
    }));
  }
  finally { db.close(); }
  const watched = [claude, codex, opencode];
  const { snapshot, output } = await start(`
    assert.equal(process.env.HOME, undefined);
    assert.equal(process.env.USERPROFILE, ${JSON.stringify(home)});
    // Linux/macOS homedir otherwise uses HOME/passwd. Emulate Windows' documented
    // USERPROFILE choice there; native Windows exercises the real os.homedir().
    if (process.platform !== 'win32') os.homedir = () => process.env.USERPROFILE;
    assert.equal(os.homedir(), process.env.USERPROFILE);
    const watched = new Set(${JSON.stringify(watched)}.map(file => path.normalize(file)));
    for (const method of ['openSync', 'existsSync']) {
      const original = fs[method];
      fs[method] = function(file, ...args) {
        const result = original.call(this, file, ...args);
        if (watched.has(path.normalize(String(file)))) console.log('FIXTURE_READ ' + JSON.stringify(path.normalize(String(file))));
        return result;
      };
    }
  `, { profileOnly: true });
  const reads = new Set(output().split('\n').filter(line => line.startsWith('FIXTURE_READ ')).map(line => JSON.parse(line.slice(13))));
  for (const file of watched) assert.ok(reads.has(path.normalize(file)), `startup must discover ${path.relative(home, file)}`);
  assert.equal(snapshot.value.saved.free.tokens, 14, 'the startup scanner reads OpenCode usage from the profile database');
});

test('native-separator _build scan attributes worker metadata and totals to its plan', async t => {
  const { write, start } = fixture(t);
  write('plans/77-fixture/PLAN.md', '# Fixture\n');
  write('plans/_run/state.json', { projects: { '77-fixture': { stage: 'v1-r1', stages: [] } } });
  const dir = 'plans/77-fixture/_build/v1-r1/workers/01-storage/slot1';
  const stamp = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
  write(`${dir}/meta`, `${stamp} start kind=codex-only\n${stamp} end kind=codex-only rc=0\n`);
  write(`${dir}/rc`, '0\n');
  write(`${dir}/events.jsonl`, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 5 } }) + '\n');
  write('plans/77-fixture/_build/v1-r1/tasks/01-storage.md', '# Storage\n');
  const { snapshot } = await start(`
    // Read actual files on this OS, but make the scanner receive native Windows
    // path.relative output even on Linux CI. No string-only roleOf imitation.
    path.relative = path.win32.relative;
    assert.ok(path.relative('C:/plans', 'C:/plans/77-fixture/_build/v1-r1').includes(String.fromCharCode(92)));
  `);
  const worker = snapshot.agents.find(job => job.project === '77-fixture');
  assert.ok(worker, 'scanned _build metadata must be attributed to the plan');
  assert.equal(worker.role, 'worker');
  assert.equal(worker.step, 'v1-r1');
  assert.equal(worker.task, '01-storage');
  assert.equal(worker.slot, 'slot1');
  assert.equal(worker.tokens.input, 17);
  assert.equal(worker.tokens.output, 5);
  const plan = snapshot.projects.find(project => project.dir === '77-fixture');
  assert.equal(plan.tokens, 22, 'worker totals belong to its plan row');
  assert.equal(plan.tasks[0].model, worker.model, 'task rows match the worker by stage and task');
});

test('Windows startup and HTTP serve tracked PIDs while the single identity batch is pending', async t => {
  const { home, write, start } = fixture(t);
  const starttime = '134394998952533759', pids = [4242, 4343, 4444];
  for (const pid of pids) {
    write(`data/tracked-jobs/fixture-${pid}.json`, {
      id: `fixture-${pid}`, project: 'fixture', pid, pidStart: starttime,
      kind: 'one-on-one', status: 'running', started: Date.now(),
    });
  }
  const releaseFile = path.join(home, 'release-probe');
  const { snapshot, readSnapshot, output } = await start(`
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { default: cp } = await import('node:child_process');
    const { syncBuiltinESMExports } = await import('node:module');
    const { execFile, execFileSync } = cp;
    cp.execFileSync = (command, ...args) => {
      if (command === 'powershell.exe') {
        console.log('SYNC_POWERSHELL');
        throw Error('unexpected synchronous Windows monitoring');
      }
      return execFileSync(command, ...args);
    };
    cp.execFile = (command, args, options, done) => {
      if (command !== 'powershell.exe') return execFile(command, args, options, done);
      if (!args.at(-1).includes('GetProcesses()')) { queueMicrotask(() => done(null, '[]')); return; }
      console.log('IDENTITY_BATCH');
      const retry = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
        clearInterval(retry);
        done(null, ${JSON.stringify(pids.map(pid => pid + ' ' + starttime).join('\n'))});
      }, 10);
    };
    syncBuiltinESMExports();
  `, { procFixture: false });

  assert.equal(snapshot.population.counts.live, 0);
  assert.equal(snapshot.population.counts.unknown, pids.length);
  assert.equal((await readSnapshot()).population.counts.unknown, pids.length);
  assert.equal(output().match(/IDENTITY_BATCH/g)?.length, 1);

  write('release-probe', '');
  const deadline = Date.now() + 5000;
  let counts;
  do {
    counts = (await readSnapshot()).population.counts;
    if (counts.live === pids.length) break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(counts.live, pids.length);
  assert.equal(counts.unknown, 0);
  assert.equal(output().match(/IDENTITY_BATCH/g)?.length, 1);
  assert.doesNotMatch(output(), /SYNC_POWERSHELL/);
});
