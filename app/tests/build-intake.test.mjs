import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBuildIntake } from '../build-intake/index.mjs';

const context = { session: 'SuperAgent', entry: 'chat' };
const pick = (role) => ({ pick: role === 'auditor' ? 'codex-sol' : 'claude-sonnet', effort: 'high', evidence: `jev-${role}` });
function world(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-intake-'));
  t.after(() => { const dest = path.join(os.tmpdir(), '_archive', path.basename(root)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(root, dest); });
  const jobs = [], starts = [], gates = [];
  const options = { dataDir: root, runDir: path.join(root, 'run'), route: async (role) => pick(role),
    admit: async (c) => { gates.push(c); return { ok: true, evidence: 'fixture provider/role gates' }; },
    jobs: () => jobs,
    dispatch: async (intent) => { starts.push(intent); jobs.push({ id: `job-${starts.length}`, outdir: intent.outdir, project: '01-demo', launcher: 'agent.sh', status: 'running', pid: 123, pidStart: '456', harness: 'claude', model: 'claude-sonnet-5-5' }); }, ...extra };
  const api = createBuildIntake(options); api.initializeDefaults();
  return { api, root, jobs, starts, gates, options };
}
const request = (key = 'one') => ({ requestKey: key, context, source: { repository: '/repo', featureDirectory: '/repo/feature', specPath: '/repo/BUILD.md', sourceRevision: 'abc123', parentItem: 'F1' },
  recommendations: { identity: { name: 'Demo build', type: 'feature', parent: '01-demo' }, priority: 'P2', tier: 'T4', deadline: null, tests: ['node --test'], dependencies: [] } });
async function ready(w, key) {
  let r = await w.api.begin(request(key));
  for (const g of r.rounds) r = w.api.answer(r.id, g.id, g.recommended, { by: 'owner', evidence: `answer-${g.id}` });
  return r;
}

test('D14/D16 setup recommendations, preview before edit, history, stale preview and pinned versions', async (t) => {
  const w = world(t), initial = w.api.defaults(), a = await ready(w);
  assert.equal(initial.version, 1);
  assert.throws(() => w.api.previewDefaults({ timeoutSeconds: 42 }, {}), /owner request/i);
  const p = w.api.previewDefaults({ timeoutSeconds: 42 }, { by: 'owner', evidence: 'set timeout to 42' });
  assert.match(p.diff, /timeoutSeconds.*3600.*42/s);
  assert.equal(w.api.defaults().version, 1);
  const next = w.api.applyDefaults(p.id, p.diffHash);
  assert.equal(next.version, 2); assert.equal(next.values.timeoutSeconds, 42);
  assert.equal(w.api.defaults(1).values.timeoutSeconds, 3600);
  assert.equal(w.api.get(a.id).defaultsVersion, 1);
  assert.throws(() => w.api.applyDefaults(p.id, p.diffHash), /stale|already/i);
  assert.throws(() => w.api.previewDefaults({ madeUp: true }, { by: 'owner', evidence: 'edit' }), /unknown/i);
  assert.throws(() => w.api.previewDefaults({ subscriptionOnly: false }, { by: 'owner', evidence: 'edit' }), /subscription/i);
});

test('D08/D15 seven rounds, visible recommendations, silence and prefills never count as answers', async (t) => {
  const w = world(t), r = await w.api.begin(request());
  assert.equal(r.rounds.length, 7); assert.equal(r.mode, 'ask'); assert.equal(r.missing.length, 7);
  await assert.rejects(w.api.launch(r.id), /answers.*identity.*priority.*tier.*roles.*deadline.*tests.*dependencies/i);
  assert.equal(w.starts.length, 0);
  assert.throws(() => w.api.answer(r.id, 'deadline', null, { by: 'system', evidence: 'silence' }), /owner/i);
  assert.throws(() => w.api.answer(r.id, 'identity', { name: 'X', type: 'task' }, { by: 'owner', evidence: 'partial' }), /parent/i);
  assert.throws(() => w.api.answer(r.id, 'tier', 'T9', { by: 'owner', evidence: 'bad' }), /tier/i);
  assert.throws(() => w.api.answer(r.id, 'dependencies', ['../escape'], { by: 'owner', evidence: 'bad' }), /dependencies/i);
  assert.throws(() => w.api.answer(r.id, 'tests', [], { by: 'owner', evidence: 'none' }), /tests/i);
});

test('D09 each role records Jev choice, explicit acceptance, override and Sonnet fallback', async (t) => {
  const w = world(t), r = await w.api.begin(request());
  assert.deepEqual(Object.keys(r.recommendations.roles).sort(), ['auditor', 'repair', 'worker']);
  const roles = { ...r.recommendations.roles, repair: { pick: 'codex-terra', effort: 'high' } };
  const a = w.api.answer(r.id, 'roles', roles, { by: 'owner', evidence: 'use these roles' });
  assert.equal(a.answers.roles.worker.chooser, 'Jev'); assert.equal(a.answers.roles.repair.chooser, 'owner');
  assert.equal(a.answers.roles.worker.acceptedBy, 'owner');
  const f = world(t, { route: async () => { throw new Error('down'); } });
  const fb = await f.api.begin(request());
  assert.equal(fb.recommendations.roles.worker.chooser, 'fallback');
  assert.equal(fb.recommendations.roles.worker.pick, 'claude-sonnet');
});

test('D05 concurrent duplicates dispatch once, receipts come from existing job state', async (t) => {
  const w = world(t), r = await ready(w);
  const [a, b] = await Promise.all([w.api.launch(r.id), w.api.launch(r.id)]);
  assert.equal(w.starts.length, 1); assert.equal(a.id, b.id);
  const end = w.api.get(r.id); assert.equal(end.receipts.length, 1); assert.equal(end.receipts[0].jobId, 'job-1');
  assert.equal(end.state, 'registered'); // registration is not F31 liveness
  assert.equal(end.config.fields['provider.worker'].verification, 'requested');
  assert.equal(end.config.fields['runtime.provider'].status, 'unavailable');
  assert.equal(end.config.fields['identity.parentItem'].effective, 'F1');
  const duplicate = await w.api.begin(request()); assert.equal(duplicate.id, r.id);
  await assert.rejects(w.api.begin({ ...request(), source: { ...request().source, parentItem: 'F2' } }), /idempotency/i);
});

test('D05 crash before dispatch recovers; after spawn/receipt loss reconciles without another worker', async (t) => {
  for (const stage of ['after-intent', 'after-spawn']) {
    let fail = true;
    const w = world(t, { fault: (at) => { if (fail && at === stage) { fail = false; throw new Error('simulated crash'); } } });
    const r = await ready(w, stage);
    await assert.rejects(w.api.launch(r.id), /simulated crash/);
    const recovered = createBuildIntake({ ...w.options, fault: undefined });
    const end = await recovered.launch(r.id);
    assert.equal(w.starts.length, 1); assert.equal(end.receipts.length, 1); assert.equal(end.defaultsVersion, 1);
  }
});

test('D05 uncertain dispatch and forged/foreign job evidence never cause blind relaunch', async (t) => {
  const w = world(t, { dispatch: async () => { throw new Error('transport lost'); } });
  const r = await ready(w);
  await assert.rejects(w.api.launch(r.id), /transport lost/);
  const end = await w.api.launch(r.id); assert.equal(end.state, 'uncertain');
  assert.equal(w.api.review().count, 0);
  w.jobs.push({ id: 'foreign', outdir: '/other', project: '01-demo', status: 'running', launcher: 'agent.sh' });
  assert.equal((await w.api.recover(r.id)).receipts.length, 0);
});

test('D06 setting changes and repeated answers after intent are refused without mutation', async (t) => {
  const w = world(t), r = await ready(w); await w.api.launch(r.id);
  const before = JSON.stringify(w.api.get(r.id));
  assert.throws(() => w.api.changeSettings(r.id, { priority: 'P1' }), /immutable|running/i);
  assert.throws(() => w.api.answer(r.id, 'priority', 'P1', { by: 'owner', evidence: 'change' }), /immutable/i);
  assert.equal(JSON.stringify(w.api.get(r.id)), before);
});

test('provider admission and dependencies fail closed before any dispatch', async (t) => {
  const w = world(t, { admit: async () => ({ ok: false, reason: 'provider held' }) });
  const r = await ready(w); await assert.rejects(w.api.launch(r.id), /provider held/); assert.equal(w.starts.length, 0);
  const v = world(t), a = await ready(v);
  v.api.answer(a.id, 'dependencies', ['not-ready'], { by: 'owner', evidence: 'dependency' });
  await assert.rejects(v.api.launch(a.id), /dependencies/i);
});

test('D12/D13 cards cover registry fields, stable JSON, safe Markdown and truthful failed/partial states', async (t) => {
  const w = world(t), r = await ready(w); await w.api.launch(r.id);
  const a = w.api.summary(r.id), b = w.api.summary(r.id);
  assert.equal(a.cards, b.cards); assert.deepEqual(a.json, b.json);
  for (const id of Object.keys(a.json.fields)) assert.ok(a.cards.includes(`\`${id}\``), id);
  assert.match(a.cards, /🪪|⚙️/u); assert.match(a.cards, /unavailable/); assert.match(a.cards, /registered/);
  assert.match(a.cards, /not verified|unverified/); assert.ok(a.receiptHashes.length);
  assert.throws(() => w.api.checkCoverage(['not-registered']), /not-registered/i);
  assert.equal(w.api.reply(r.id, { session: 'other', entry: 'chat' }, 'ordinary'), 'ordinary');
  assert.equal(w.api.reply(r.id, context, 'invented summary'), a.cards);
  const x = world(t), evil = request('escape'); evil.recommendations.identity.name = 'name | <img>\n# fake';
  const q = await x.api.begin(evil); assert.ok(!x.api.summary(q.id).cards.includes('<img>'));
});

test('D10/D17 tenth distinct receipt asks once durably; retries and review decisions never unlock', async (t) => {
  const w = world(t);
  for (let n = 0; n < 10; n++) { const r = await ready(w, `launch-${n}`); await w.api.launch(r.id); await w.api.launch(r.id); }
  const review = w.api.review(); assert.equal(review.count, 10); assert.equal(review.mode, 'ask');
  assert.match(review.request.question, /unlock recommended mode/i); assert.equal(review.request.groups.length, 7);
  const again = createBuildIntake(w.options).review(); assert.equal(again.request.id, review.request.id);
  w.api.recordReview({ by: 'owner', evidence: 'yes later', unlock: true });
  assert.equal(w.api.review().mode, 'ask'); assert.equal(w.api.review().request.decision.unlock, true);
});

test('v1 restricts entry and input schema and does not expose secret-shaped input', async (t) => {
  const w = world(t);
  await assert.rejects(w.api.begin({ ...request(), context: { session: 'other', entry: 'cli' } }), /SuperAgent.*chat/i);
  await assert.rejects(w.api.begin({ ...request(), source: { ...request().source, credential: 'private' } }), /unknown/i);
  await assert.rejects(w.api.begin({ ...request(), recommendations: { ...request().recommendations, extra: true } }), /unknown/i);
});

test('F31 verified worker liveness and PID reuse reconciliation', async (t) => {
  const { workerLiveness } = await import('../build-intake/adapters.mjs');
  const { livePopulation } = await import('../live-workers.mjs');
  const wrapper = { id: 'wrapper', launcher: 'agent.sh', status: 'running', pid: 90001, pidStart: '10', started: 1000,
    dispatchVerified: true, dispatchGeneration: 'one' };
  const take = { ...wrapper, id: 'take', launcher: 'headless-take.sh', pid: 90002, pidStart: '20', started: 2000 };
  const reused = { ...take, id: 'reused', pidStart: '99', heartbeat: 5000 };
  const unknown = { id: 'registered-only', status: 'running', pid: 90003 };
  const done = { ...wrapper, id: 'wrapper-rc0', rc: 0 };
  const inputs = { tracked: [wrapper, take, reused, unknown, done], harness: [take] };
  const options = { now: 5000, isLive: j => (j.pid === 90001 && j.pidStart === '10') || (j.pid === 90002 && j.pidStart === '20'), ancestryOf: () => new Map() };
  const before = JSON.stringify(inputs), actual = workerLiveness(inputs, options), canonical = livePopulation(inputs, options);
  assert.deepEqual(actual.counts, canonical.counts);
  assert.equal(actual.counts.live, 1); assert.equal(actual.counts.unknown, 2); assert.equal(actual.counts.history, 1);
  assert.deepEqual(actual.workers[0].rawIds, ['take', 'wrapper']);
  assert.equal(actual.workers[0].key, canonical.workers[0].key);
  assert.equal(JSON.stringify(inputs), before);
  const unverified = [wrapper, take].map(j => ({ ...j, dispatchVerified: false, req: 'reused-path', outdir: '/same' }));
  assert.equal(workerLiveness({ tracked: unverified }, options).counts.live, 2);
  assert.equal(workerLiveness({ tracked: [done] }, options).counts.live, 0);
  // Summaries carry the same observation without rewriting pinned settings or registration receipts.
  const w = world(t, { workerLiveness: () => actual }), r = await ready(w, 'f31-live');
  await w.api.launch(r.id);
  const pinned = JSON.stringify(w.api.get(r.id)), summary = w.api.summary(r.id);
  assert.equal(summary.json.fields['runtime.liveness'].effective.counts.live, 1);
  assert.equal(summary.json.fields['runtime.liveness'].verification, 'F31 evidence observed; audit and installation unverified');
  assert.equal(summary.json.fields['runtime.liveness'].observedAt, actual.observedAt);
  assert.equal(summary.json.fields['runtime.auditAcceptance'].status, 'pending');
  assert.equal(JSON.stringify(w.api.get(r.id)), pinned);
});
test('F31 repair failure counts and proven worker execution', async (t) => {
  // Default to the recorded shared authority in a fresh public checkout.
  const bins = process.env.F31_HARNESS_BIN || path.join(import.meta.dirname, 'fixtures/f31');
  process.env.F31_FAILURE_CAUSE_MODULE ||= path.join(bins, 'failure-cause.mjs');
  // The other acceptance test may have loaded an unavailable ledger already; use a fresh fixture process.
  const { spawnSync } = await import('node:child_process');
  const root = world(t).root;
  const code = `import assert from 'node:assert/strict';
    import {workerLiveness} from ${JSON.stringify(new URL('../build-intake/adapters.mjs', import.meta.url).href)};
    import {failureLedger} from ${JSON.stringify(new URL('../failure-ledger.mjs', import.meta.url).href)};
    const repairs = [{id:'repair-timeout',status:'failed',rc:124,timeout:3600},
      {id:'repair-limit',status:'failed',rc:75}, {id:'repair-done',status:'done',rc:0}];
    const tracked = [...repairs,{id:'stopped',status:'stopped',endReason:'stopped by owner'},
      {id:'live',status:'running',pid:90001,pidStart:'1'}, {id:'unknown',status:'running'}];
    const before = JSON.stringify(tracked), result = workerLiveness({tracked,repairAttempts:repairs},{now:5000,isLive:()=>true});
    assert.deepEqual(result.failures.attempts,failureLedger(tracked));
    assert.equal(result.failures.count,3);
    assert.deepEqual(result.failures.byCause,{'timeout':1,'provider-limit':1,'owner-stop':1});
    assert.equal(result.repairs.count,3); assert.equal(result.repairs.failures.count,2);
    assert.equal(result.failures.attempts[0].timeoutSeconds,3600);
    assert.equal(result.counts.live,1); assert.equal(result.counts.unknown,1);
    assert.equal(workerLiveness({tracked}).repairs.available,false);
    assert.equal(workerLiveness({tracked}).repairs.count,null);
    assert.equal(JSON.stringify(tracked),before);
    console.log('F31 failure and explicit repair counts agree; execution requires live evidence');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
      F31_FAILURE_CAUSE_MODULE: process.env.F31_FAILURE_CAUSE_MODULE } });
  assert.equal(result.status, 0, result.stderr);
});

test('distinct processes racing the same prepared launch start exactly one dispatcher', async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const w = world(t), r = await ready(w, 'cross-process'), marker = path.join(w.root, 'starts.txt'), jobsFile = path.join(w.root, 'jobs.json');
  fs.writeFileSync(jobsFile, '[]');
  const moduleURL = new URL('../build-intake/index.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs'; import {createBuildIntake} from ${JSON.stringify(moduleURL)};
    const [root,id,marker,jobsFile]=process.argv.slice(1);
    const api=createBuildIntake({dataDir:root,runDir:root+'/run',jobs:()=>JSON.parse(fs.readFileSync(jobsFile)),
      admit:async()=>{await new Promise(r=>setTimeout(r,20));return {ok:true}},
      dispatch:async(i)=>{fs.appendFileSync(marker,'start\\n');fs.writeFileSync(jobsFile,JSON.stringify([{id:'one-job',project:'01-demo',launcher:'agent.sh',outdir:i.outdir,status:'running',pid:123,pidStart:'456'}]));}});
    await api.launch(id);`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', code, w.root, r.id, marker, jobsFile], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const results = await Promise.all(children.map(async c => { let error = ''; c.stderr.on('data', x => { error += x; }); const [rc] = await once(c, 'exit'); return { rc, error }; }));
  assert.deepEqual(results.map(x => x.rc), [0, 0], JSON.stringify(results));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'start\n');
  assert.equal(w.api.get(r.id).attempt.id, `${r.id}-a1`);
});

test('completed canonical dependencies permit admission without asserting their audit acceptance', async (t) => {
  const w = world(t), r = await ready(w, 'with-dependency');
  w.api.answer(r.id, 'dependencies', ['prerequisite'], { by: 'owner', evidence: 'wait for prerequisite' });
  w.jobs.push({ id: 'prerequisite', status: 'done', rc: 0 });
  const end = await w.api.launch(r.id); assert.equal(end.state, 'registered'); assert.equal(w.starts.length, 1);
});

test('partial unpublished data is ignored; unsupported committed schemas fail closed without destroying history', async (t) => {
  const w = world(t), r = await ready(w, 'schema');
  const dir = path.join(w.root, 'build-intake', 'builds', r.id), pending = path.join(dir, '_pending');
  fs.mkdirSync(pending, { recursive: true }); fs.writeFileSync(path.join(pending, 'interrupted.json'), '{partial');
  assert.equal(w.api.get(r.id).id, r.id);
  fs.writeFileSync(path.join(dir, '99999999.json'), JSON.stringify({ schemaVersion: 999 }));
  assert.throws(() => w.api.get(r.id), /Unsupported.*schema/i);
  assert.ok(fs.existsSync(path.join(pending, 'interrupted.json')));
  assert.throws(() => w.api.defaults('../escape'), /version/i);
});

test('invalid Jev model recommendations fail visibly instead of silently switching to fallback', async (t) => {
  const w = world(t, { route: async () => ({ pick: 'unknown-provider', effort: 'high' }) });
  await assert.rejects(w.api.begin(request('invalid-route')), /Unsupported role model/);
});

test('answer validation rejects coerced scalar arrays and missing values', async (t) => {
  const w = world(t), r = await w.api.begin(request('scalar-types'));
  assert.throws(() => w.api.answer(r.id, 'priority', ['P2'], { by: 'owner', evidence: 'bad array' }), /priority/);
  assert.throws(() => w.api.answer(r.id, 'tier', ['T4'], { by: 'owner', evidence: 'bad array' }), /tier/);
  assert.throws(() => w.api.answer(r.id, 'deadline', undefined, { by: 'owner', evidence: 'missing' }), /JSON|deadline/);
});

test('auditor model choice alone neither proves independence nor forbids separate sessions of the same model', async (t) => {
  const w = world(t), r = await ready(w, 'same-model');
  w.api.answer(r.id, 'roles', { worker: pick('worker'), auditor: pick('worker'), repair: pick('worker') }, { by: 'owner', evidence: 'separate audit context with same model' });
  const end = await w.api.launch(r.id);
  assert.equal(end.config.fields['execution.independentAudit'].effective, true);
  assert.equal(w.api.summary(r.id).json.fields['runtime.auditAcceptance'].status, 'pending');
});
