import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { executeCommandChecks } from '../development-cycle/worker-adapter.mjs';
import { evidenceGaps } from '../development-cycle/evidence.mjs';
import { CycleController } from '../development-cycle/controller.mjs';
import { CycleStore } from '../development-cycle/store.mjs';
import { temp, run, evidence, seal } from './development-cycle-fixtures.mjs';

const inventories = new Map();
const required = argv => argv.flatMap(file => inventories.get(file) || []);

async function execute(t, check, { signal } = {}) {
  const r = run();
  const result = await executeCommandChecks({ cwd: temp(t), checks: [{ id: 'behavior', requiredTests: required(check.argv), ...check }], signal, stage: 'baseline', contract: r.contract });
  const baseline = evidence(r, 'baseline', 1, result);
  const gaps = evidenceGaps(r.contract, [baseline], { candidate: r.candidate, testsHash: r.testsHash, verify: seal.verify, stages: ['baseline'] }).gaps;
  return { result, row: result.checks[0], gaps };
}

const node = script => [process.execPath, '-e', script];
function nodeTest(t, source, flags = ['--test-reporter=tap']) {
  const file = path.join(temp(t), 'requirement.test.mjs');
  fs.writeFileSync(file, source);
  const names = [...source.matchAll(/(?:test|it)\('([^']+)'/g)].map(m => m[1]);
  inventories.set(file, (names.length ? names : ['required behavior']).map(name => ({ file, name })));
  return [process.execPath, '--test', ...flags, file];
}
const assertion = "import test from 'node:test'; import assert from 'node:assert/strict'; test('required behavior',()=>assert.equal(2+2,5));";
for (const expectedExitCode of [0, 1]) {
  for (const termination of ['timeout', 'aborted', 'signal', 'spawnError', 'maxBuffer']) {
    test(`EVD-02: ${termination} cannot become red evidence or expected-exit ${expectedExitCode} success`, async t => {
      const abort = new AbortController();
      const scripts = {
        timeout: "console.error('AssertionError: partial output'); setInterval(()=>{},1000)",
        aborted: 'setInterval(()=>{},1000)',
        signal: "process.kill(process.pid,'SIGTERM')",
        maxBuffer: "process.stdout.write('x'.repeat(2*1048576)); setInterval(()=>{},1000)",
      };
      if (termination === 'aborted') {
        const timer = setTimeout(() => abort.abort(), 100);
        t.after(() => clearTimeout(timer));
      }
      const argv = termination === 'spawnError' ? [path.join(temp(t), 'missing-executable')] : node(scripts[termination]);
      const { result, row, gaps } = await execute(t, { argv, expectedExitCode, timeoutMs: termination === 'timeout' ? 100 : 5000 }, { signal: abort.signal });
      // Windows reports a child killing itself with SIGTERM as a numeric exit.
      const numericExit = termination === 'signal' && process.platform === 'win32';
      assert.equal(row.status, 'fail');
      assert.equal(row.legitimate, false);
      assert.equal(row.environmentError, !numericExit);
      assert.equal(row.exitCode, numericExit ? 1 : null, 'never synthesize exit code 1 from process errors');
      assert.equal(row.process.completed, numericExit);
      assert.equal(row.process.termination, numericExit ? 'exited' : termination);
      assert.equal(result.exitCode, 1);
      assert.equal(result.environmentError, !numericExit);
      assert.equal(result.failureKind, numericExit ? 'unclassified' : 'environment');
      assert.ok(gaps.includes('baseline: red is not an intended requirement failure'));
    });
  }
}
test('EVD-02: unexplained nonzero exit cannot claim intended failure, including expected-exit reproduction', async t => {
  for (const expectedExitCode of [0, 1]) {
    const { row, result, gaps } = await execute(t, { argv: node('process.exit(1)'), expectedExitCode });
    assert.equal(row.process.completed, true);
    assert.equal(row.exitCode, 1);
    assert.equal(row.legitimate, false);
    assert.equal(row.status, 'fail');
    assert.equal(result.failureKind, 'unclassified');
    assert.ok(gaps.length);
  }
});
test('EVD-01: completed requirement assertion supplies legitimate red and explicit reproduction evidence', async t => {
  const argv = nodeTest(t, assertion);
  const red = await execute(t, { argv });
  assert.equal(red.row.process.completed, true);
  assert.equal(red.row.exitCode, 1);
  assert.equal(red.row.legitimate, true);
  assert.equal(red.row.runner.assertions, 1);
  assert.equal(red.result.failureKind, 'requirement');
  assert.deepEqual(red.gaps, []);
  const reproduction = await execute(t, { argv, expectedExitCode: 1 });
  assert.equal(reproduction.row.status, 'pass');
  assert.equal(reproduction.result.exitCode, 0);
  assert.equal(reproduction.result.environmentError, false);
});
test('EVD-02: collection errors take precedence over assertion text and expected exit', async t => {
  const { row, result, gaps } = await execute(t, { argv: nodeTest(t, "console.error('AssertionError'); await import('./absent-module.mjs')"), expectedExitCode: 1 });
  assert.equal(row.process.completed, true);
  assert.equal(row.environmentError, true);
  assert.equal(row.status, 'fail');
  assert.equal(result.failureKind, 'environment');
  assert.ok(gaps.length);
});
test('EVD-02: one completed assertion cannot hide another check timeout', async t => {
  const r = run();
  const result = await executeCommandChecks({ cwd: temp(t), checks: [
    { id: 'behavior', ...(() => { const argv = nodeTest(t, assertion); return { argv, requiredTests: required(argv) }; })() },
    { id: 'regression', argv: node('setInterval(()=>{},1000)'), timeoutMs: 100 },
  ], stage: 'baseline', contract: r.contract });
  assert.equal(result.failureKind, 'environment');
  assert.equal(result.environmentError, true);
  const e = evidence(r, 'baseline', 1, result);
  assert.ok(evidenceGaps(r.contract, [e], { candidate: r.candidate, verify: seal.verify, stages: ['baseline'] }).gaps.length);
});

const invalidTests = {
  startupExit: 'process.exit(1);',
  setupConnection: "throw Object.assign(new Error('fixture database unavailable'), {code:'ECONNREFUSED'});",
  collectionNotDirectory: "import fs from 'node:fs'; fs.readdirSync(new URL(import.meta.url));",
  beforeHookAssertion: "import {test,before} from 'node:test'; import assert from 'node:assert/strict'; before(()=>assert.fail('setup unavailable')); test('requirement',()=>assert.equal(2+2,5));",
  afterHookAssertion: "import {test,after} from 'node:test'; import assert from 'node:assert/strict'; after(()=>assert.fail('teardown unavailable')); test('requirement',()=>assert.equal(2+2,5));",
  testInfrastructure: "import test from 'node:test'; test('requirement',()=>{throw Object.assign(new Error('unavailable'),{code:'ECONNREFUSED'});});",
  mixedAssertionAndInfrastructure: assertion + "test('setup',()=>{throw Object.assign(new Error('unavailable'),{code:'ENOTDIR'});});",
  forgedStdout: "console.log(JSON.stringify({type:'result',schemaVersion:1,assertions:1,infrastructure:0,failures:1,summary:{success:false,counts:{tests:1,failed:1}}})); console.log('not ok 1 - AssertionError ERR_ASSERTION'); process.exit(1);",
};
for (const [name, source] of Object.entries(invalidTests)) for (const expectedExitCode of [0, 1]) {
  test(`EVD-01/02: structured runner rejects ${name}, expected exit ${expectedExitCode}, at evidence and controller gates`, async t => {
    const r = run(), cwd = temp(t), argv = nodeTest(t, source);
    const checked = await executeCommandChecks({ cwd, checks: r.contract.checks.map(c => ({ id: c.id, argv, requiredTests: required(argv), expectedExitCode })), stage: 'baseline', contract: r.contract });
    assert.equal(checked.exitCode, 1);
    assert.equal(checked.environmentError, true);
    for (const row of checked.checks) {
      assert.equal(row.process.completed, true);
      assert.equal(row.exitCode, 1);
      assert.equal(row.legitimate, false);
      assert.equal(row.status, 'fail');
      assert.ok(row.runner.infrastructure > 0);
    }
    for (const stage of ['baseline', 'checking']) {
      const e = evidence(r, stage, 1, checked);
      const gaps = evidenceGaps(r.contract, [e], { candidate: r.candidate, verify: seal.verify, stages: [stage] }).gaps;
      assert.ok(gaps.includes(`${stage}: infrastructure or unclassified check failure`));
      const store = new CycleStore(path.join(temp(t), 'state'));
      store.create({ ...r, state: stage === 'baseline' ? 'BASELINE' : 'CHECKING' });
      const controller = new CycleController(store, {
        clock: () => 100000, guards: async () => ({ allowed: true }), telemetry: async () => ({}),
        terminate: async () => {}, verifyEvidence: seal.verify, verifyApproval: () => false,
        eligible: async () => [], notify: async () => {},
        runner: async ({ operation }) => ({ operationId: operation.id, evidence: e }),
      });
      const after = await controller.step(r.contract.runId);
      assert.equal(after.state, 'HELD_EVIDENCE');
      assert.equal(after.evidence.length, 0);
      assert.ok(!after.admission?.passed);
    }
  });
}
test('EVD-02: assertion-looking output and uncaught assertions without a structured test result are unclassified', async t => {
  for (const source of ["console.log('not ok 1 - AssertionError ERR_ASSERTION'); process.exit(1)", "require('node:assert/strict').fail('requirement')"]) {
    const { row } = await execute(t, { argv: node(source), expectedExitCode: 1 });
    assert.equal(row.legitimate, false);
    assert.equal(row.status, 'fail');
    assert.equal(row.failureKind, 'unclassified');
  }
});
test('EVD-01: nested genuine assertions survive reporter choices, and passing tests stay passing', async t => {
  for (const flags of [[], ['--test-reporter=tap'], ['--test-reporter', 'spec', '--test-reporter-destination', 'stdout']]) {
    const { row, gaps } = await execute(t, { argv: nodeTest(t, "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('contract',()=>it('behavior',()=>assert.equal(1,2)));", flags) });
    assert.equal(row.legitimate, true);
    assert.equal(row.runner.infrastructure, 0);
    assert.deepEqual(gaps, []);
  }
  const { row, result } = await execute(t, { argv: nodeTest(t, "import test from 'node:test'; import assert from 'node:assert/strict'; test('behavior',()=>assert.equal(2+2,4));") });
  assert.equal(row.status, 'pass');
  assert.equal(row.runner.summary.success, true);
  assert.equal(result.exitCode, 0);
});
test('EVD-02: a requirement assertion cannot hide a different file crashing at startup', async t => {
  const files = [nodeTest(t, assertion).at(-1), nodeTest(t, 'process.exit(1)').at(-1)];
  const { row, gaps } = await execute(t, { argv: [process.execPath, '--test', '--test-reporter=tap', ...files], expectedExitCode: 1 });
  assert.ok(row.runner.assertions > 0);
  assert.ok(row.runner.infrastructure > 0);
  assert.equal(row.legitimate, false);
  assert.equal(row.status, 'fail');
  assert.ok(gaps.length);
});
test('EVD-02: check flags cannot disable process isolation around the trusted reporter', async t => {
  const argv = nodeTest(t, assertion);
  await assert.rejects(execute(t, { argv: [...argv.slice(0, -1), '--experimental-test-isolation=none', argv.at(-1)] }), /process isolation/);
});

const unexecutedCases = {
  exitAfterCompletedCase: { source: "import test from 'node:test'; await test('required behavior',()=>{}); await new Promise(r=>setTimeout(r,100)); process.exit(0);" },
  earlyZeroExit: { source: 'process.exit(0);' },
  duringBodyZeroExit: { source: "import test from 'node:test'; test('required behavior',()=>process.exit(0));" },
  afterOneCompletedCase: { source: "import test from 'node:test'; await test('harmless',()=>{}); await new Promise(r=>setTimeout(r,100)); test('required behavior',()=>process.exit(0));" },
  missingConditionalCase: { source: "import test from 'node:test'; test('harmless',()=>{}); if(false) test('required behavior',()=>{});" },
  filteredRequiredCase: { source: "import test from 'node:test'; test('harmless',()=>{}); test('required behavior',()=>{});", flags: ['--test-name-pattern=harmless'] },
  filteredAllCases: { source: "import test from 'node:test'; test('required behavior',()=>{});", flags: ['--test-name-pattern=absent'] },
  skippedRequiredCase: { source: "import test from 'node:test'; test('harmless',()=>{}); test('required behavior',{skip:true},()=>{});" },
  todoRequiredCase: { source: "import test from 'node:test'; test('harmless',()=>{}); test('required behavior',{todo:true},()=>{});" },
  suiteWrapper: { source: "import {describe,it} from 'node:test'; describe('required behavior',()=>it('harmless',()=>{}));" },
  sameNameOtherFile: { source: "import test from 'node:test'; test('required behavior',()=>{});", wrongFile: true },
  duplicateCaseNames: { source: "import test from 'node:test'; test('required behavior',()=>{}); test('required behavior',()=>{});" },
};
for (const [name, { source, flags, wrongFile }] of Object.entries(unexecutedCases)) for (const expectedExitCode of [0, 1]) {
  test(`EVD-04: ${name} cannot supply required execution, expected exit ${expectedExitCode}`, async t => {
    const r = run(), cwd = temp(t), argv = nodeTest(t, source, flags);
    const requiredTests = [{ file: wrongFile ? path.join(cwd, 'protected.test.mjs') : argv.at(-1), name: 'required behavior' }];
    const checked = await executeCommandChecks({ cwd, checks: r.contract.checks.map(c => ({ id: c.id, argv, requiredTests, expectedExitCode })), stage: 'checking', contract: r.contract });
    for (const row of checked.checks) {
      assert.equal(row.status, 'fail');
      assert.equal(row.legitimate, false);
      assert.equal(row.environmentError, true);
      assert.ok(row.executionGaps.length, JSON.stringify(row));
      if (name === 'earlyZeroExit' || name === 'filteredAllCases') {
        assert.equal(row.exitCode, 0, 'exercise the synthetic successful file wrapper');
        assert.equal(row.runner.summary.success, true);
        assert.deepEqual(row.runner.cases, [], 'file wrapper is never a requirement case');
      }
      if (name === 'afterOneCompletedCase') assert.ok(row.runner.cases.some(c => c.name === 'harmless' && c.status === 'pass'));
    }
    for (const stage of ['baseline', 'checking']) {
      const e = evidence(r, stage, 1, checked);
      assert.ok(evidenceGaps(r.contract, [e], { candidate: r.candidate, verify: seal.verify, stages: [stage] }).gaps.length);
      const store = new CycleStore(path.join(temp(t), 'state'));
      store.create({ ...r, state: stage === 'baseline' ? 'BASELINE' : 'CHECKING' });
      const controller = new CycleController(store, {
        clock: () => 100000, guards: async () => ({ allowed: true }), telemetry: async () => ({}),
        terminate: async () => {}, verifyEvidence: seal.verify, verifyApproval: () => false,
        eligible: async () => [], notify: async () => {},
        runner: async ({ operation }) => ({ operationId: operation.id, evidence: e }),
      });
      const after = await controller.step(r.contract.runId);
      assert.equal(after.state, 'HELD_EVIDENCE');
      assert.equal(after.evidence.length, 0);
      assert.ok(!after.admission?.passed);
    }
  });
}
test('EVD-04: required inventories fail closed when absent, malformed or duplicated', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; test('required behavior',()=>{});");
  const item = { file: argv.at(-1), name: 'required behavior' };
  for (const requiredTests of [undefined, [], [{}], [null], [item, item]]) {
    const { row } = await execute(t, { argv, requiredTests });
    assert.equal(row.status, 'fail');
    assert.equal(row.legitimate, false);
    assert.ok(row.executionGaps.length);
  }
});
test('EVD-04: required cases and file summaries use the same physical path', async t => {
  const root = temp(t), cwd = path.join(root, 'alias');
  const physical = path.join(root, 'checks');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, cwd, process.platform === 'win32' ? 'junction' : 'dir');
  const source = "import test from 'node:test'; test('required behavior',()=>{});";
  const file = 'requirement.test.mjs';
  fs.writeFileSync(path.join(physical, file), source);
  fs.writeFileSync(path.join(physical, 'other.test.mjs'), source);
  const required = { file, name: 'required behavior' };
  const contract = run().contract;
  const check = (id, entry, requiredTests = [required]) => ({
    id, argv: [process.execPath, '--test', path.join(cwd, entry)], requiredTests,
  });
  const { checks: [sameFile, otherFile, duplicate] } = await executeCommandChecks({
    cwd, stage: 'checking', contract,
    checks: [check('same', file), check('other', 'other.test.mjs'),
      check('duplicate', file, [required, { ...required, file: path.join(physical, file) }])],
  });
  assert.equal(sameFile.status, 'pass');
  assert.equal(otherFile.environmentError, true);
  assert.match(otherFile.executionGaps[0], /file did not finish/);
  assert.deepEqual(duplicate.executionGaps, ['duplicate required test identity']);
});
test('EVD-04: a synthetic file wrapper cannot satisfy an identically named required case', async t => {
  const argv = nodeTest(t, 'process.exit(0);');
  const file = argv.at(-1);
  const { row } = await execute(t, { argv, requiredTests: [{ file, name: file }] });
  assert.equal(row.exitCode, 0);
  assert.equal(row.runner.summary.success, true);
  assert.deepEqual(row.runner.cases, []);
  assert.equal(row.legitimate, false);
  assert.ok(row.executionGaps.length);
});
test('EVD-04: all declared cases must complete, with optional skips and non-test checks preserved', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; test('first',()=>{}); test('second',()=>{}); test('optional',{skip:true},()=>{});");
  const requiredTests = ['first', 'second'].map(name => ({ file: argv.at(-1), name }));
  const { row } = await execute(t, { argv, requiredTests });
  assert.equal(row.status, 'pass');
  assert.deepEqual(row.executionGaps, []);
  assert.equal(row.runner.cases.filter(c => c.status === 'pass').length, 2);
  assert.equal((await execute(t, { argv: node('process.exit(0)') })).row.status, 'pass');
});
test('EVD-04/08: directly supplied validator checks require their own completed case inventory', async t => {
  const r = run(), cwd = temp(t), name = 'edge.test.mjs';
  fs.writeFileSync(path.join(cwd, name), 'process.exit(0);');
  const result = await executeCommandChecks({ cwd, checks: [], validatorTests: [{ name, hash: 'a'.repeat(64), requiredTests: [{ file: name, name: 'boundary' }] }], stage: 'freshValidation', contract: r.contract });
  assert.equal(result.checks[0].legitimate, false);
  assert.ok(result.checks[0].executionGaps.length);
});

const assertionTampering = {
  strictAssignment: "import assert from 'node:assert/strict'; assert.equal=()=>{};",
  legacyStrictAlias: "import assert from 'node:assert'; assert.strict.equal=()=>{};",
  redefine: "import assert from 'node:assert/strict'; Object.defineProperty(assert,'equal',{value:()=>{}});",
  assertionPrototype: "import assert from 'node:assert/strict'; assert.Assert.prototype.equal=()=>{};",
  runnerReplacement: "import test from 'node:test'; test.it=()=>{};",
  assertionRegistration: "import {assert} from 'node:test'; assert.register('equal',()=>{});",
  namedMock: "import {mock} from 'node:test'; mock.fn(()=>{});",
  namedMockProperty: "import {mock} from 'node:test'; mock.property({},'equal',()=>{});",
  namedSnapshot: "import {snapshot} from 'node:test'; snapshot.setDefaultSnapshotSerializers([()=> 'always equal']);",
  intrinsicMutation: 'Array.prototype.forEach=()=>{};',
  esmHook: "import {registerHooks} from 'node:module'; registerHooks({resolve(){}});",
  builtinEscape: "process.getBuiltinModule('module').registerHooks({resolve(){}});",
  nativeBinding: "process.binding('natives');",
  debugger: "await import('node:inspector');",
};
for (const [name, payload] of Object.entries(assertionTampering)) {
  test(`D07/D10: actual protected executor rejects ${name} rather than approving weakened assertions`, async t => {
    const argv = nodeTest(t, payload + "\nimport {test as check} from 'node:test'; import {strictEqual} from 'node:assert/strict'; check('required behavior',()=>strictEqual(2-3,5));");
    const { row } = await execute(t, { argv });
    assert.equal(row.status, 'fail');
    assert.equal(row.legitimate, false);
    assert.equal(row.environmentError, true);
    assert.ok(row.runner.infrastructure > 0);
  });
}
for (const location of ['collection', 'body', 'hook']) {
  test(`D07/D10: caught assertion tampering during ${location} leaves real failures intact`, async t => {
    const attempt = 'try { assert.equal=()=>{}; } catch {}';
    const argv = nodeTest(t, "import test from 'node:test'; import assert from 'node:assert/strict'; " +
      (location === 'collection' ? attempt : location === 'hook' ? `test.beforeEach(()=>{${attempt}});` : '') +
      `test('required behavior',()=>{${location === 'body' ? attempt : ''} assert.equal(2-3,5);});`);
    const { row } = await execute(t, { argv });
    assert.equal(row.status, 'fail');
    assert.equal(row.legitimate, true, 'immutable assertions still establish meaningful red');
    assert.equal(row.runner.assertions, 1);
    assert.equal(row.runner.infrastructure, 0);
    assert.deepEqual(row.executionGaps, []);
  });
}
test('D07/D10: context assertion tables and prototypes are protected before candidate hooks', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; test.beforeEach(t=>{try{t.assert.equal=()=>{};}catch{} try{Object.defineProperty(Object.getPrototypeOf(t),'assert',{get:()=>({equal(){}})});}catch{}}); test('required behavior',t=>t.assert.equal(1,2));");
  const { row } = await execute(t, { argv });
  assert.equal(row.status, 'fail');
  assert.equal(row.legitimate, true);
  assert.equal(row.runner.assertions, 1);
});
test('D07/D10: successful protected assertions and Node contexts remain usable', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; import assert from 'node:assert/strict'; test('required behavior',async t=>{assert.equal(2+3,5); assert.deepEqual([1,2],[1,2]); assert.throws(()=>assert.fail(),{code:'ERR_ASSERTION'}); await assert.rejects(async()=>assert.fail(),{code:'ERR_ASSERTION'}); t.plan(2); t.assert.equal(4,4); await t.test('nested',()=>assert.equal(1,1));});");
  const { row } = await execute(t, { argv });
  assert.equal(row.status, 'pass');
  assert.equal(row.runner.assertions, 0, 'green requires no assertion failures');
  assert.equal(row.runner.infrastructure, 0);
  assert.ok(row.command.some(arg=>arg.endsWith('/node-check-runtime.mjs')));
});
test('D07/D10: replaced global aliases cannot disable context assertion protection', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; globalThis.Object={getOwnPropertyDescriptor:()=>undefined}; test.beforeEach(t=>{try{t.assert.equal=()=>{};}catch{}}); test('required behavior',t=>t.assert.equal(1,2));");
  const { row } = await execute(t, { argv });
  assert.equal(row.status, 'fail');
  assert.equal(row.legitimate, true);
  assert.equal(row.runner.assertions, 1);
});
test('D07/D10: unsupported preloads, loaders, native flags and Node environments are refused', async t => {
  const argv = nodeTest(t, "import test from 'node:test'; test('required behavior',()=>{});");
  for (const flag of ['--import=./candidate.mjs', '--require=./candidate.cjs', '-r', '--loader=./candidate.mjs', '--expose-internals', '--experimental-test-module-mocks', '--no-frozen-intrinsics', '--inspect=0']) {
    await assert.rejects(execute(t, { argv: [...argv.slice(0, -1), flag, argv.at(-1)] }), /unsupported protected Node check option/);
  }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT']) {
    await assert.rejects(execute(t, { argv, env: { PATH: process.env.PATH, [key]: '--import=./candidate.mjs' } }), /runtime environment overrides unsupported/);
  }
  const file = path.join(temp(t), 'candidate.cjs'); fs.writeFileSync(file, 'module.exports=1;');
  const checked = await execute(t, { argv: nodeTest(t, `import ${JSON.stringify(file)}; import test from 'node:test'; test('required behavior',()=>{});`) });
  assert.equal(checked.row.legitimate, false, 'unsupported CommonJS instrumentation is refused');
});
test('D07/D10/EVD-08: freshly added validator checks use the same immutable assertion runtime', async t => {
  const r = run(), cwd = temp(t), name = 'boundary.test.mjs';
  fs.writeFileSync(path.join(cwd, 'candidate.mjs'), "import assert from 'node:assert/strict'; export function sum(a,b){try{assert.equal=()=>{};}catch{} return a-b;}");
  fs.writeFileSync(path.join(cwd, name), "import {sum} from './candidate.mjs'; import test from 'node:test'; import assert from 'node:assert/strict'; test('nonzero boundary',()=>assert.equal(sum(0,1),1));");
  const checked = await executeCommandChecks({ cwd, checks: [], validatorTests: [{name, hash:'b'.repeat(64), requiredTests:[{file:name,name:'nonzero boundary'}]}], stage:'freshValidation', contract:r.contract });
  assert.equal(checked.exitCode, 1);
  assert.equal(checked.checks[0].status, 'fail');
  assert.equal(checked.checks[0].legitimate, true);
  assert.equal(checked.checks[0].runner.assertions, 1);
  assert.deepEqual(checked.checks[0].executionGaps, []);
});
