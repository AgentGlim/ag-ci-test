import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupAdapter as setup } from './development-cycle-adapter-fixture.mjs';
import { admit } from '../development-cycle/admission.mjs';

for (const selection of [{preset:'T2',risk:'ordinary'},{preset:'T3',risk:'ordinary'},{preset:'T3',risk:'critical',incident:true}]) {
 test(`D07/D10/COV-01: actual selected adapter blocks assertion disabling, ${selection.preset}/${selection.risk}`, async t=>{
  const builderSource='import assert from "node:assert/strict"; assert.equal=()=>{}; export const sum=(a,b)=>a-b;';
  const validatorSource='// cycle-required-tests: ["nonzero boundary"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("nonzero boundary",()=>assert.equal(sum(0,1),1));';
  const h=setup(t,{selection,builderSource,validatorSource});
  const original=fs.readFileSync(path.join(h.source,'check.mjs'),'utf8');let r;
  for(let i=0;i<12;i++){r=await h.controller.step('adapter-run');if(r.state==='PASSED'||r.state.startsWith('HELD')||r.state==='FAILED_INFRASTRUCTURE')break;}
  assert.equal(r.state,'FAILED_INFRASTRUCTURE');assert.ok(!r.admission?.passed);
  const baseline=r.evidence.find(e=>e.stage==='baseline');
  assert.equal(baseline.failureKind,'requirement');assert.ok(baseline.checks.every(c=>c.runner.assertions>0));
  const implementation=r.evidence.find(e=>e.stage==='implementation');
  assert.ok(implementation.environmentError);assert.ok(implementation.checks.every(c=>!c.legitimate&&c.status==='fail'));
  assert.equal(fs.readFileSync(path.join(h.source,'check.mjs'),'utf8'),original);
  assert.equal(admit(r,h.adapter.verifyEvidence).passed,false);
 });
}
for (const selection of [{preset:'T3',risk:'ordinary'},{preset:'T3',risk:'critical',incident:true}]) {
 test(`D07/D10/EVD-08: selected adapter cannot disable a new fresh validator assertion, ${selection.risk}`, async t=>{
  const builderSource='import assert from "node:assert/strict"; export function sum(a,b){if(a===0&&b===1){try{assert.equal=()=>{};}catch{} return a-b;} return a+b;}';
  const validatorSource='// cycle-required-tests: ["nonzero boundary"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("nonzero boundary",()=>assert.equal(sum(0,1),1));';
  const h=setup(t,{selection,builderSource,validatorSource});let r, fresh;
  for(let i=0;i<12;i++){
   r=await h.controller.step('adapter-run');
   const receipts=fs.readdirSync(path.join(h.root,'data/evidence')).map(d=>path.join(h.root,'data/evidence',d,'receipt.json')).filter(p=>fs.existsSync(p)).map(p=>JSON.parse(fs.readFileSync(p,'utf8')));
   fresh=receipts.find(x=>x.evidence.stage==='freshValidation')?.evidence;
   if(fresh||r.state==='PASSED'||r.state.startsWith('HELD')||r.state==='FAILED_INFRASTRUCTURE')break;
  }
  assert.ok(r.evidence.some(e=>e.stage==='checking'&&e.exitCode===0),'core checks pass before the independent added boundary runs');
  assert.ok(fresh,'the actual fresh validator must execute');
  const boundary=fresh.checks.find(c=>c.id.startsWith('adversarial:'));
  assert.equal(boundary.status,'fail');assert.equal(boundary.legitimate,true);
  assert.equal(boundary.runner.assertions,1);assert.deepEqual(boundary.executionGaps,[]);
  assert.notEqual(r.state,'PASSED');assert.ok(!r.admission?.passed);assert.equal(admit(r,h.adapter.verifyEvidence).passed,false);
 });
}
