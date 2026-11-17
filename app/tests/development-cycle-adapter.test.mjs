import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import { SuperAgentWorkerAdapter,manifest,executeCommandChecks,createSealer } from '../development-cycle/worker-adapter.mjs';
import { CycleStore } from '../development-cycle/store.mjs';import {CycleController,createRun} from '../development-cycle/controller.mjs';import {makeContract,hash} from '../development-cycle/contracts.mjs';import {temp} from './development-cycle-fixtures.mjs';
import { admit } from '../development-cycle/admission.mjs';
function setup(t,{malicious=false,guard=true,builderSource='export const sum=(a,b)=>a+b;\n',validatorSource=null,checkFlags=[],selection={preset:'T2',risk:'ordinary'}}={}){
 const root=temp(t),source=path.join(root,'source'),workspaces=path.join(root,'roles'),data=path.join(root,'data');fs.mkdirSync(path.join(source,'src'),{recursive:true});fs.mkdirSync(data);
 fs.writeFileSync(path.join(source,'src/math.mjs'),'export const sum=(a,b)=>a-b;\n');fs.writeFileSync(path.join(source,'check.mjs'),"import {sum} from './src/math.mjs'; import test from 'node:test'; import assert from 'node:assert/strict'; test('sum meets contract',()=>{assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1);});\n");
 const fake=path.join(root,'fixture-codex'),tracker=path.join(root,'fixture-tracker');
 fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),cwd=a[a.indexOf('-C')+1],out=a[a.indexOf('-o')+1];let prompt='';process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{const role=/Coding cycle role: (\\w+)/.exec(prompt)[1];if(role==='builder')fs.writeFileSync(path.join(cwd,${JSON.stringify(malicious?'outside.txt':'src/math.mjs')}),${JSON.stringify(malicious?'outside':builderSource)});if(prompt.includes('Stage: freshValidation')){fs.mkdirSync(path.join(cwd,'validator-tests'),{recursive:true});fs.writeFileSync(path.join(cwd,'validator-tests','edge.test.mjs'),${JSON.stringify(validatorSource || '// cycle-required-tests: ["zero sum boundary"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("zero sum boundary",()=>assert.equal(sum(0,0),0));')});}fs.writeFileSync(out,JSON.stringify({findings:[]}));});\n`,{mode:0o755});
 fs.writeFileSync(tracker,"#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]==='start'?'fixture-tracked-job\\n':'finished\\n');\n",{mode:0o755});
 const requiredTests=[{file:'check.mjs',name:'sum meets contract'}];
 const checks=[{id:'behavior',argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests,adversarial:true},{id:'regression',argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests},{id:'reproduction',stages:['failureAnalysis'],argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests,expectedExitCode:1},{id:'bundle-integrity',stages:['testAuthoring','testReview'],argv:[process.execPath,'--check','check.mjs']}];let launches=0;
 const provenance=createSealer();
 const adapter=new SuperAgentWorkerAdapter({sourceRoot:source,workspaceRoot:workspaces,evidenceRoot:path.join(data,'evidence'),testPaths:['check.mjs'],checks,fixture:true,
  admitLaunch:async({run})=>{launches++;return{allowed:guard,harness:run.harness,model:'fixture-model',modelTier:run.modelTier,tracked:true,gated:true,timeoutSeconds:5,env:{PATH:process.env.PATH,HOME:root,AGENTGLIM_CODEX_BIN:fake,AGENTGLIM_JOBS_TRACK:tracker}};},
  isolate:async()=>({isolatedWorkspace:true,protectedVerdicts:true,protectedTests:true,contractOnly:true,launch:async f=>f()}),executeChecks:executeCommandChecks});
 const testsHash=hash([{name:'check.mjs',hash:manifest(source).entries.find(x=>x.name==='check.mjs').hash}]);
 const contract=makeContract({runId:'adapter-run',taskId:'sum-task',planId:'01-fixture',base:manifest(source,{exclude:['check.mjs']}).hash,writeScope:['src'],testsHash,selection,checks:[{id:'behavior',requirement:'acceptance',criterion:'Sum adds positive operands'},{id:'regression',requirement:'regressions',criterion:'Sum still adds negative operands'}]});
 adapter.testBundle=provenance.seal({testsHash,requirementsHash:hash(contract.checks),authorContext:'fixture-independent-test-author',derivation:'contract-only',protected:true});adapter.verifyTestBundle=provenance.verify;
 const store=new CycleStore(path.join(data,'cycles'));store.create(createRun(contract,100000));
 const ports={clock:()=>100000,guards:async()=>({allowed:guard}),telemetry:async()=>({}),runner:o=>adapter.run(o),terminate:async()=>{},verifyEvidence:adapter.verifyEvidence,verifyApproval:()=>false,eligible:async()=>[],notify:async()=>{}};
 return{root,source,fake,ports,adapter,contract,store,controller:new CycleController(store,ports),launches:()=>launches};
}
test('COV-01/SAFE-01: actual worker-launch CLI, tracked fake agent, red/build/green/audit end-to-end',async t=>{const h=setup(t);let r;for(let i=0;i<4;i++)r=await h.controller.step('adapter-run');assert.equal(r.state,'PASSED');assert.equal(h.launches(),2);assert.equal(r.evidence.find(e=>e.stage==='baseline').failureKind,'requirement');assert.ok(r.evidence.every(h.adapter.verifyEvidence));assert.ok(r.events.some(e=>e.type==='dispatch-intent'));assert.match(fs.readFileSync(path.join(h.source,'src/math.mjs'),'utf8'),/a-b/);assert.equal(r.evidence.find(e=>e.stage==='implementation').producer.role,'builder');});
test('COV-01/EVD-05: builder cannot import changes outside approved write scope',async t=>{const h=setup(t,{malicious:true});await h.controller.step('adapter-run');const r=await h.controller.step('adapter-run');assert.equal(r.state,'HELD_UNKNOWN_RESULT');assert.equal(r.candidate,h.contract.base);assert.ok(!r.admission?.passed);});
test('SAFE-01: live external guard blocks actual selected adapter before any role launch',async t=>{const h=setup(t,{guard:false});assert.equal((await h.controller.step('adapter-run')).state,'HELD_PERMISSION');assert.equal(h.launches(),0);});
test('REC-01: adapter restart reconstructs verified content snapshots; mutation fails closed',async t=>{const h=setup(t);await h.controller.step('adapter-run');let r=await h.controller.step('adapter-run');h.adapter.candidateRoots.clear();h.adapter.recover(r.evidence);assert.ok(h.adapter.candidateRoots.has(r.candidate));fs.writeFileSync(path.join(h.adapter.candidateRoots.get(r.candidate),'src/math.mjs'),'changed');assert.throws(()=>h.adapter.recover(r.evidence),/changed/);});
test('EVD-09/SAFE-01: overlapping candidate/private roots and symlinks refused',t=>{const h=setup(t);assert.throws(()=>new SuperAgentWorkerAdapter({sourceRoot:h.source,workspaceRoot:h.source,evidenceRoot:path.join(h.root,'other')}),/separate/);fs.symlinkSync(path.join(h.source,'src/math.mjs'),path.join(h.source,'link'));assert.throws(()=>manifest(h.source),/symlink/);});
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
test('EVD-04: selected adapter cannot use a filtered-out core test as baseline',async t=>{
 const h=setup(t,{checkFlags:['--test-name-pattern=absent']});
 const r=await h.controller.step('adapter-run');assert.equal(r.state,'HELD_EVIDENCE');assert.equal(h.launches(),0);
});

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

test('F23-R1: actual launcher retains failed A through no-op repair, new B, restart and corrected behavior',async t=>{
 const broken='export const sum=(a,b)=>a===0&&b===1?-1:a+b;\n';
 const A='// cycle-required-tests: ["case A"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("case A",()=>assert.equal(sum(0,1),1));';
 const B='// cycle-required-tests: ["case B"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("case B",()=>assert.equal(sum(0,0),0));';
 const h=setup(t,{selection:{preset:'T3',risk:'ordinary'},builderSource:broken,validatorSource:A});let r;
 for(let i=0;i<7;i++)r=await h.controller.step('adapter-run');
 assert.equal(r.state,'REPAIRING');
 const first=r.evidence.at(-1),obligation=first.adversarialTests[0];
 assert.equal(first.stage,'freshValidation');assert.equal(first.checks.find(c=>c.id.startsWith('adversarial:')).status,'fail');
 assert.ok(r.evidence.find(e=>e.stage==='checking').checks.every(c=>c.status==='pass'));
 // Reconstruct both components using only persisted receipts and immutable artifacts.
 const config={...h.adapter};
 const recover=()=>{
  const adapter=new SuperAgentWorkerAdapter(config);
  adapter.recover(h.store.run('adapter-run').evidence);
  const ports={...h.ports,runner:o=>adapter.run(o),verifyEvidence:adapter.verifyEvidence};
  return {adapter,controller:new CycleController(new CycleStore(h.store.root),ports)};
 };
 let restored=recover();
 r=await restored.controller.step('adapter-run');assert.equal(r.state,'CHECKING');assert.equal(r.candidate,first.candidate);
 const repair=r.evidence.at(-1),repairPrompt=fs.readFileSync(path.join(h.root,'data/evidence',repair.producer.context,'prompt.txt'),'utf8');
 assert.match(repairPrompt,/case A/);assert.match(repairPrompt,/Retained validator failures/);assert.match(repairPrompt,/expected/);assert.match(repairPrompt,/actual/);
 // Even an explicitly requested second validation that authors only B cannot erase A.
 fs.writeFileSync(h.fake,fs.readFileSync(h.fake,'utf8').replace(JSON.stringify(A),JSON.stringify(B)).replace("'edge.test.mjs'","'edge-b.test.mjs'"));
 h.store.update('adapter-run',r.revision,s=>{s.state='FRESH_VALIDATION';});
 r=await restored.controller.step('adapter-run');assert.equal(r.state,'REPAIRING');
 const second=r.evidence.at(-1);assert.equal(second.adversarialTests.length,1);assert.equal(second.validatorManifest.length,2);
 assert.ok(second.checks.some(c=>c.id===`adversarial:${hash(obligation)}`&&c.status==='fail'));
 assert.equal(admit(r,restored.adapter.verifyEvidence).passed,false);
 // Removing A from a sealed latest result cannot make admission accept historical failure.
 const {seal:oldSeal,...latest}=second;
 const forgedLatest=restored.adapter.sealer.seal({...latest,exitCode:0,checks:second.checks.filter(c=>c.id!==`adversarial:${hash(obligation)}`),validatorManifest:second.adversarialTests});
 const omitted={...r,state:'ADMISSION',evidence:[...r.evidence.slice(0,-1),forgedLatest]};
 assert.ok(admit(omitted,restored.adapter.verifyEvidence).gaps.some(g=>g.includes('retained validator')));
 restored=recover();
 fs.writeFileSync(h.fake,fs.readFileSync(h.fake,'utf8').replace(JSON.stringify(broken),JSON.stringify('export const sum=(a,b)=>a+b;\n')).replace("'edge-b.test.mjs'","'edge-c.test.mjs'"));
 for(let i=0;i<5;i++){r=await restored.controller.step('adapter-run');if(r.state==='PASSED')break;}
 assert.equal(r.state,'PASSED',JSON.stringify(r.events.at(-1)));
 const final=r.evidence.at(-1);assert.equal(final.validatorManifest.length,3);
 for(const name of ['case A','case B'])assert.ok(final.checks.some(c=>c.status==='pass'&&c.runner?.cases.some(x=>x.name===name&&x.status==='pass')));
 // Host artifact mutation after restart fails closed before any dispatch.
 fs.writeFileSync(path.join(h.root,'data/evidence',first.producer.context,'validator-artifacts',obligation.name),'tampered');
 assert.throws(()=>recover(),/artifact changed/);
});
