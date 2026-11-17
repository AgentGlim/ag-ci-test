import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import { CycleStore } from '../development-cycle/store.mjs';
import { CycleController,chooseEscalation,createRun } from '../development-cycle/controller.mjs';
import { account,priceTokens,calibrate,budgetBarrier,consumption,extendBudget } from '../development-cycle/budget.mjs';
import { mergeFindings,progress } from '../development-cycle/findings.mjs';
import { hash } from '../development-cycle/contracts.mjs';
import { CycleService } from '../development-cycle/service.mjs';
import { contract,run,temp,evidence,seal,finding } from './development-cycle-fixtures.mjs';
const price={model:'fixture-model',version:'fixture-v1',source:'fixture-price',input:2,output:10,cacheRead:0.2,cacheWrite:2};
const usage=(overrides={})=>({id:'usage-1',operationId:'op-1',provider:'codex',at:100000,complete:true,tokens:{input:1e6,output:100000,cacheRead:1e6,cacheWrite:0},price,...overrides});
function harness(t,{input={},options={},overrides={},result}={}){const root=temp(t),store=new CycleStore(path.join(root,'data'));let now=100000,calls=0,notes=[];const r=createRun(contract(input),now,options);store.create(r);const ports={clock:()=>now,guards:async()=>({allowed:true}),telemetry:async()=>({usage:{at:now,complete:true,liveAccounting:true,runId:r.contract.runId}}),verifyEvidence:seal.verify,verifyApproval:()=>true,terminate:async()=>{},eligible:async()=>[],notify:async e=>notes.push(e),runner:async({operation,run})=>{calls++;return result?result(operation,run):{operationId:operation.id,evidence:evidence(run,operation.stage,run.evidence.length+1)};},...overrides};return{root,store,ports,controller:new CycleController(store,ports),setTime:v=>now=v,calls:()=>calls,notes};}
test('D08/SET-03/SET-04: settings request/apply/refuse atomic and conflict-safe',t=>{const store=new CycleStore(temp(t));const a=store.request({choice:{preset:'T3'},expectedRevision:0}),b=store.request({choice:{preset:'T4'},expectedRevision:0});assert.equal(store.read().settings.global.preset,'T2');assert.equal(store.apply(a.id).status,'applied');assert.equal(store.apply(b.id).status,'refused');assert.equal(store.read().settings.global.preset,'T3');assert.throws(()=>store.request({choice:{preset:'T1'},expectedRevision:0}),/conflict/);assert.equal(new CycleStore(store.root).read().settings.revision,1);});
test('SET-03: unsafe scope and invalid choices never mutate canonical state',t=>{const s=new CycleStore(temp(t));assert.throws(()=>s.request({scope:'../x',choice:{preset:'T3'},expectedRevision:0}));assert.throws(()=>s.request({choice:{preset:'T8'},expectedRevision:0}));assert.equal(s.read().revision,0);});
test('REC-01: half-write ignored, corrupt committed state refused, lock conflicts do not overwrite',t=>{const s=new CycleStore(temp(t));s.request({choice:{preset:'T2'},expectedRevision:0});fs.writeFileSync(s.file+'.pending-test','{"partial":');assert.equal(s.read().revision,1);fs.mkdirSync(s.lockDir);assert.throws(()=>s.transaction(()=>{}),/busy/);fs.writeFileSync(s.file,'{}');assert.throws(()=>s.read(),/corrupt/);});
test('D18/D30/BUD-01: versioned input/output/cache API-equivalent cost',()=>{assert.equal(priceTokens(usage().tokens,price),3.2);assert.throws(()=>priceTokens({input:2},price));assert.throws(()=>priceTokens(usage().tokens,{...price,version:null}));});
test('D18/D30: exclusive fresh meter pairs learn estimated rate; reset/shared/stale pairs rejected',()=>{const pair={provider:'codex',window:'7d',resetId:'r1',beforeResetId:'r1',exclusive:true,from:90000,to:99000,beforePct:20,afterPct:22,apiEquivalentUsd:4};const rate=calibrate([pair],100000);assert.equal(rate.pointsPerUsd,0.5);assert.equal(rate.estimate,true);for(const bad of [{exclusive:false},{resetId:'r2'},{afterPct:19},{to:1},{apiEquivalentUsd:0}])assert.throws(()=>calibrate([{...pair,...bad}],100000,1000));});
test('D18/BUD-02: one shared leaf ledger, dedup and conflicting wrapper accounting rejected',()=>{const ledger=[];assert.equal(account(ledger,usage()),true);assert.equal(account(ledger,usage()),false);assert.throws(()=>account(ledger,usage({id:'wrapper',wrapper:true})));assert.throws(()=>account(ledger,usage({tokens:{input:2,output:1,cacheRead:0,cacheWrite:0}})));assert.equal(ledger.length,1);});
test('D26/D27/BUD-01/BUD-03: first reached metric pauses with wall-clock hours',()=>{const r=run({budget:{targets:{hours:1,apiEquivalentUsd:100}}});const b=budgetBarrier(r,r.started+3600000,{usage:{at:r.started+3600000,complete:true,liveAccounting:true,runId:r.contract.runId}});assert.ok(b.pause);assert.equal(b.reached[0].metric,'hours');assert.equal(b.totals.hours,1);});
test('D30/BUD-07: missing selected telemetry pauses; unrelated meter percentages not assigned',()=>{const r=run({budget:{targets:{'window:codex:7d':2}}});account(r.ledger,usage());const rate={provider:'codex',window:'7d',resetId:'r1',pointsPerUsd:0.5,at:100000,estimate:true,sourceHash:'source'};const telemetry={usage:{at:100000,runId:r.contract.runId,complete:true,liveAccounting:true},calibrations:{'window:codex:7d':rate},meters:{'window:codex:7d':{at:100000,resetId:'r1',pct:99}}};const b=budgetBarrier(r,100000,telemetry);assert.equal(b.totals['window:codex:7d'],1.6);assert.equal(b.pause,false);assert.ok(budgetBarrier(r,100000,{}).pause);telemetry.meters['window:codex:7d'].resetId='r2';assert.ok(budgetBarrier(r,100000,telemetry).pause);});
test('BUD-07: cumulative cost and window accrual survive provider reset without negative deltas',()=>{const r=run({budget:{targets:{'window:codex:7d':20}}});account(r.ledger,usage());r.windowAccrued['window:codex:7d']={points:4,usd:3.2};const c=consumption(r,100000,{usage:{at:100000,runId:r.contract.runId,complete:true,liveAccounting:true},calibrations:{'window:codex:7d':{provider:'codex',window:'7d',pointsPerUsd:0.1,estimate:true,sourceHash:'source',at:100000,resetId:'r2'}},meters:{'window:codex:7d':{at:100000,resetId:'r2'}}});assert.equal(c.totals['window:codex:7d'],4);assert.equal(c.totals.apiEquivalentUsd,3.2);});
test('D20/BUD-05/BUD-06: extensions preserve consumption and bind authority',()=>{const r=run({budget:{targets:{hours:1},hardCeilings:{hours:3}}});account(r.ledger,usage());let auth;extendBudget(r,{kind:'targets',metric:'hours',value:2},{},(a,o)=>{auth=o.authorities;return true;},100000);assert.deepEqual(auth,['owner','superagent']);assert.equal(r.ledger[0].apiEquivalentUsd,3.2);assert.throws(()=>extendBudget(r,{kind:'targets',metric:'hours',value:4},{},()=>true,100000),/ceiling/);assert.throws(()=>extendBudget(r,{kind:'hardCeilings',metric:'hours',value:4},{},(a,o)=>o.authorities.includes('superagent'),100000),/approval/);});
test('D31: one effort bump only, then alternate; never Max',()=>{const r=run();assert.equal(chooseEscalation(r,[]),'REPAIRING');assert.equal(r.effort,'high');assert.equal(chooseEscalation(r,[]),'WAITING_REVIEW_APPROVAL');assert.throws(()=>createRun(contract(),100000,{effort:'max'}));const high=run();high.effort='xhigh';assert.equal(chooseEscalation(high,[]),'WAITING_REVIEW_APPROVAL');});
test('D13/D28/D32/ESC-01: fixed same-tier alternate map and episode survives rename',()=>{const r=run();r.effort='xhigh';const claude={harness:'claude',modelTier:'standard',subscription:true,allowed:true};assert.equal(chooseEscalation(r,[{...claude,modelTier:'premium'}]),'WAITING_REVIEW_APPROVAL');const s=run();s.effort='xhigh';assert.equal(chooseEscalation(s,[claude]),'REPAIRING');assert.equal(s.harness,'claude');s.findings=[finding({description:'Renamed same problem'})];assert.equal(chooseEscalation(s,[{...claude,harness:'codex'}]),'WAITING_REVIEW_APPROVAL');assert.equal(Object.keys(s.episodes).length,1);});
test('D32: Pi alternate requires Jev and same tier; Claude uses Codex',()=>{const pi=run();pi.harness='pi';pi.effort='xhigh';assert.equal(chooseEscalation(pi,[{harness:'codex',modelTier:'standard',subscription:true,allowed:true,jevApproved:true}]),'REPAIRING');assert.equal(pi.harness,'codex');const c=run();c.harness='claude';c.effort='xhigh';assert.equal(chooseEscalation(c,[{harness:'codex',modelTier:'standard',subscription:true,allowed:true}]),'REPAIRING');});
test('D09/D10: controller performs red, build, check, audit and gate',async t=>{const h=harness(t);let r;for(let i=0;i<4;i++)r=await h.controller.step('fixture-run');assert.equal(r.state,'PASSED');assert.equal(h.calls(),4);assert.ok(r.admission.passed);});
test('D19/BUD-03/BUD-04: productive work still pauses; unrelated runs unaffected; stable outbox',async t=>{const h=harness(t,{input:{budget:{targets:{hours:1}}}});h.store.create(createRun(contract({runId:'other-run'}),100000));h.setTime(3700000);const r=await h.controller.step('fixture-run');assert.equal(r.state,'PAUSED_BUDGET');assert.equal(h.calls(),0);assert.equal(h.notes.length,1);await h.controller.flushNotifications(r.contract.runId);assert.equal(h.notes.length,1);assert.equal(h.store.run('other-run').state,'BASELINE');});
test('REC-01: restart with unknown operation never dispatches twice',async t=>{const h=harness(t);const r=h.store.run('fixture-run');h.store.update('fixture-run',r.revision,s=>s.pendingOperation={id:'unknown',stage:'baseline'});assert.equal((await h.controller.step('fixture-run')).state,'HELD_UNKNOWN_RESULT');assert.equal(h.calls(),0);});
test('REC-03: live owner/provider guards hold affected dispatch',async t=>{const h=harness(t,{overrides:{guards:async()=>({allowed:false,reason:'owner hold'})}});assert.equal((await h.controller.step('fixture-run')).state,'HELD_PERMISSION');assert.equal(h.calls(),0);});
test('D14/ESC-03: absent review skill or approval cannot launch premium',async t=>{const h=harness(t);let r=h.store.run('fixture-run');h.store.update('fixture-run',r.revision,s=>s.state='WAITING_REVIEW_APPROVAL');await assert.rejects(()=>h.controller.approveReview('fixture-run',null,{model:'astra',verified:false}),/unavailable/);await assert.rejects(()=>h.controller.approveReview('fixture-run',null,{model:'astra',entryPoint:'verified-skill',verified:true}),/approval/);assert.equal(h.calls(),0);});
test('D20/REC-02/REC-03: resume checks guards, preserves ledger, invalidates changed candidate evidence',async t=>{const h=harness(t,{input:{budget:{targets:{hours:1},hardCeilings:{hours:4}}}});await h.controller.step('fixture-run');h.setTime(3700000);let r=await h.controller.step('fixture-run');const proposal={kind:'targets',metric:'hours',value:2},approval={type:'budgetExtension',runId:r.contract.runId,contractHash:r.contract.hash,candidate:r.candidate,scope:(await import('../development-cycle/contracts.mjs')).hash(proposal),decision:'approved',authority:'superagent',reason:'Complete acceptance',at:3700000,expiresAt:3800000};r=await h.controller.resume('fixture-run',approval,proposal,{contractHash:r.contract.hash,candidate:'changed-tree',testsHash:r.testsHash});assert.equal(r.state,'CHECKING');assert.equal(r.pause,null);assert.equal(r.evidence.find(e=>e.stage==='baseline').status,'complete');assert.equal(r.budget.targets.hours,2);});

const scopedApproval=(r,type,scope,authority='superagent')=>({type,scope,authority,runId:r.contract.runId,contractHash:r.contract.hash,candidate:r.candidate,decision:'approved',reason:'Fixture scoped approval',at:100000,expiresAt:101000});
async function pausedForCorrection(t,preset='T2') {
  const h=harness(t,{input:{selection:{preset,risk:'ordinary'},budget:{targets:{hours:1},hardCeilings:{hours:4}}}});
  await h.controller.step('fixture-run');
  h.ports.guards=async()=>({allowed:false,reason:'Fixture hold'});
  await h.controller.step('fixture-run');
  h.ports.guards=async()=>({allowed:true});
  return h;
}
for(const preset of ['T2','T3'])for(const extension of [false,true])test(`D07/REC-02: ${preset} ${extension?'extension':'resume'} cannot authorize changed tests`,async t=>{
  const h=await pausedForCorrection(t,preset),before=h.store.run('fixture-run');
  const proposal=extension?{kind:'targets',metric:'hours',value:2}:null;
  const approval=scopedApproval(before,extension?'budgetExtension':'resume',extension?hash(proposal):'resume');
  for(const testsHash of ['unreviewed-weaker-tests',undefined]) {
    await assert.rejects(()=>h.controller.resume('fixture-run',approval,proposal,{contractHash:before.contract.hash,candidate:'changed-tree',testsHash}),/test correction/);
    assert.deepEqual(h.store.run('fixture-run'),before,'rejection must preserve tests, evidence, pause and budget');
  }
  assert.equal(h.calls(),1);
});
for(const preset of ['T2','T3'])test(`D07/EVD-06: ${preset} separate correction authenticates old/new hashes and scope before resume`,async t=>{
  const h=await pausedForCorrection(t,preset),before=h.store.run('fixture-run');
  const correction={oldHash:before.testsHash,newHash:'reviewed-v2',changesContract:false,scope:['core-tests'],reason:'Correct assertion preserving acceptance'};
  const approval=scopedApproval(before,'testCorrection',hash(correction),'independentReviewer');
  for(const bad of [{authority:'superagent'},{scope:'resume'},{candidate:'wrong'},{contractHash:'wrong'},{runId:'wrong'},{expiresAt:99999}]) {
    assert.throws(()=>h.controller.correctTests('fixture-run',correction,{...approval,...bad}),/approval/);
    assert.deepEqual(h.store.run('fixture-run'),before);
  }
  for(const bad of [{oldHash:'other'},{newHash:'unapproved'},{scope:['different-tests']}])assert.throws(()=>h.controller.correctTests('fixture-run',{...correction,...bad},approval),/identity|approval/);
  h.ports.verifyApproval=()=>false;
  assert.throws(()=>h.controller.correctTests('fixture-run',correction,approval),/approval/);
  h.ports.verifyApproval=()=>true;
  let r=h.controller.correctTests('fixture-run',correction,approval);
  assert.equal(r.testsHash,'reviewed-v2');assert.equal(r.contract.testsHash,'core-v1');
  assert.deepEqual(r.testCorrections,[{...correction,approval}]);
  assert.ok(r.evidence.every(e=>e.status==='invalidated'));assert.ok(r.pause);
  assert.equal((await h.controller.step('fixture-run')).state,'HELD_PERMISSION');assert.equal(h.calls(),1);
  r=await h.controller.resume('fixture-run',scopedApproval(r,'resume','resume'),null,{contractHash:r.contract.hash,candidate:'changed-tree',testsHash:r.testsHash});
  assert.equal(r.state,preset==='T3'?'TEST_REVIEW':'BASELINE','changed code cannot skip corrected test review/baseline');
  for(let i=0;i<8&&r.state!=='PASSED';i++)r=await h.controller.step('fixture-run');
  assert.equal(r.state,'PASSED');
  assert.ok(r.evidence.filter(e=>e.status==='complete').every(e=>e.testsHash==='reviewed-v2'));
});
test('D07/EVD-07: owner-approved contract-changing correction cannot resume under the old contract',async t=>{
  const h=await pausedForCorrection(t),before=h.store.run('fixture-run');
  const correction={oldHash:before.testsHash,newHash:'scope-v2',changesContract:true,scope:['acceptance']};
  for(const authority of ['superagent','independentReviewer'])assert.throws(()=>h.controller.correctTests('fixture-run',correction,scopedApproval(before,'scopeChange',hash(correction),authority)),/approval/);
  const r=h.controller.correctTests('fixture-run',correction,scopedApproval(before,'scopeChange',hash(correction),'owner'));
  assert.equal(r.stateBeforePause,'HELD_CONTRACT');
  await assert.rejects(()=>h.controller.resume('fixture-run',scopedApproval(r,'resume','resume'),null,{contractHash:r.contract.hash,candidate:r.candidate,testsHash:r.testsHash}),/new contract/);
  assert.equal(h.calls(),1);
});
for(const preset of ['T2','T3'])test(`D07/EVD-06: ${preset} correction back to the original hash still requires review/baseline`,async t=>{
  const h=await pausedForCorrection(t,preset);let r=h.store.run('fixture-run');
  for(const newHash of ['reviewed-v2','core-v1']) {
    const correction={oldHash:r.testsHash,newHash,changesContract:false,scope:['core-tests']};
    r=h.controller.correctTests('fixture-run',correction,scopedApproval(r,'testCorrection',hash(correction),'independentReviewer'));
  }
  assert.equal(r.testsHash,r.pause.testsHash);assert.equal(r.testCorrections.length,2);
  r=await h.controller.resume('fixture-run',scopedApproval(r,'resume','resume'),null,{contractHash:r.contract.hash,candidate:'changed-tree',testsHash:r.testsHash});
  assert.equal(r.state,preset==='T3'?'TEST_REVIEW':'BASELINE');
  assert.ok(r.evidence.every(e=>e.status==='invalidated'));
});
test('D03/D08/SET-04: selected service consumes applied setting; active run remains pinned',t=>{const root=temp(t),ports={clock:()=>100000,guards:async()=>({allowed:true}),telemetry:async()=>({}),runner:async()=>{},eligible:async()=>[],notify:async()=>{},verifyEvidence:()=>false,verifyApproval:()=>false,terminate:async()=>{}};const svc=new CycleService({dataRoot:root,ports});const request=svc.store.request({choice:{preset:'T3'},expectedRevision:0});assert.equal(svc.preview().preset,'T2');svc.store.apply(request.id);const input={runId:'selected',taskId:'task',planId:'01-fixture',base:'tree',testsHash:'tests',writeScope:['src'],checks:[{id:'behavior',requirement:'acceptance',criterion:'Behavior passes'},{id:'regression',requirement:'regressions',criterion:'Existing behavior passes'}]};const r=svc.start(input);assert.equal(r.contract.policy.preset,'T3');const q=svc.store.request({choice:{preset:'T1'},expectedRevision:1});svc.store.apply(q.id);assert.equal(svc.preview().preset,'T1');assert.equal(svc.store.run('selected').contract.policy.preset,'T3');});
test('EVD-03: result envelope cannot alter findings outside sealed evidence',async t=>{const h=harness(t,{result:(op,r)=>({operationId:op.id,evidence:evidence(r,op.stage,1),findings:[finding({state:'resolved',resolution:{verified:true,evidence:['forged']}})]})});const r=await h.controller.step('fixture-run');assert.equal(r.state,'HELD_EVIDENCE');});
test('EVD-02/EVD-09: malformed independent review is refused before implementation',async t=>{const h=harness(t,{input:{selection:{preset:'T3',risk:'shared'}},result:(op,r)=>({operationId:op.id,evidence:evidence(r,op.stage,r.evidence.length+1,op.stage==='testReview'?{controls:{isolatedWorkspace:true,protectedVerdicts:true,protectedTests:false,contractOnly:false}}:{})})});await h.controller.step('fixture-run');const r=await h.controller.step('fixture-run');assert.equal(r.state,'HELD_EVIDENCE');assert.equal(h.calls(),2);});
test('AUD-08: renamed/reproduced wording is not a genuinely new issue',()=>{const a=(finding({reproduction:'first wording'})),b=(finding({reproduction:'renamed wording'}));const before=mergeFindings([],[a]),after=mergeFindings(before,[b]);assert.equal(after.length,1);assert.equal(progress(before,after).D,false);});
test('D19/BUD-08: bounded checkpoint timeout records partial unknown and requests supported termination',async t=>{let terminated=false,h;h=harness(t,{input:{budget:{targets:{hours:1},checkpointGraceMs:5}},overrides:{terminate:async()=>{terminated=true;},runner:async()=>{h.setTime(3700000);return new Promise(()=>{});}}});const r=await h.controller.step('fixture-run');assert.equal(r.state,'PAUSED_BUDGET');assert.ok(r.pendingOperation);assert.ok(r.events.some(e=>e.type==='termination-requested'));assert.ok(terminated);assert.equal(h.notes.length,1);await assert.rejects(()=>h.controller.resume('fixture-run',{},null,{contractHash:r.contract.hash}),/reconciliation/);});
test('D12/D14: diagnostic discovery after an alternate does not trigger premium escalation',()=>{const r=run();r.effort='xhigh';chooseEscalation(r,[{harness:'claude',modelTier:'standard',subscription:true,allowed:true}]);r.progress={R:false,C:false,D:true,fullyStalled:false,repairStalled:true};assert.equal(chooseEscalation(r,[]),'REPAIRING');r.progress={R:false,C:false,D:false,fullyStalled:true,repairStalled:true};assert.equal(chooseEscalation(r,[]),'WAITING_REVIEW_APPROVAL');});
test('D14/ESC-04: valid premium permission cannot override a reached target',async t=>{const h=harness(t,{input:{budget:{targets:{hours:1}}}});let r=h.store.run('fixture-run');h.store.update('fixture-run',r.revision,s=>s.state='WAITING_REVIEW_APPROVAL');h.setTime(3700000);const skill={model:'astra',entryPoint:'verified-installed-skill',verified:true};const {hash}=await import('../development-cycle/contracts.mjs');const a={type:'premiumReview',runId:r.contract.runId,contractHash:r.contract.hash,candidate:r.candidate,scope:hash(skill),decision:'approved',authority:'superagent',reason:'Review blocked repair',at:3700000,expiresAt:3800000};r=await h.controller.approveReview('fixture-run',a,skill);assert.equal(r.state,'PAUSED_BUDGET');assert.equal(h.calls(),0);});
test('D09: more than two productive repair loops do not stop at a count',async t=>{let audits=0;const h=harness(t,{result:(op,r)=>{const overrides={};let findings=[];if(op.stage==='audit'&&audits++<4)findings=[...r.findings.map(f=>({...f,state:'resolved',resolution:{verified:true,evidence:['trusted:resolved']}})),finding({invariant:`issue-${audits}`})];if(op.stage==='audit'&&audits>=5)findings=r.findings.map(f=>({...f,state:'resolved',resolution:{verified:true,evidence:['trusted:resolved']}}));return {operationId:op.id,evidence:evidence(r,op.stage,r.evidence.length+1,{...overrides,findingsHash:hash(findings)}),findings};}});let r;for(let i=0;i<20;i++){r=await h.controller.step('fixture-run');if(r.state==='PASSED')break;}assert.equal(r.state,'PASSED');assert.ok(audits>2);});

for (const stage of ['baseline','implementation','repair']) test(`F23-R2: paused ${stage} reconciliation persists its continuation across restart without replay`,async t=>{
 const h=harness(t);let r=h.store.run('fixture-run'),operation={id:`paused-${stage}`,stage};
 h.store.update(r.contract.runId,r.revision,s=>{s.pendingOperation=operation;s.state=stage==='baseline'?'BASELINE':stage==='repair'?'REPAIRING':'IMPLEMENTING';});
 r=await h.controller.pause(h.store.run('fixture-run'),{held:true,guards:{reason:'owner hold'},budget:{}});
 const receipt={operationId:operation.id,evidence:evidence(r,stage,1)};
 r=h.controller.reconcile('fixture-run',operation.id,receipt);
 assert.equal(r.state,'HELD_PERMISSION');assert.ok(r.pause);
 assert.equal(r.stateBeforePause,stage==='baseline'?'IMPLEMENTING':'CHECKING');
 assert.equal(r.pendingOperation,null);assert.equal(r.evidence.length,1);
 assert.throws(()=>h.controller.reconcile('fixture-run',operation.id,receipt),/reconciliation/);
 assert.deepEqual(h.store.run('fixture-run'),r,'duplicate receipt changes neither evidence nor usage');
 const restarted=new CycleController(new CycleStore(h.store.root),h.ports),identities={candidate:r.candidate,testsHash:r.testsHash,contractHash:r.contract.hash};
 h.ports.guards=async()=>({allowed:false,reason:'owner hold'});
 assert.ok((await restarted.resume('fixture-run',scopedApproval(r,'resume','resume'),null,identities)).pause);
 await assert.rejects(()=>restarted.resume('fixture-run',null,null,identities),/approval/);
 h.ports.guards=async()=>({allowed:true});
 r=await restarted.resume('fixture-run',scopedApproval(r,'resume','resume'),null,identities);
 assert.equal(r.pause,null);assert.equal(r.state,stage==='baseline'?'IMPLEMENTING':'CHECKING');
 r=await restarted.step('fixture-run');
 assert.equal(r.evidence.at(-1).stage,stage==='baseline'?'implementation':'checking');
 assert.equal(r.evidence.filter(e=>e.stage===stage).length,1);
});
