import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAdapter as setup } from './development-cycle-adapter-fixture.mjs';

const validatorFailures={
 collection:'// cycle-required-tests: ["boundary"]\nprocess.exit(0);',
 execution:'// cycle-required-tests: ["boundary"]\nimport test from "node:test"; test("boundary",()=>process.exit(0));',
 partial:'// cycle-required-tests: ["first","boundary"]\nimport test from "node:test"; await test("first",()=>{}); test("boundary",()=>process.exit(0));',
 skipped:'// cycle-required-tests: ["boundary"]\nimport test from "node:test"; test("boundary",{skip:true},()=>{});',
 missingInventory:'import test from "node:test"; test("boundary",()=>{});',
 invalidInventory:'// cycle-required-tests: []\nimport test from "node:test"; test("boundary",()=>{});',
};
for(const [name,validatorSource] of Object.entries(validatorFailures)) test(`EVD-04/08: selected T3 adapter rejects unexecuted validator case: ${name}`,async t=>{
 const h=setup(t,{selection:{preset:'T3',risk:'ordinary'},validatorSource});let r;
 for(let i=0;i<12;i++){r=await h.controller.step('adapter-run');if(r.state==='PASSED'||r.state.startsWith('HELD')||r.state==='FAILED_INFRASTRUCTURE')break;}
 assert.equal(r.state,name.endsWith('Inventory')?'HELD_UNKNOWN_RESULT':'HELD_EVIDENCE');
 assert.ok(!r.admission?.passed);assert.ok(!r.evidence.some(e=>e.stage==='freshValidation'));
 assert.ok(r.evidence.some(e=>e.stage==='checking'),'core tests passed before fresh validator was rejected');
});
