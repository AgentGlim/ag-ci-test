import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForServerReady } from './helpers/server-ready.mjs';

// Exercise the real Windows production branch on every OS, with PowerShell held
// open indefinitely. No Windows tools, real process enumeration or fake procfs.
test('Windows server starts and serves unknown workers while identity queries hang, then confirms F31 counts', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-windows-startup-'));
  const write = (rel, value) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('env', ''); write('harness.json', '{}'); write('data/setup.json', {});
  for (let pid = 42; pid < 48; pid++) write(`data/tracked-jobs/job-${pid}.json`, {
    id: `job-${pid}`, pid, pidStart: '134077761690000001', project: 'SuperAgent',
    kind: 'queue', harness: 'claude', launcher: 'headless-take.sh', label: `Fixture ${pid}`,
    status: 'running', started: Date.now(),
  });
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const exec = cp.execFile, sync = cp.execFileSync, waiting = [];
    let released = false;
    cp.execFileSync = (cmd, ...args) => {
      if (cmd === 'powershell.exe') {
        console.error('synchronous PowerShell identity lookup');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
        throw Error('identity must be asynchronous');
      }
      return sync(cmd, ...args);
    };
    cp.execFile = (cmd, args, options, done) => {
      if (cmd !== 'powershell.exe') return exec(cmd, args, options, done);
      const pid = /Get-Process -Id (\\d+)/.exec(args.at(-1))?.[1];
      if (!pid) { queueMicrotask(() => done(null, '[]')); return; }
      console.log('pending identity ' + pid);
      const complete = () => done(null, JSON.stringify({ pid: +pid,
        start: '134077761690000001', executable: 'C:/node.exe' }));
      if (released) queueMicrotask(complete); else waiting.push(complete);
      return { kill() {} };
    };
    syncBuiltinESMExports();
    process.on('message', () => { released = true; waiting.splice(0).forEach(fn => fn()); });
    process.argv[2] = '0';
    await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});
  `], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'),
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
      AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', errors = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
    const archive = path.join(os.tmpdir(), '_archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(home, path.join(archive, path.basename(home)));
  });
  const port = await waitForServerReady(server, 0, { timeoutMs: 10_000 });
  const snapshot = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  let snap = await snapshot();
  assert.match(output, /pending identity/);
  assert.doesNotMatch(errors, /synchronous PowerShell/);
  assert.equal((output.match(/pending identity/g) || []).length, 4, 'queries are capped, not multiplied by board readers');
  assert.equal(snap.population.counts.live, 0);
  assert.equal(snap.population.counts.unknown, 6, 'pending PID evidence remains unknown');
  assert.equal(snap.watcherRow.running, 0);
  assert.equal(snap.watcherRow.agentsUnknown.length, 6);
  server.send('release');
  const deadline = Date.now() + 10_000;
  while (snap.population.counts.live !== 6 && Date.now() < deadline) {
    await delay(50);
    snap = await snapshot();
  }
  assert.equal(snap.population.counts.live, 6, 'async completion refreshes the canonical board snapshot');
  assert.equal(snap.population.counts.unknown, 0);
  assert.equal(snap.watcherRow.running, 6);
  assert.equal(snap.watcherRow.agents.length, 6, 'card population and row icons use identical evidence');
});
