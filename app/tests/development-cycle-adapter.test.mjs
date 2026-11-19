import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SuperAgentWorkerAdapter, manifest } from '../development-cycle/worker-adapter.mjs';
import { setupAdapter as setup } from './development-cycle-adapter-fixture.mjs';
import { admit } from '../development-cycle/admission.mjs';

test('COV-01/SAFE-01: actual worker-launch CLI, tracked fake agent, red/build/green/audit end-to-end',async t=>{const h=setup(t);let r;for(let i=0;i<4;i++)r=await h.controller.step('adapter-run');assert.equal(r.state,'PASSED');assert.equal(h.launches(),2);assert.equal(r.evidence.find(e=>e.stage==='baseline').failureKind,'requirement');assert.ok(r.evidence.every(h.adapter.verifyEvidence));assert.ok(r.events.some(e=>e.type==='dispatch-intent'));assert.match(fs.readFileSync(path.join(h.source,'src/math.mjs'),'utf8'),/a-b/);assert.equal(r.evidence.find(e=>e.stage==='implementation').producer.role,'builder');});
test('COV-01/EVD-05: builder cannot import changes outside approved write scope',async t=>{const h=setup(t,{malicious:true});await h.controller.step('adapter-run');const r=await h.controller.step('adapter-run');assert.equal(r.state,'HELD_UNKNOWN_RESULT');assert.equal(r.candidate,h.contract.base);assert.ok(!r.admission?.passed);});
test('SAFE-01: live external guard blocks actual selected adapter before any role launch',async t=>{const h=setup(t,{guard:false});assert.equal((await h.controller.step('adapter-run')).state,'HELD_PERMISSION');assert.equal(h.launches(),0);});
test('REC-01: adapter restart reconstructs verified content snapshots; mutation fails closed',async t=>{const h=setup(t);await h.controller.step('adapter-run');let r=await h.controller.step('adapter-run');h.adapter.candidateRoots.clear();h.adapter.recover(r.evidence);assert.ok(h.adapter.candidateRoots.has(r.candidate));fs.writeFileSync(path.join(h.adapter.candidateRoots.get(r.candidate),'src/math.mjs'),'changed');assert.throws(()=>h.adapter.recover(r.evidence),/changed/);});
test('EVD-09/SAFE-01: overlapping candidate/private roots and symlinks refused', t => {
 const h = setup(t), config = { ...h.adapter };
 const alias = path.join(h.root, 'alias');
 fs.symlinkSync(h.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
 for (const workspaceRoot of [h.source, alias, path.join(alias, 'new', 'workspace')]) {
  assert.throws(() => new SuperAgentWorkerAdapter({ ...config, workspaceRoot }), /separate/);
 }
 assert.throws(() => new SuperAgentWorkerAdapter({ ...config, evidenceRoot: path.join(alias, 'new', 'evidence') }), /separate/);
 assert.equal(fs.existsSync(path.join(h.source, 'new')), false);
 fs.symlinkSync(path.join(h.source, 'src/math.mjs'), path.join(h.source, 'link'));
 assert.throws(() => manifest(h.source), /symlink/);
});
test('D04/D29/EVD-08/COV-01: critical selected adapter exercises independent bundle and fresh added adversarial tests',async t=>{const h=setup(t,{selection:{preset:'T3',risk:'critical',incident:true}});let r;for(let i=0;i<10;i++){r=await h.controller.step('adapter-run');if(r.state==='PASSED'||r.state.startsWith('HELD')||r.state==='FAILED_INFRASTRUCTURE')break;}assert.equal(r.state,'PASSED',JSON.stringify(r.events.at(-1)));assert.ok(r.evidence.find(e=>e.stage==='testReview').testAuthor.independent);assert.ok(r.evidence.find(e=>e.stage==='freshValidation').adversarialTests.length);assert.ok(r.evidence.find(e=>e.stage==='boundaryFaults'));});
test('EVD-09: unverified independent bundle holds instead of relying on session labels',async t=>{const h=setup(t,{selection:{preset:'T3',risk:'shared'}});h.adapter.verifyTestBundle=()=>false;const r=await h.controller.step('adapter-run');assert.equal(r.state,'HELD_UNKNOWN_RESULT');assert.equal(h.launches(),0);});
test('D04/COV-01: T3 ordinary runs fresh validation and cannot admit without it',async t=>{
 const h=setup(t,{selection:{preset:'T3',risk:'ordinary'}});let r;
 for(let i=0;i<6;i++)r=await h.controller.step('adapter-run');
 assert.equal(r.state,'FRESH_VALIDATION');assert.equal(r.admission,null);
 assert.deepEqual(admit(r,h.adapter.verifyEvidence).gaps,['freshValidation: missing evidence']);
 r=await h.controller.step('adapter-run');assert.equal(r.state,'PASSED');
 assert.ok(r.evidence.find(e=>e.stage==='freshValidation').adversarialTests.length);
 const withoutFresh={...r,evidence:r.evidence.filter(e=>e.stage!=='freshValidation')};
 assert.equal(admit(withoutFresh,h.adapter.verifyEvidence).passed,false);
 assert.deepEqual(admit(withoutFresh,h.adapter.verifyEvidence).gaps,['freshValidation: missing evidence']);
});

for (const selection of [{preset:'T2',risk:'ordinary'},{preset:'T3',risk:'ordinary'},{preset:'T3',risk:'critical',incident:true}]) {
 for (const [when,builderSource] of Object.entries({
  collection:'process.exit(0); export const sum=(a,b)=>a-b;',
  execution:'export const sum=(a,b)=>{process.exit(0); return a-b;};',
 })) test(`EVD-04/COV-01: selected adapter rejects zero exit during ${when}, ${selection.preset}/${selection.risk}`,async t=>{
  const h=setup(t,{selection,builderSource});let r;
  for(let i=0;i<12;i++){r=await h.controller.step('adapter-run');if(r.state==='PASSED'||r.state.startsWith('HELD')||r.state==='FAILED_INFRASTRUCTURE')break;}
  assert.equal(r.state,'FAILED_INFRASTRUCTURE');assert.ok(!r.admission?.passed);
  assert.ok(r.evidence.some(e=>e.stage==='baseline'&&e.failureKind==='requirement'),'real baseline must run before builder bypass');
  assert.ok(r.evidence.find(e=>e.stage==='implementation').environmentError,'invalid builder check remains an infrastructure failure');
  const receipts=fs.readdirSync(path.join(h.root,'data/evidence')).map(d=>path.join(h.root,'data/evidence',d,'receipt.json')).filter(p=>fs.existsSync(p)).map(p=>JSON.parse(fs.readFileSync(p,'utf8')));
  const checks=receipts.find(x=>x.evidence.stage==='implementation').evidence.checks;
  assert.ok(checks.every(c=>!c.legitimate&&c.executionGaps.length));
 });
}

test('EVD-04: selected adapter cannot use a filtered-out core test as baseline',async t=>{
 const h=setup(t,{checkFlags:['--test-name-pattern=absent']});
 const r=await h.controller.step('adapter-run');assert.equal(r.state,'HELD_EVIDENCE');assert.equal(h.launches(),0);
});
