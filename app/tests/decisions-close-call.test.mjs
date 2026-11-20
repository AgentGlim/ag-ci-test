// Fixture-only close-call selection, CLI effort selection and required audit receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { choose, selectModel, output, auditCloseCall, closeCallTag } from '../../harness/bin/jev-route.mjs';

const rules = () => ({ options: {
  'codex-sol': { group: 'codex', efforts: ['high'], launch: 'sol {effort}', desc: 'Sol' },
  'codex-terra': { group: 'codex', efforts: ['low'], launch: 'terra {effort}', desc: 'Terra' },
  'codex-luna': { group: 'codex', efforts: ['low'], launch: 'luna {effort}', desc: 'Luna' },
}, strength: ['codex-sol', 'codex-terra', 'codex-luna'], close: 0.05, fallback: { pick: 'codex-sol', effort: 'high' },
  stateTemplate: '{task}', modelQuestion: '{desc}', effortQuestion: '{name}: {effortDesc}',
  router: { closeCallP: 0.45, closeCallGap: 0.08, costOrder: [['codex-luna', 'codex-terra', 'codex-sol']] } });
const scores = (sol = .44, terra = .37, luna = .10) => ({ 'm_codex-sol': { noul: sol }, 'm_codex-terra': { noul: terra }, 'm_codex-luna': { noul: luna } });
const ranked = (sol = .44, terra = .37, luna = .10) => [['codex-sol', sol], ['codex-terra', terra], ['codex-luna', luna]];
const select = (r = rules(), list = ranked(), ctx = {}) => selectModel(r, list, [], ctx);

test('close call picks cheaper runner-up and prints both scores and reason', () => {
  const c = choose(rules(), scores(), { e_high: { noul: .9 }, e_low: { noul: .8 } }, undefined, [], false, { task: 'Implement a routine adapter' });
  assert.equal(c.pick, 'codex-terra'); assert.equal(c.effort, 'low');
  assert.equal(output(rules(), c).launch, 'terra low');
  assert.deepEqual([c.closeCall.pTop, c.closeCall.pRunnerUp], [.44, .37]);
  assert.match(closeCallTag(c.closeCall), /codex-sol p=0.44 -> codex-terra p=0.37;.*cheaper/);
});
test('final review keeps top model', () => {
  for (const task of ['Final review of implementation', 'Run the final-review']) assert.equal(select(rules(), ranked(), { task }).top[0], 'codex-sol');
});
test('verify and installer/rollback work keep top model', () => {
  for (const task of ['Verify changes', 'Verification step', 'Verifying results', 'Update deliver/install.sh', 'Audit rollback.sh'])
    assert.equal(select(rules(), ranked(), { task }).top[0], 'codex-sol', task);
});
test('plan pin and owner model request keep top model under both tag names', () => {
  for (const ctx of [{ pinned: true }, { ownerAsked: true },
    { task: '[decisions-override: plan-pinned: 68-app P1]' }, { task: '[jev-override: owner-asked with "use that model please"]' }])
    assert.equal(select(rules(), ranked(), ctx).top[0], 'codex-sol');
});
test('confidence threshold, score gap and configured threshold boundaries', () => {
  assert.equal(select(rules(), ranked(.45, .40)).top[0], 'codex-sol');
  assert.equal(select(rules(), ranked(.44, .359)).top[0], 'codex-sol');
  assert.equal(select(rules(), ranked(.44, .36)).top[0], 'codex-terra');
  const r = rules(); r.router.closeCallP = .40;
  assert.equal(select(r).top[0], 'codex-sol');
});
test('only runner-up qualifies; unknown or non-cheaper costs and worse usage tier preserve top', () => {
  const r = rules(); r.router.costOrder = [['codex-sol', 'codex-terra', 'codex-luna']];
  assert.equal(select(r).top[0], 'codex-sol');
  delete r.router.costOrder;
  assert.equal(select(r).top[0], 'codex-sol');
  r.router.costOrder = [['codex-sol', 'codex-terra'], ['codex-luna', 'codex-sol']];
  assert.equal(select(r, ranked(.44, .40, .39)).top[0], 'codex-sol');
  assert.equal(selectModel(rules(), ranked(), ['codex-terra']).top[0], 'codex-sol');
});
test('eligibility and cooldown-filtered scores cannot reintroduce an unavailable runner-up', () => {
  const c = choose(rules(), scores(), null, ['codex-sol']);
  assert.equal(c.pick, 'codex-sol'); assert.equal(c.closeCall, undefined);
});
test('audit writes one downgrade with both probabilities; audit failure is visible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-audit-'));
  const old = process.env.DECISIONS_OVERRIDE_LOG;
  try {
    process.env.DECISIONS_OVERRIDE_LOG = path.join(dir, 'overrides.ndjson');
    auditCloseCall({ run: dir }, undefined);
    assert.equal(fs.existsSync(process.env.DECISIONS_OVERRIDE_LOG), false);
    auditCloseCall({ run: dir }, select().closeCall);
    const rows = fs.readFileSync(process.env.DECISIONS_OVERRIDE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1); assert.equal(rows[0].decision, 'downgrade');
    assert.equal(rows[0].pTop, .44); assert.equal(rows[0].pRunnerUp, .37);
    process.env.DECISIONS_OVERRIDE_LOG = dir;
    assert.throws(() => auditCloseCall({ run: dir }, select().closeCall));
  } finally { if (old === undefined) delete process.env.DECISIONS_OVERRIDE_LOG; else process.env.DECISIONS_OVERRIDE_LOG = old; }
});
function cli(task, auditBlocked = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-cli-'));
  fs.mkdirSync(`${dir}/home`, { recursive: true }); fs.mkdirSync(`${dir}/data`);
  fs.writeFileSync(`${dir}/config.json`, '{}'); fs.writeFileSync(`${dir}/integrations.json`, '{}');
  fs.writeFileSync(`${dir}/routes.json`, JSON.stringify(rules())); fs.writeFileSync(`${dir}/env`, 'JEV_API_KEY=fixture\n');
  const stub = 'data:text/javascript,' + encodeURIComponent(`globalThis.fetch=async(url,init)=>{
    const q=JSON.parse(init.body).questions;
    const answers=Object.keys(q).some(x=>x.startsWith('m_')) ? ${JSON.stringify(scores())} :
      Object.fromEntries(Object.keys(q).map(x=>[x,{noul:.9}]));
    return {ok:true,headers:{get:()=>null},json:async()=>({answers})};
  };`);
  const env = { PATH: process.env.PATH, HOME: `${dir}/home`, XDG_CONFIG_HOME: path.join(dir, 'home', '.config'),
    AGENTGLIM_CONFIG: `${dir}/config.json`, AGENTGLIM_WORK: dir, AGENTGLIM_DATA: `${dir}/data`,
    AGENTGLIM_ENV_FILE: `${dir}/env`, AGENTGLIM_DECISIONS_ROUTES: `${dir}/routes.json`,
    AGENTGLIM_PLANS: `${dir}/plans`, AGENTGLIM_RUN: `${dir}/plans/_run`, AGENTGLIM_INTEGRATIONS: `${dir}/integrations.json`,
    MODEL_COOLDOWN_FILE: `${dir}/cooldown`, DECISIONS_OVERRIDE_LOG: auditBlocked ? dir : `${dir}/override.ndjson` };
  const proc = spawnSync(process.execPath, ['--import', stub, path.resolve(import.meta.dirname, '../../harness/bin/jev-route.mjs'), task], { env, encoding: 'utf8', timeout: 30000 });
  return { ...proc, audit: env.DECISIONS_OVERRIDE_LOG };
}
test('CLI asks effort for cheaper selection, exposes receipt and logs downgrade', () => {
  const r = cli('Implement routine adapter'); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.pick, 'codex-terra'); assert.equal(out.effort, 'low'); assert.equal(out.pEffort, .9);
  assert.match(r.stdout, /codex-sol p=0.44 -> codex-terra p=0.37/);
  assert.equal(JSON.parse(fs.readFileSync(r.audit, 'utf8')).to, 'codex-terra');
});
test('CLI final review retains top and writes no downgrade audit', () => {
  const r = cli('Final review of adapter'); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).pick, 'codex-sol');
  assert.equal(fs.existsSync(r.audit), false);
});
test('CLI refuses a downgrade when its audit cannot be written', () => {
  const r = cli('Implement routine adapter', true);
  assert.equal(r.status, 1); assert.match(r.stderr, /close-call audit unavailable/); assert.equal(r.stdout.trim(), '');
});

test('portable decisions-gate advice prints both choices and the reason', () => {
  const script = `import importlib.machinery, importlib.util, sys, json
loader = importlib.machinery.SourceFileLoader('gate', sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
print(m.advice(json.loads(sys.argv[2])))`;
  const j = { pick: 'codex-terra', p: .37, effort: 'low', launch: 'fixture', closeCall: select().closeCall };
  const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', script, path.resolve(import.meta.dirname, '../../tools/addons/decisions-gate'), JSON.stringify(j)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex-sol p=0.44 -> codex-terra p=0.37/);
  assert.match(r.stdout, /runner-up is cheaper/);
});
