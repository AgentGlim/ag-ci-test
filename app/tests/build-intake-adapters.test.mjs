import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeBuildAdapters, buildDispatchCommand, workerLiveness, DISPATCH_FIELDS } from '../build-intake/adapters.mjs';
import { checkCoverage } from '../build-intake/registry.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bia-'));
  t.after(() => { fs.mkdirSync(path.join(os.tmpdir(), '_archive'), { recursive: true }); fs.renameSync(root, path.join(os.tmpdir(), '_archive', path.basename(root))); });
  const run = path.join(root, 'run'); fs.mkdirSync(path.join(run, 'bin'), { recursive: true });
  for (const f of ['agent.sh', 'budget.mjs', 'jev-route.mjs', 'jev-gate']) fs.writeFileSync(path.join(run, 'bin', f), 'fixture');
  const build = { id: 'b-demo', source: { repository: '/repo', specPath: '/repo/BUILD.md' }, defaults: { values: { timeoutSeconds: 100, subscriptionOnly: true, repairLimit: 3 } },
    answers: { identity: { name: 'Demo', type: 'feature', parent: '01-demo' }, tier: 'T4', deadline: null, roles: { worker: { pick: 'codex-terra', effort: 'high', chooser: 'Jev' }, auditor: { pick: 'claude-sonnet', effort: 'high' }, repair: { pick: 'codex-terra', effort: 'high' } }, tests: ['node --test'] }, config: { fields: {} } };
  return { root, run, build, intent: { id: 'attempt-1', plan: '01-demo', outdir: path.join(root, 'out'), promptFile: path.join(root, 'out', 'prompt.md'), configFile: path.join(root, 'out', 'config.json'), build } };
}
test('canonical dispatch command is tracked agent.sh only, bounded subscription route, no shell interpolation', (t) => {
  const f = fixture(t), c = buildDispatchCommand(f.intent, { runDir: f.run, env: { PATH: '/bin', SENTINEL: 'kept' } });
  assert.equal(c.bin, 'bash'); assert.equal(c.args[0], path.join(f.run, 'bin', 'agent.sh'));
  assert.deepEqual(c.args.slice(1), ['codex-only', '/repo', f.intent.promptFile, f.intent.outdir, '100', 'high', '--plan', '01-demo']);
  assert.equal(c.env.AGENT_SUBSCRIPTION_ONLY, '1'); assert.equal(c.env.CODEX_MODEL_OVERRIDE, 'gpt-6.1-terra');
  assert.equal(c.env.AGENT_ATTEMPT_ID, 'attempt-1'); assert.equal(c.env.AGENT_AUTO_ANSWER, '0');
  assert.equal(c.env.SENTINEL, 'kept'); assert.equal(c.shell, false); assert.ok(checkCoverage(DISPATCH_FIELDS));
});
test('admission checks all role gates; held roles and missing canonical dispatcher refuse', async (t) => {
  const f = fixture(t), calls = [];
  const a = makeBuildAdapters({ dataDir: f.root, runDir: f.run, exec: async (bin, argv) => { calls.push([bin, argv]); return { stdout: '', code: argv.includes('audit') ? 1 : 0 }; } });
  const r = await a.admit(f.build); assert.equal(r.ok, false); assert.match(r.reason, /auditor/);
  assert.ok(calls.some(x => x[1].includes('worker'))); assert.ok(calls.some(x => x[1].includes('audit')));
  const missing = makeBuildAdapters({ dataDir: f.root, runDir: '/missing', exec: async () => { throw new Error('must not execute'); } });
  assert.equal((await missing.admit(f.build)).ok, false);
});
test('route preserves fallback provenance; dispatch requires fresh Jev evidence and returns no invented receipt', async (t) => {
  const f = fixture(t), calls = [];
  const a = makeBuildAdapters({ dataDir: f.root, runDir: f.run, exec: async (bin, args) => {
    calls.push(args);
    if (args[0].endsWith('jev-route.mjs')) return { code: 1, stdout: JSON.stringify({ error: 'Jev down', pick: 'claude-sonnet', effort: 'medium' }) };
    return { code: 2, stdout: 'Jev picked codex-sol (p=1), effort high.' };
  }, spawnDetached: () => { throw new Error('must not spawn changed route'); } });
  const rec = await a.route('worker', { recommendations: { identity: { name: 'Demo' } } });
  assert.equal(rec.chooser, 'fallback'); assert.equal(rec.pick, 'claude-sonnet');
  await assert.rejects(a.dispatch(f.intent), /Jev.*changed|fresh.*Jev/i);
  assert.equal(calls.length, 2);
});
test('F31 seam never promotes tracked status or a reused PID heartbeat to live execution', () => {
  const result = workerLiveness({ tracked: [{ id: 'unknown', status: 'running', pid: 123, pidStart: '456', heartbeat: 5000 }] }, { now: 5000, isLive: () => false });
  assert.equal(result.available, true); assert.equal(result.counts.live, 0); assert.equal(result.counts.unknown, 1);
});

test('successful dispatch carries the exact pinned roles and final Jev tag, with no synthesized job receipt', async (t) => {
  const f = fixture(t); let spawned;
  const a = makeBuildAdapters({ dataDir: f.root, runDir: f.run, exec: async () => ({ code: 2, stdout: 'Jev picked codex-terra (p=1), effort high.' }), spawnDetached: async (c) => { spawned = c; return { state: 'registration pending' }; } });
  const r = await a.dispatch(f.intent);
  assert.equal(r.jobId, undefined); assert.equal(spawned.env.CODEX_MODEL_OVERRIDE, 'gpt-6.1-terra');
  const prompt = fs.readFileSync(f.intent.promptFile, 'utf8');
  assert.match(prompt, /\[plan: 01-demo\]\n\[jev: codex-terra high\]\n$/);
  assert.match(prompt, /Independent audit/); assert.ok(!spawned.args.includes('--no-track'));
});

test('F36 adapters import and read job state in a minimal installation with no F31 modules', async (t) => {
  const f = fixture(t), app = path.join(f.root, 'minimal', 'app'), target = path.join(app, 'build-intake');
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['adapters.mjs', 'durable.mjs', 'registry.mjs']) fs.copyFileSync(new URL(`../build-intake/${file}`, import.meta.url), path.join(target, file));
  fs.copyFileSync(new URL('../paths.mjs', import.meta.url), path.join(app, 'paths.mjs'));
  const module = await import(pathToFileURL(path.join(target, 'adapters.mjs')).href);
  const jobs = path.join(f.root, 'tracked-jobs'); fs.mkdirSync(jobs); fs.mkdirSync(path.join(jobs, '_archive'));
  fs.writeFileSync(path.join(jobs, '_archive', 'same.json'), JSON.stringify({ id: 'same', status: 'running' }));
  fs.writeFileSync(path.join(jobs, 'same.json'), JSON.stringify({ id: 'same', status: 'done', rc: 0 }));
  assert.deepEqual(module.makeBuildAdapters({ dataDir: f.root, runDir: f.run }).jobs(), [{ id: 'same', status: 'done', rc: 0 }]);
  assert.ok(!fs.existsSync(path.join(app, 'live-workers.mjs')));
  assert.deepEqual(module.workerLiveness(), { available: false, state: 'unverified', reason: 'F31 live-worker authority unavailable' });
});


test('production adapter binds F31 evidence to receipt IDs and verified lineage, never output paths', (t) => {
  const f = fixture(t), dir = path.join(f.root, 'tracked-jobs'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, '_archive'));
  const wrapper = { id: 'wrapper', launcher: 'agent.sh', status: 'running', pid: 90001, pidStart: '1', dispatchVerified: true, dispatchGeneration: 'one' };
  const take = { ...wrapper, id: 'take', launcher: 'headless-take.sh', pid: 90002, pidStart: '2' };
  const foreign = { ...take, id: 'foreign', dispatchGeneration: 'two', pid: 90003, outdir: '/same' };
  for (const j of [wrapper, take, foreign]) fs.writeFileSync(path.join(dir, j.id + '.json'), JSON.stringify(j));
  // The current receipt record supersedes its archived running copy.
  fs.writeFileSync(path.join(dir, '_archive', 'wrapper.json'), JSON.stringify({ ...wrapper, pidStart: '99' }));
  const adapters = makeBuildAdapters({ dataDir: f.root, runDir: f.run });
  const result = adapters.workerLiveness({ receipts: [{ jobId: 'wrapper' }] }, { now: 5000, isLive: () => true, ancestryOf: () => new Map() });
  assert.equal(result.counts.live, 1); assert.deepEqual(result.workers[0].rawIds, ['take', 'wrapper']);
  assert.equal(adapters.workerLiveness({ receipts: [] }).available, false);
  assert.equal(adapters.workerLiveness({ receipts: [{ jobId: 'wrapper', pid: 90001, pidStart: '99' }] }).available, false);
  const proc = path.join(f.root, 'proc'), prior = process.env.AGENTGLIM_PROC;
  for (const [pid, start] of [[90001, '1'], [90002, '2']]) {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = start;
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (fixture) ${fields.join(' ')}`);
  }
  process.env.AGENTGLIM_PROC = proc;
  try {
    const receipt = { receipts: [{ jobId: 'wrapper', pid: 90001, pidStart: '1' }] };
    assert.equal(adapters.workerLiveness(receipt).counts.live, 1);
    for (const pid of [90001, 90002]) {
      const stat = path.join(proc, String(pid), 'stat');
      const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = '99';
      fs.writeFileSync(stat, `${pid} (reused) ${fields.join(' ')}`);
    }
    assert.equal(adapters.workerLiveness(receipt).counts.live, 0);
    assert.equal(adapters.workerLiveness(receipt).counts.unknown, 1);
  } finally { if (prior === undefined) delete process.env.AGENTGLIM_PROC; else process.env.AGENTGLIM_PROC = prior; }
  fs.writeFileSync(path.join(dir, 'take.json'), JSON.stringify({ ...take, status: 'done', rc: 0 }));
  fs.writeFileSync(path.join(dir, 'wrapper.json'), JSON.stringify({ ...wrapper, status: 'done', rc: 0 }));
  assert.equal(adapters.workerLiveness({ receipts: [{ jobId: 'wrapper' }] }).counts.live, 0);
  assert.equal(adapters.workerLiveness({ receipts: [{ jobId: 'wrapper' }] }).counts.history, 2);
});


test('missing shared failure classifier stays unavailable instead of reporting zero failures', async (t) => {
  const f = fixture(t), { spawnSync } = await import('node:child_process');
  const code = `import assert from 'node:assert/strict';
    import {workerLiveness} from ${JSON.stringify(new URL('../build-intake/adapters.mjs', import.meta.url).href)};
    const r=workerLiveness({tracked:[{id:'timeout',status:'failed',rc:124}]});
    assert.equal(r.available,true);assert.equal(r.counts.history,1);
    assert.equal(r.failures.available,false);assert.equal(r.failures.count,null);assert.equal(r.failures.byCause,null);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: f.root, USERPROFILE: f.root,
      F31_FAILURE_CAUSE_MODULE: path.join(f.root, 'absent-classifier.mjs') } });
  assert.equal(r.status, 0, r.stderr);
});
