import { killTree } from '../cli-spawn.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { archiveScratch } from './helpers/weekly-scratch.mjs';
// done-ack on an isolated server (AGENTGLIM_DEV=1, temp HOME and data): snapshot fields, Q3 section, POST/GET,
// guards, restart keeps unseen, job-report fallback; and the harness tool (list, ack --quote, unack, count, exit codes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const REPO = path.resolve(import.meta.dirname, '../..');
const M = 60e3;

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-doneack-srv-')), now = Date.now();
  const w = (f, c) => { const p = path.join(home, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c)); };
  w('env', ''); w('harness.json', '{}'); w('data/setup.json', {}); w('data/integrations.json', {});
  w('plans/05-demo/PLAN.md', '# demo\n'); w('plans/_run/state.json', { projects: { '05-demo': { stage: 'done', stages: [] } } });
  w('data/done-ack/state.json', { v: 1, baselineAt: now - 3600e3, lastSweepAt: now - 3600e3, chains: {} });
  const j = (id, o) => w(`data/tracked-jobs/${id}.json`, { id, isPlan: false, kind: 'subagent', harness: 'claude', model: 'claude-opus-5-5', launcher: 'claude Agent tool', agentId: 'ag-' + id, status: 'done', rc: 0, started: now - 20 * M, ended: now - 2 * M, ...o });
  j('plan1', { project: '05-demo', isPlan: true, label: 'build the <script>x</script> tray', summary: 'All good\nmore' });
  j('plan2', { project: '05-demo', isPlan: true, label: 'verify the tray', status: 'failed', rc: 1 });
  j('sa1', { project: 'SuperAgent', label: 'price refresh job' });
  j('oth1', { project: 'leads', label: 'lead scan job' });
  j('short', { project: '05-demo', isPlan: true, label: 'tiny', started: now - 70e3 });
  return home;
}
async function boot(stops, home) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "process.argv[2] = '0'; await import('./app/server.mjs');"], { cwd: REPO, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (s) => { err += s; });
  const stop = () => killTree(child, { graceMs: 1000 });
  stops.push(stop);
  const port = await waitForServerReady(child);
  return { port, stop, err: () => err };
}
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/done-ack`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers }, body: JSON.stringify(body) });

test('server: snapshot rows, Q3, POST/GET, guards, restart, report fallback', async (t) => {
  const home = seed(), stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let srv = await boot(stops, home);
  const s = await (await fetch(`http://127.0.0.1:${srv.port}/api/snapshot`)).json();
  assert.equal(s.doneAck.unseen, 4, srv.err()); assert.equal(s.doneAck.failed, 1);
  const p = s.projects.find((x) => x.dir === '05-demo');
  assert.deepEqual(p.doneAck.map((x) => x.key), ['plan2', 'plan1'], 'failed first'); assert.equal(p.section, 'active', 'Q3: unseen keeps the plan in Active builds');
  assert.equal(p.agents.length, 0, 'never both running and finished');
  assert.deepEqual(s.watcherRow?.doneAckKeys ?? ['sa1'], ['sa1']);
  assert.deepEqual(s.otherRows.find((o) => o.dir === 'leads')?.doneAckKeys, ['oth1'], 'other row kept alive');
  // guards
  assert.equal((await post(srv.port, { action: 'ack', keys: ['plan1'] }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(srv.port, { action: 'ack', keys: ['../x'] })).status, 422);
  assert.equal((await post(srv.port, { action: 'nope' })).status, 422);
  const g0 = await (await fetch(`http://127.0.0.1:${srv.port}/api/done-ack?state=unseen`)).json();
  assert.equal(g0.unseen, 4, 'GET changes nothing');
  // click ack, undo, row clear with before
  let r = await (await post(srv.port, { action: 'ack', keys: ['plan1'] })).json();
  assert.deepEqual(r.changed, ['plan1']); assert.equal(r.unseen, 3);
  r = await (await post(srv.port, { action: 'unack', keys: ['plan1'] })).json(); assert.deepEqual(r.changed, ['plan1']);
  r = await (await post(srv.port, { action: 'ack', row: '05-demo', before: 1 })).json(); assert.deepEqual(r.changed, [], 'before: newer notices stay');
  r = await (await post(srv.port, { action: 'ack', row: '05-demo', before: Date.now() + 1000 })).json(); assert.deepEqual(r.changed.sort(), ['plan1', 'plan2']);
  const seen = await (await fetch(`http://127.0.0.1:${srv.port}/api/done-ack?state=seen`)).json();
  assert.equal(seen.items[0].seen.via, 'row');
  // report fallback after the record is gone
  fs.renameSync(path.join(home, 'data/tracked-jobs/plan1.json'), path.join(home, 'plan1.moved'));
  assert.match(await (await fetch(`http://127.0.0.1:${srv.port}/api/job-report?id=plan1`)).text(), /All good/);
  // restart keeps state
  await srv.stop(); srv = await boot(stops, home);
  const s2 = await (await fetch(`http://127.0.0.1:${srv.port}/api/snapshot`)).json();
  assert.deepEqual(s2.doneAck.keys.sort(), ['oth1', 'sa1']);
  assert.equal(s2.projects.find((x) => x.dir === '05-demo').section, 'pipeline', 'seen: back to Pipeline');
});

test('tool: list, count, show, ack needs --quote, unack, exit codes; works with the server down', (t) => {
  const home = seed(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans') };
  const run = (...a) => spawnSync(process.execPath, [path.join(REPO, 'harness/bin/done-ack.mjs'), ...a], { env, encoding: 'utf8' });
  assert.equal(run('count').stdout.trim(), '4 not seen (1 failed)');
  assert.match(run('list').stdout, /plan2\s+failed/);
  assert.equal(JSON.parse(run('show', 'ag-sa1').stdout).key, 'sa1');
  assert.equal(run('ack', 'sa1').status, 2, 'no quote');
  assert.equal(run('ack', 'nope', '--quote', 'x').status, 4);
  const a = run('ack', 'price refresh job', '--quote', 'ok the price refresh looks good');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'data/done-ack/sa1.ack'), 'utf8')).quote, 'ok the price refresh looks good');
  assert.equal(run('ack', 'sa1', '--quote', 'again').status, 0, 'already seen is fine');
  assert.equal(run('unack', 'sa1').status, 0);
  assert.equal(run('count').stdout.trim(), '4 not seen (1 failed)');
  assert.equal(run('ack', '--all', '--quote', 'all seen, thanks').status, 0);
  assert.equal(run('count').stdout.trim(), '0 not seen');
});

test('listener: UNSEEN hint appears for a change of ten since the previous wake', (t) => {
  const home = seed(); t.after(() => archiveScratch(home, t.passed ? 'passed' : 'failed', t.name, t.error));
  const run = path.join(home, 'plans/_run'); for (const d of ['audit_queue', 'chat_inbox', 'status_ask']) fs.mkdirSync(path.join(run, d), { recursive: true });
  fs.writeFileSync(path.join(run, 'chat_inbox/1700000000001.json'), '{}');
  fs.writeFileSync(path.join(run, 'config.json'), JSON.stringify({ listener: { settleSec: 0 } }));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(home, `data/done-ack/x${i}.json`), '{}');
  const r = spawnSync('bash', [path.join(REPO, 'harness/bin/auditq-wait.sh')], { env: { PATH: process.env.PATH, HOME: home, AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_RUN: run, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_WAIT_ROUNDS: '1', AGENTGLIM_WAIT_POLL: '0' }, encoding: 'utf8' });
  assert.match(r.stdout, /CHAT:/); assert.match(r.stdout, /UNSEEN: 10 finished jobs awaiting acknowledgement/);
});
