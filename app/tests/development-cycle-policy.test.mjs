import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy } from '../development-cycle/policy.mjs';

test('D01/POL-01: ordinary coding defaults to tests first', () => {
  const p = resolvePolicy();
  assert.equal(p.preset, 'T2');
  assert.ok(p.requirements.includes('testsFirst'));
});
// Explicit specification bundles: do not derive expected values from the implementation registry.
for(const [preset,requirements] of Object.entries({
  T1:['acceptance','regressions','audit'],
  T2:['acceptance','regressions','audit','testsFirst'],
  T3:['acceptance','regressions','audit','testsFirst','independentTests','freshValidation'],
  T4:['acceptance','regressions','audit','failureAnalysis','adversarial','freshValidation'],
  T5:['acceptance','regressions','audit','testsFirst','independentTests','freshValidation','boundaryFaults'],
}))test(`D04/POL-01: ${preset} includes its specified bundle without risk additions`,()=>{
  assert.deepEqual(resolvePolicy({preset,risk:'layout'}).requirements,[...requirements].sort());
});
test('D02/D04/POL-02: critical requirements preserve independent intent', () => {
  const p = resolvePolicy({ preset: 'T3', risk: 'critical' });
  assert.equal(p.preset, 'T3');
  for (const r of ['testsFirst', 'independentTests', 'freshValidation', 'boundaryFaults']) assert.ok(p.requirements.includes(r), r);
});

import { PRESETS, RISKS, COVERAGE, effectiveSettings } from '../development-cycle/policy.mjs';
import { makeContract, verifyContract, hash, canonical, validateBudget, validateSettings, validApproval } from '../development-cycle/contracts.mjs';
import { contract } from './development-cycle-fixtures.mjs';
for(const preset of Object.keys(PRESETS))for(const risk of Object.keys(RISKS))test(`D02/D04/D29/POL-01: ${preset} plus ${risk} resolves deterministically`,()=>{const a=resolvePolicy({preset,risk});assert.deepEqual(a,resolvePolicy({risk,preset}));for(const requirement of RISKS[risk])assert.ok(a.requirements.includes(requirement));assert.equal(a.preset,preset);});
test('D02/POL-03/POL-04: incident union and mandatory controls cannot weaken requirements',()=>{const p=resolvePolicy({preset:'T3',risk:'critical',incident:true,advanced:{testsFirst:false,boundaryFaults:false,method:'build'}});for(const r of ['testsFirst','failureAnalysis','adversarial','independentTests','freshValidation','boundaryFaults'])assert.ok(p.requirements.includes(r),r);});
test('D04: advanced method and verification are independent dimensions',()=>{const p=resolvePolicy({preset:'T2',risk:'layout',advanced:{method:'failureDriven',freshValidation:true}});assert.ok(!p.requirements.includes('testsFirst'));assert.ok(p.requirements.includes('failureAnalysis'));assert.ok(p.requirements.includes('freshValidation'));});
test('D06/D15/POL-06: unresolved classification and noncoding tasks held',()=>{for(const selection of [{risk:'unknown'},{disputed:true},{kind:'research'},{kind:'documentation'},{kind:'planning'}])assert.ok(resolvePolicy(selection).held);assert.equal(resolvePolicy().held,null);});
test('D05/D15/D21/D22/COV-02: honest coding-only coverage',()=>{for(const p of ['worker','driver','headless','manual','featureLoop'])assert.equal(COVERAGE[p],'not yet enforced');assert.equal(COVERAGE.noncoding,'out of scope');assert.match(COVERAGE['superagent-coding-v1'],/live rollout not enabled/);});
test('POL-05: collaboration/model labels never prove assurance',()=>{assert.deepEqual(resolvePolicy({model:'premium',team:5}),resolvePolicy({model:'small',team:1}));});
test('D08/SET-01: global then plan with provenance',()=>{const s={global:{preset:'T2',advanced:{}},plans:{'01-fixture':{preset:'T3'}},revision:4};assert.equal(effectiveSettings(s,'01-fixture').preset,'T3');assert.equal(effectiveSettings(s,'02-other').preset,'T2');assert.equal(effectiveSettings(s,'01-fixture').provenance,'plan:01-fixture');});
test('D08/SET-02: contract is a semantic snapshot',()=>{const input={preset:'T3',risk:'shared'};const c=contract({selection:input});input.preset='T1';assert.equal(c.policy.preset,'T3');verifyContract(c);c.policy.requirements=[];assert.throws(()=>verifyContract(c),/changed/);});
test('MRG-01: schema/version drift fails closed',()=>{const c=contract();c.schemaVersion=7;assert.throws(()=>verifyContract(c));assert.throws(()=>validateSettings({schemaVersion:99}));});
test('Contracts reject unsafe identities, executable settings, duplicate acceptance and undefined content',()=>{for(const runId of ['../escape','__proto__','constructor','a/b'])assert.throws(()=>contract({runId}));assert.throws(()=>makeContract({}));assert.throws(()=>contract({checks:[]}));assert.throws(()=>contract({checks:[{id:'x'},{id:'x'}]}));assert.throws(()=>resolvePolicy({advanced:{shell:'anything'}}));assert.throws(()=>canonical({a:undefined}));assert.equal(hash({b:2,a:1}),hash({a:1,b:2}));});
test('D18/D23: examples are not budget defaults',()=>{assert.deepEqual(validateBudget().targets,{});for(const b of [{targets:{hours:-1}},{targets:{hours:NaN}},{targets:{repairCount:2}},{checkpointGraceMs:100000}])assert.throws(()=>validateBudget(b));});
test('D07/D14/ESC-03: approvals bind identity, revision, scope, authority and expiry',()=>{const c=contract(),now=100000;const a={type:'premiumReview',runId:c.runId,contractHash:c.hash,candidate:'final-tree',scope:'review',decision:'approved',authority:'superagent',reason:'Review blocked goal',at:now-10,expiresAt:now+1000};const options={type:'premiumReview',contract:c,candidate:'final-tree',scope:'review',now,authorities:['superagent']};assert.ok(validApproval(a,options));for(const change of [{runId:'other'},{contractHash:'old'},{candidate:'old'},{scope:'deploy'},{authority:'builder'},{decision:'denied'},{expiresAt:now-1},{at:now+1},{reason:''}])assert.ok(!validApproval({...a,...change},options));});
