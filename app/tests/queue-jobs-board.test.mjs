import { waitForServerReady } from './helpers/server-ready.mjs';
// Regression (owner 2026-11-12): a headless-take queue job must show under its plan with the plan's driver stage and the
// job's model, the plan must be in Active builds while it is in a live driver stage, and observatory__* jobs belong to the
// SuperAgent row (they sat under "Unassigned" while plan 68 showed "done" in v10-focus and 66 was missing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { RUN } from '../paths.mjs';

const APP = path.resolve(import.meta.dirname, '..');
const JT = path.resolve(APP, '../tools/addons/jobs-track.py');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// jobs-audit.mjs lives in the plans harness, not in this repo: prefer this repo's own copy (harness/bin) so the test pins a
// copy that ships with the code, else use the installed run folder. Neither exists under release.sh's isolated HOME
// (env -i, fresh HOME, no ~/.agentglim), so the test below is skipped there with a reason instead of failing on a file
// this repo does not own.
const AUDIT = [path.join(APP, '../harness/bin/jobs-audit.mjs'), path.join(RUN, 'bin', 'jobs-audit.mjs')].find((f) => fs.existsSync(f)) || path.join(RUN, 'bin', 'jobs-audit.mjs');

test('headless-take jobs: NN-slug__stage under its plan with stage + model; observatory__* under SuperAgent', { skip: !fs.existsSync(JT) && 'jobs-track.py not installed' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-queue-jobs-'));
  const write = (file, content) => { const f = path.join(home, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  write('env', ''); write('harness.json', '{}'); write('data/setup.json', {}); write('data/integrations.json', {});
  for (const d of ['66-fake-bench', '67-fake-done', '69-fake-held']) write(`plans/${d}/PLAN.md`, `# ${d}\n`);
  write('plans/69-fake-held/HOLD', 'held\n');
  write('plans/_run/state.json', { projects: { '66-fake-bench': { stage: 'v15-r1', stages: [] }, '67-fake-done': { stage: 'done', stages: [] }, '69-fake-held': { stage: 'v1-r1', stages: [] } } });
  write('plans/_run/driver.log', '');
  // two fake headless-take jobs, registered the way headless-take.sh does it (live pids so they count as running)
  const env = { ...process.env, JOBS_TRACK_DIR: path.join(home, 'data', 'tracked-jobs'), AGENTGLIM_PLANS: path.join(home, 'plans') };
  const s1 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']), s2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.after(async () => {
    for (const p of [s1, s2]) {
      if (p.exitCode === null && p.signalCode === null) {
        const exited = once(p, 'exit'); p.kill(); await exited;
      }
    }
  });
  const reg = (pid, req, model, cwd, out) => execFileSync(PYTHON, [JT, 'start', '--harness', 'claude', '--model', model, '--cwd', cwd, '--outdir', out, '--pid', String(pid),
    '--req', req, '--prompt', 'see 67-fake-done for context', '--kind', 'queue', '--launcher', 'headless-take.sh'], { env, encoding: 'utf8' }).trim();
  const planJob = reg(s1.pid, path.join(home, 'plans/_run/audit_queue/66-fake-bench__v15-r1-audit.req'), 'claude-fable-5-1', path.join(home, 'plans/66-fake-bench'), path.join(home, 'plans/66-fake-bench/_build/v15-r1/audit'));
  const saJob = reg(s2.pid, path.join(home, 'plans/_run/audit_queue/observatory__reject-x_-abc123.req'), 'claude-sonnet-5-5', path.join(home, 'plans/_observatory'), path.join(home, 'plans/_observatory/_build/reject-x_-abc123'));
  // This test pins board placement/counts, independent of host PowerShell latency.
  // Native pending/completed identity evidence is covered by windows-startup.test.mjs.
  for (const id of [planJob, saJob]) {
    const record = path.join(env.JOBS_TRACK_DIR, `${id}.json`);
    const job = JSON.parse(fs.readFileSync(record, 'utf8'));
    job.pidStart = 777;
    fs.writeFileSync(record, JSON.stringify(job));
    const fields = Array(50).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = '777';
    write(`proc/${job.pid}/stat`, `${job.pid} (node) ${fields.join(' ')}`);
  }
  const child = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: path.resolve(APP, '..'), env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'), JOBS_TRACK_DIR: env.JOBS_TRACK_DIR, AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_PROC: path.join(home, 'proc'), AGENTGLIM_DEV: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (x) => { errors += x; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await waitForServerReady(child);
  const s = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  assert.ok(s?.projects, `isolated server gave no snapshot: ${errors}`);
  const p66 = s.projects.find((p) => p.dir === '66-fake-bench');
  assert.ok(p66.liveBuild, 'a plan in a live driver stage is an Active builds row');
  assert.equal(p66.liveBuild.stage, 'v15-r1');
  assert.ok(p66.liveBuild.models.includes('claude-fable-5-1'), `running model shown: ${p66.liveBuild.models}`);
  const j = p66.tracked.find((x) => x.id === planJob);
  assert.ok(j, 'the queue job is a sub-task of its plan'); assert.equal(j.model, 'claude-fable-5-1'); assert.equal(j.label, 'V15 r1 audit'); assert.equal(j.status, 'running');
  assert.equal(s.projects.find((p) => p.dir === '67-fake-done').liveBuild, null, 'a done plan without a live job is not live (the prompt naming it does not count)');
  assert.equal(s.projects.find((p) => p.dir === '69-fake-held').liveBuild, null, 'a held plan with no live job is not live');
  assert.ok((s.watcherRow.tracked || []).some((x) => x.id === saJob), 'observatory__* job is on the SuperAgent row');
  // 2026-11-13 agent-icons fix: the SuperAgent row counts only its own takes; the plan's take is drawn on the plan row only
  assert.ok(s.watcherRow.headlessRunning === 1 && s.watcherRow.running === 1, `SuperAgent counts only its own headless take: ${JSON.stringify(s.watcherRow)}`);
  assert.ok(!(s.otherRows || []).some((o) => (o.tracked || []).some((x) => x.id === saJob)), 'and not under Unassigned or any other row');
});

test('jobs-audit flags the 2026-11-12 bug (plan missing from Active builds, Unassigned queue job, model, SuperAgent count) and passes the fix', { skip: !fs.existsSync(AUDIT) && 'harness jobs-audit.mjs not installed' }, async () => {
  const { audit } = await import(AUDIT);
  const ps = [{ pid: 10, ppid: 1, tty: 0, ageS: 600, cmd: ['bash', '_run/bin/headless-take.sh', '_run/audit_queue/observatory__reject-x.req'] },
    { pid: 11, ppid: 10, tty: 0, ageS: 600, cmd: ['claude', '-p', '--model', 'claude-sonnet-5-5'] },
    { pid: 20, ppid: 1, tty: 0, ageS: 600, cmd: ['bash', '_run/bin/headless-take.sh', '_run/audit_queue/68-x-app__v10-focus.req'] },
    { pid: 21, ppid: 20, tty: 0, ageS: 600, cmd: ['claude', '-p', '--model', 'claude-fable-5-1'] },
    // 2026-11-13 (agent-icons fix): the SuperAgent row counts only its own takes, so the count rule needs one registered
    // under "SuperAgent"; the 2026-11-12 shape above (a take filed under Unassigned) is covered by the unattributed check.
    { pid: 30, ppid: 1, tty: 0, ageS: 600, cmd: ['bash', '_run/bin/headless-take.sh', '_run/audit_queue/observatory__reject-y.req'] },
    { pid: 31, ppid: 30, tty: 0, ageS: 600, cmd: ['claude', '-p', '--model', 'claude-sonnet-5-5'] }];
  const state = { projects: { '68-x-app': { stage: 'v10-focus' } } };
  const before = await audit({ ps, state, plansDir: '/nonexistent', recs: [
    { id: 'a', status: 'running', pid: 10, project: 'Unassigned', isPlan: false, label: 'Reject x', model: 'claude-sonnet-5-5' },
    { id: 'b', status: 'running', pid: 20, project: '68-x-app', isPlan: true, label: 'V10 focus', model: 'claude-opus-5-5' },
    { id: 'c', status: 'running', pid: 30, project: 'SuperAgent', isPlan: false, label: 'Reject y', model: 'claude-sonnet-5-5' }],
  snap: { projects: [{ dir: '68-x-app', stage: 'done', endState: 'auto-complete', tracked: [{ id: 'b', model: 'claude-opus-5-5' }] }], otherRows: [{ dir: 'Unassigned', tracked: [{ id: 'a' }] }], watcherRow: { running: 0 } } });
  const has = (re) => before.problems.some((x) => re.test(x));
  assert.ok(has(/unattributed live job.*Unassigned/), before.problems.join('\n'));
  assert.ok(has(/68-x-app is live .* missing from Active builds/));
  assert.ok(has(/68-x-app is in driver stage v10-focus but shown as auto-complete/));
  assert.ok(has(/model mismatch.*claude-fable-5-1.*claude-opus-5-5/));
  assert.ok(has(/SuperAgent row counts 0 headless/));
  const after = await audit({ ps, state, plansDir: '/nonexistent', recs: [
    { id: 'a', status: 'running', pid: 10, project: 'SuperAgent', isPlan: false, label: 'Reject x', model: 'claude-sonnet-5-5' },
    { id: 'b', status: 'running', pid: 20, project: '68-x-app', isPlan: true, label: 'V10 focus', model: 'claude-fable-5-1' },
    { id: 'c', status: 'running', pid: 30, project: 'SuperAgent', isPlan: false, label: 'Reject y', model: 'claude-sonnet-5-5' }],
  snap: { projects: [{ dir: '68-x-app', stage: 'v10-focus', liveBuild: { stage: 'v10-focus', models: ['claude-fable-5-1'] }, tracked: [{ id: 'b', model: 'claude-fable-5-1' }] }],
    otherRows: [], watcherRow: { running: 2, headlessRunning: 2, tracked: [{ id: 'a', model: 'claude-sonnet-5-5' }, { id: 'c', model: 'claude-sonnet-5-5' }] } } });
  assert.deepEqual(after.problems, []);
});
