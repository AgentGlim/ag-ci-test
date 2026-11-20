// done-ack: finished-job notices that stay until seen (app/done-ack.mjs). Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as DA from '../done-ack.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const M = 60e3, T0 = 1_800_000_000_000;
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-doneack-')); return d; };
const store = (t, baselineAt = T0 - 3600e3) => { const d = path.join(tmp(), 'done-ack'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ v: 1, baselineAt, lastSweepAt: baselineAt, chains: {} })); t.after(() => fs.rmSync(path.dirname(d), { recursive: true, force: true })); return d; };
let n = 0;
const job = (o = {}) => ({ id: `j${++n}`, project: '68-observatory-app', isPlan: true, kind: 'subagent', harness: 'claude', model: 'claude-opus-5-5',
  label: 'agent icons fix', launcher: 'claude Agent tool', agentId: `a${n}`, status: 'done', rc: 0, started: T0 - 20 * M, ended: T0 - M, ...o });
const keys = (d) => DA.listAll(d).map((x) => x.key).sort();

test('first sweep sets a baseline: nothing that ended earlier gets a notice', (t) => {
  const d = path.join(tmp(), 'done-ack'); t.after(() => fs.rmSync(path.dirname(d), { recursive: true, force: true }));
  const r = DA.sweep(d, [job()], { now: T0 });
  assert.deepEqual(r.created, []); assert.equal(DA.readState(d).baselineAt, T0);
  assert.deepEqual(DA.sweep(d, [job({ ended: T0 - 5 * M })], { now: T0 + 1000 }).created, []);
});

test('scope rules (DESIGN 4.2)', (t) => {
  const d = store(t);
  const cases = {
    ok: job(),
    test: job({ outdir: '/x/build/out/test-tmp/a' }),
    auto: job({ kind: 'autonomous' }),
    chat: job({ kind: 'one-on-one', launcher: null, pid: null, agentId: null }),
    quiet: job({ quiet: true }),
    nested: job({ launchedBy: { harness: 'claude', agentId: 'parent' } }),
    headless: job({ launchedBy: { headless: true } }),
    round: job({ launcher: 'agent.sh', agentId: null, outdir: '/p/68-x/_build/v3-r1/w' }),
    fg: job({ agentId: null }),
    take: job({ launcher: 'headless-take.sh', agentId: null, req: '/q/a.req', outdir: '/tmp/t1' }),
  };
  const r = DA.sweep(d, Object.values(cases), { now: T0 });
  assert.deepEqual(r.created, [cases.ok.id]);
  assert.equal(DA.skipReason(cases.take), 'queue take without a launcher');
  assert.equal(DA.skipReason({ ...cases.take, project: 'SuperAgent' }), null, 'a take on the SuperAgent row counts');
  assert.equal(DA.skipReason({ ...cases.round, launchedBy: { harness: 'claude' } }), null, 'launchedBy replaces the legacy folder rule');
});

test('duration floor, failures always, stopped on purpose skipped, stopped after a report counts', (t) => {
  const d = store(t), od = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-od-')); fs.writeFileSync(path.join(od, 'noretry'), '');
  t.after(() => fs.rmSync(od, { recursive: true, force: true }));
  const short = job({ started: T0 - 90e3, ended: T0 - 30e3 });
  const shortFail = job({ status: 'failed', rc: 1, started: T0 - 40e3, ended: T0 - 30e3, label: 'x one' });
  const stopNo = job({ status: 'stopped', outdir: od, label: 'x two' });
  const stopRep = job({ status: 'stopped', summary: 'Done: it works\nmore', label: 'x three' });
  const r = DA.sweep(d, [short, shortFail, stopNo, stopRep], { now: T0, minMinutes: 2 });
  assert.deepEqual(r.created.sort(), [shortFail.id, stopRep.id].sort());
  assert.equal(DA.readNotice(d, stopRep.id).outcome, 'done');
  assert.equal(DA.readNotice(d, stopRep.id).result, 'Done: it works');
  assert.equal(DA.readNotice(d, shortFail.id).outcome, 'failed');
  const busy = job({ status: 'failed', rc: 75, label: 'busy retry' });
  assert.deepEqual(DA.sweep(d, [busy], { now: T0 }).created, []);
  assert.equal(fs.existsSync(DA.noticePath(d, busy.id)), false);
});

test('wrapper + take: one notice keyed by the take, wrapper id is an alias; wait while the wrapper runs; failed wrapper wins', (t) => {
  const d = store(t), od = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-od-')); t.after(() => fs.rmSync(od, { recursive: true, force: true }));
  // F31: wrapper and take fold only on proved lineage (the reservation's verified dispatch generation),
  // never on a shared outdir; production writes both fields on both records.
  const lin = { dispatchVerified: true, dispatchGeneration: 'gen-queue-x' };
  const w = { id: 'wrap1', project: 'SuperAgent', launcher: 'agent.sh claude', outdir: od, status: 'running', started: T0 - 30 * M, kind: 'queue', harness: 'claude', label: 'queue job', ...lin };
  const tk = { id: 'take1', project: 'SuperAgent', launcher: 'headless-take.sh', req: '/q/x.req', outdir: od, status: 'done', rc: 0, started: T0 - 29 * M, ended: T0 - M, kind: 'queue', harness: 'claude', label: 'queue job', ...lin };
  assert.deepEqual(DA.sweep(d, [w, tk], { now: T0 }).created, [], 'the wrapper still runs');
  const r = DA.sweep(d, [{ ...w, status: 'failed', rc: 1, ended: T0 - 30e3 }, tk], { now: T0 + 1000 });
  assert.deepEqual(r.created, ['take1']);
  const nt = DA.readNotice(d, 'take1'); assert.deepEqual(nt.ids, ['take1', 'wrap1']); assert.equal(nt.outcome, 'failed');
  assert.deepEqual(DA.sweep(d, [{ ...w, status: 'failed', ended: T0 - 30e3 }, tk], { now: T0 + 2000 }).created, [], 'sweep twice: same files');
  assert.equal(DA.resolveHandle(d, 'wrap1').key, 'take1');
});

test('supersede: same outdir, -rN, same label after a failure within 30 min; never for a finished job after 30 min', (t) => {
  const d = store(t);
  const f1 = job({ status: 'failed', rc: 1, outdir: '/o/a', ended: T0 - 10 * M, started: T0 - 12 * M });
  const f2 = job({ status: 'failed', rc: 1, outdir: '/o/b', ended: T0 - 10 * M, started: T0 - 12 * M, label: 'b job' });
  const f3 = job({ status: 'failed', rc: 1, outdir: '/o/c', ended: T0 - 10 * M, started: T0 - 12 * M, label: 'c job' });
  const ok = job({ outdir: '/o/d', ended: T0 - 10 * M, started: T0 - 20 * M, label: 'd job' });
  DA.sweep(d, [f1, f2, f3, ok], { now: T0 - 5 * M });
  assert.equal(DA.unseenOf(d).length, 4);
  const runs = [job({ id: 'n1', status: 'running', outdir: '/o/a', started: T0 - M, ended: null }), job({ id: 'n2', status: 'running', outdir: '/o/b-r2', started: T0 - M, ended: null, label: 'zz' }),
    job({ id: 'n3', status: 'running', outdir: '/o/zz', started: T0 - M, ended: null, label: 'c job' }), job({ id: 'n4', status: 'running', outdir: '/o/q', started: T0 - M, ended: null, label: 'd job' })];
  const r = DA.sweep(d, [f1, f2, f3, ok, ...runs], { now: T0 });
  assert.deepEqual(r.superseded.sort(), [f1.id, f2.id, f3.id].sort());
  assert.equal(DA.readMarker(d, f1.id).via, 'superseded');
  assert.deepEqual(DA.unseenOf(d).map((x) => x.key), [ok.id]);
  assert.ok(DA.readState(d).chains.n1 <= f1.started, 'the chain remembers its first start');
});

test('ack: first writer wins; unack moves, never deletes; prune moves to _archive', (t) => {
  const d = store(t); const j = job(); DA.sweep(d, [j], { now: T0 });
  const res = Array.from({ length: 20 }, () => DA.ack(d, [j.id], { by: 'owner', via: 'click' }));
  assert.equal(res.flat().length, 1);
  const moduleURL = new URL('../done-ack.mjs', import.meta.url).href;
  const p = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(moduleURL)}).then(m=>console.log(m.ack(${JSON.stringify(d)},[${JSON.stringify(j.id)}],{}).length))`], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), '0', 'another process cannot ack twice');
  assert.deepEqual(DA.unack(d, [j.id], T0), [j.id]);
  assert.ok(fs.existsSync(path.join(d, '_archive/undone', `${j.id}.${T0}.ack`)));
  assert.equal(DA.unseenOf(d).length, 1);
  DA.ack(d, [j.id], { by: 'owner', via: 'click' });
  fs.writeFileSync(DA.markerPath(d, j.id), JSON.stringify({ at: T0 - 40 * 86400e3, via: 'click' }));
  assert.deepEqual(DA.prune(d, { now: T0, keepDays: 30 }), [j.id]);
  assert.equal(DA.listAll(d).length, 0);
  assert.ok(fs.readdirSync(path.join(d, '_archive')).some((x) => /^\d{4}-\d\d$/.test(x)));
  assert.deepEqual(DA.ack(d, ['../evil'], {}), [], 'bad keys are refused');
});

test('handles: key, agentId, outdir, label, ambiguous, unknown, still running', (t) => {
  const d = store(t);
  const a = job({ outdir: '/o/h1', label: 'same name' }), b = job({ outdir: '/o/h2', label: 'same name' }), c = job({ outdir: '/o/h3', label: 'unique one' });
  DA.sweep(d, [a, b, c], { now: T0 });
  assert.equal(DA.resolveHandle(d, a.id).key, a.id);
  assert.equal(DA.resolveHandle(d, a.agentId).key, a.id);
  assert.equal(DA.resolveHandle(d, '/o/h2').key, b.id);
  assert.equal(DA.resolveHandle(d, 'unique one').key, c.id);
  assert.equal(DA.resolveHandle(d, 'same name').code, 3);
  assert.equal(DA.resolveHandle(d, 'nope').code, 4);
  assert.equal(DA.resolveHandle(d, 'r1', [{ id: 'r1', status: 'running' }]).code, 5);
});

test('notice outlives the tracked record; a broken notice still counts', (t) => {
  const d = store(t); const j = job(); DA.sweep(d, [j], { now: T0 });
  DA.sweep(d, [], { now: T0 + 1000 });
  assert.equal(DA.unseenOf(d).length, 1);
  fs.writeFileSync(path.join(d, 'broken1.json'), '{nope');
  const b = DA.unseenOf(d).find((x) => x.key === 'broken1');
  assert.ok(b && b.n.broken && /details unavailable/.test(b.n.desc));
});

test('sentence: desc, [task:] tag, 3-word label, prompt first sentence, 140-char cut, tags removed', (t) => {
  assert.deepEqual(DA.sentenceOf({ desc: 'Fix the icons. More text.' }), { desc: 'Fix the icons.', descFrom: 'flag' });
  assert.equal(DA.sentenceOf({ label: '[task: Build the panel] x' }).descFrom, 'tag');
  assert.deepEqual(DA.sentenceOf({ label: '[plan: 68-x] agent icons fix' }), { desc: 'agent icons fix', descFrom: 'label' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'prompt.md'), '[plan: 68-x]\nYou are a builder. Write the tray tests now. Then more.');
  assert.deepEqual(DA.sentenceOf({ label: 'tray', outdir: dir }), { desc: 'Write the tray tests now.', descFrom: 'prompt' });
  assert.equal(DA.sentenceOf({ label: 'tray-tests-v2' }).descFrom, 'slug');
  const long = DA.cleanSentence('word '.repeat(60)); assert.ok(long.length <= 140 && long.endsWith('…'));
});
