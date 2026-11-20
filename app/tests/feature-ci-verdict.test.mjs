import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { featureCiVerdict } from '../feature-ci-verdict.mjs';
import { liveJobs, saveFeatures } from '../jobs.mjs';

test('feature history and live jobs require a protected pass for the exact reviewed commit', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-feature-ci-'));
  const job = { id: 'feature', project: '10-fixture', label: 'A feature', isPlan: true,
    outdir: path.join(run, 'worker-out'), status: 'done', kind: 'queue', touches: 7 };
  fs.mkdirSync(job.outdir);
  fs.writeFileSync(path.join(job.outdir, 'rc'), '0\n');
  const id = createHash('sha256').update(job.outdir).digest('hex');
  const dir = path.join(run, 'feature-ci-state', 'runs', id);
  fs.mkdirSync(path.join(dir, 'ci'), { recursive: true });
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const contract = { version: 1, plan: job.project, out: job.outdir };
  const history = path.join(run, 'history.json');

  put('contract.json', { ...contract, mode: 'off' });
  assert.equal(featureCiVerdict(job, run), null);
  assert.equal(saveFeatures(history, [job], { run }).length, 1);
  fs.writeFileSync(path.join(run, 'feature-ci.json'), JSON.stringify({ projects: { [job.project]: { visibility: 'public' } } }));
  assert.equal(featureCiVerdict(job, run), '82');
  assert.deepEqual(saveFeatures(history, [job], { run }), []);
  assert.equal(liveJobs([{ ...job, status: 'stopped', rc: null }], { run })[0].status, 'failed');

  put('contract.json', { ...contract, mode: 'review' });
  assert.deepEqual(saveFeatures(history, [job], { run }), []);

  put('contract.json', { ...contract, mode: 'per-feature' });
  put('terminal.json', { state: 'failed', rc: 80 });
  assert.equal(liveJobs([{ ...job, status: 'running', pid: null }], { run })[0].rc, '80');
  assert.deepEqual(saveFeatures(history, [job], { run }), []);

  const commit = 'a'.repeat(40);
  put('terminal.json', { state: 'complete', rc: 0, commit });
  const receipt = { version: 1, run: id, verdict: 'PASS', platform: 'linux' };
  put('ci/PASS.json', { ...receipt, commit: 'b'.repeat(40) });
  assert.deepEqual(saveFeatures(history, [job], { run }), []);
  put('ci/PASS.json', { ...receipt, commit });
  assert.equal(liveJobs([job], { run })[0].status, 'done');
  assert.equal(saveFeatures(history, [job], { run })[0].ciManaged, true);
  assert.equal(saveFeatures(history, [], { run }).length, 1);
});
