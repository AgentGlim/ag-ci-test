import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {CycleController,createRun} from '../development-cycle/controller.mjs';
import {CycleStore} from '../development-cycle/store.mjs';
import {recordUsageSnapshot,settleUsage,consumption,budgetBarrier} from '../development-cycle/budget.mjs';
import {cumulativeUsageSnapshot} from '../development-cycle/telemetry.mjs';
import {contract,run,temp,evidence,seal} from './development-cycle-fixtures.mjs';
import {hash} from '../development-cycle/contracts.mjs';
const price={model:'fixture',version:'v1',source:'host-meter',input:1,output:1,cacheRead:1,cacheWrite:1};
const tokens=usd=>({input:usd*1e6,output:0,cacheRead:0,cacheWrite:0});
const snapshot=(r,usd,extra={})=>seal.seal(cumulativeUsageSnapshot({runId:r.contract.runId,operationId:r.pendingOperation.id,provider:'codex',epoch:'op-meter-1',sequence:1,at:100000,tokens:tokens(usd),price,source:'fixture-host',sourceHash:hash(tokens(usd)),...extra}));
const telemetry=(now=100000)=>({usage:{at:now,runId:'fixture-run',complete:true,liveAccounting:true}});
const final=(r,usd)=>({id:`usage:${r.pendingOperation.id}`,operationId:r.pendingOperation.id,provider:'codex',at:100000,complete:true,tokens:tokens(usd),price});
function activeRun(){const r=run({budget:{targets:{apiEquivalentUsd:10}}});r.pendingOperation={id:'fixture-op',stage:'implementation'};return r;}

for (const metric of ['apiEquivalentUsd','window:codex:7d']) test(`F23-R3: pending worker crosses ${metric}, bounded abort, restart, final receipt counted exactly once`,async t=>{
 const store=new CycleStore(temp(t)),initial=createRun(contract({budget:{targets:{[metric]:2},checkpointGraceMs:5}}),100000);initial.state='IMPLEMENTING';store.create(initial);
 store.create(createRun(contract({runId:'other-run'}),100000));let started=0,aborted=false,terminated=false,operation;
 const liveTelemetry=()=>({...telemetry(),calibrations:{[metric]:{provider:'codex',window:'7d',resetId:'r1',pointsPerUsd:1,estimate:true,at:100000,sourceHash:'fixture-calibration'}},meters:{[metric]:{resetId:'r1',at:100000}}});
 const ports={clock:()=>100000,guards:async()=>({allowed:true}),telemetry:async(c,{operation:op})=>({...liveTelemetry(),...(op?{activeUsage:snapshot({...store.run(c.runId),pendingOperation:op},3)}:{})}),
  verifyUsage:seal.verify,verifyEvidence:seal.verify,verifyApproval:()=>true,notify:async()=>{},eligible:async()=>[],terminate:async()=>{terminated=true;},
  runner:async({operation:op,signal})=>{started++;operation=op;signal.addEventListener('abort',()=>aborted=true,{once:true});return new Promise(()=>{});}};
 let controller=new CycleController(store,ports);const start=performance.now();let r=await controller.step('fixture-run');
 assert.ok(performance.now()-start<500,'fixture abort is bounded before completion');
 assert.equal(started,1);assert.ok(aborted);assert.ok(terminated);assert.equal(r.state,'PAUSED_BUDGET');assert.ok(r.pendingOperation);assert.ok(r.pause.reason.reached.some(x=>x.metric===metric));
 assert.equal(r.ledger.length,0);assert.equal(consumption(r,100000,telemetry()).totals.apiEquivalentUsd,3);
 assert.equal(store.run('other-run').evidence.length,0);assert.equal(store.run('other-run').state,'BASELINE');
 controller=new CycleController(new CycleStore(store.root),ports);
 assert.equal((await controller.step('fixture-run')).state,'PAUSED_BUDGET');assert.equal(started,1);
 const usage=final(r,4),receipt={operationId:operation.id,usage,evidence:evidence(r,operation.stage,1,{usageHash:hash(usage)})};
 r=controller.reconcile('fixture-run',operation.id,receipt);
 assert.equal(r.state,'PAUSED_BUDGET');assert.equal(r.stateBeforePause,'CHECKING');assert.equal(r.ledger.length,1);
 assert.equal(consumption(r,100000,telemetry()).totals.apiEquivalentUsd,4);
 assert.throws(()=>controller.reconcile('fixture-run',operation.id,receipt),/reconciliation/);
 assert.equal(store.run('fixture-run').ledger.length,1);assert.equal(started,1);
 assert.equal(budgetBarrier(r,100000,telemetry()).pause,true);
});

test('F23-R3: snapshot authentication, duplicates, reset, provider/operation/run identity and price are enforced',()=>{
 const r=activeRun(),first=snapshot(r,1);
 assert.equal(recordUsageSnapshot(r,first,seal.verify,100000),true);
 assert.equal(recordUsageSnapshot(r,first,seal.verify,100000),false);
 for(const changes of [{tokens:tokens(0.5),sequence:2},{epoch:'reset',sequence:2},{provider:'claude',sequence:2},{sequence:0},{operationId:'other-op'},{runId:'other-run'},{at:100001},{price:{...price,version:'v2'},sequence:2},{tokens:tokens(2)}]) {
  const bad=seal.seal({...first,...changes});
  assert.throws(()=>recordUsageSnapshot(r,bad,seal.verify,100000));assert.deepEqual(r.operationUsage['fixture-op'],first);
 }
 assert.throws(()=>recordUsageSnapshot(r,{...first,sequence:2},seal.verify,100000),/untrusted/);
 assert.equal(recordUsageSnapshot(r,snapshot(r,2,{sequence:2}),seal.verify,100000),true);
 assert.throws(()=>settleUsage(r,final(r,1)),/below observed/);
 assert.throws(()=>settleUsage(r,{...final(r,3),provider:'claude'}),/below observed/);
 assert.equal(settleUsage(r,final(r,3)),true);assert.equal(settleUsage(r,final(r,3)),false);
 assert.equal(consumption(r,100000,telemetry()).totals.apiEquivalentUsd,3);
});

test('F23-R3: missing/stale active accounting holds while wall-time-only runs remain supported',async t=>{
 for(const variant of ['missing-capability','missing-verifier','missing-snapshot','stale','untrusted']) {
  const store=new CycleStore(temp(t));const r=activeRun();
  if(['missing-capability','missing-verifier'].includes(variant))r.pendingOperation=null;
  if(variant==='stale')recordUsageSnapshot(r,snapshot(r,1),seal.verify,100000);
  store.create(r);let calls=0;
  const ports={clock:()=>300001,guards:async()=>({allowed:true}),telemetry:async()=>({...telemetry(300001),...(variant==='missing-capability'?{usage:{at:300001,runId:r.contract.runId,complete:true}}:{}),...(variant==='untrusted'?{activeUsage:{...snapshot(r,20),seal:'0'.repeat(64)}}:{})}),
   verifyUsage:variant==='missing-verifier'?undefined:seal.verify,verifyEvidence:seal.verify,verifyApproval:()=>false,runner:async()=>{calls++;},terminate:async()=>{},eligible:async()=>[],notify:async()=>{}};
  const controller=new CycleController(store,ports),b=await controller.barrier(r);
  assert.equal(b.budget.pause,true,variant);assert.equal(calls,0);
  if(!r.pendingOperation)assert.equal((await controller.step(r.contract.runId)).state,'PAUSED_BUDGET');
 }
 const hours=run({budget:{targets:{hours:1}}});hours.pendingOperation={id:'hours-only',stage:'implementation'};
 assert.equal(budgetBarrier(hours,100000,{}).pause,false);
});

test('F23-R3: active consumption and calibrated window accrual survive reset, cancellation and final settlement',async t=>{
 const r=activeRun();r.budget.targets={'window:codex:7d':2};
 recordUsageSnapshot(r,snapshot(r,3),seal.verify,100000);
 const metric='window:codex:7d',meters=reset=>({...telemetry(),calibrations:{[metric]:{provider:'codex',window:'7d',resetId:reset,pointsPerUsd:1,estimate:true,at:100000,sourceHash:'fixture-calibration'}},meters:{[metric]:{at:100000,resetId:reset}}});
 const b=budgetBarrier(r,100000,meters('reset-1'));assert.equal(b.pause,true);assert.equal(b.totals[metric],3);
 const store=new CycleStore(temp(t));store.create(r);const controller=new CycleController(store,{clock:()=>100000,guards:async()=>({}),telemetry:async()=>({}),runner:async()=>{},terminate:async()=>{},verifyEvidence:()=>false,verifyApproval:()=>false,eligible:async()=>[],notify:async()=>{}});
 controller.accrueWindows(r,b);
 settleUsage(r,final(r,4));r.pendingOperation=null;r.state='CANCELLED';
 assert.equal(consumption(r,100000,meters('reset-2')).totals[metric],4);
 assert.equal(consumption(r,100000,meters('reset-2')).totals.apiEquivalentUsd,4);
 assert.equal(budgetBarrier(r,300001,meters('reset-2')).pause,true,'stale calibration fails closed');
});

test('F23-R3: authenticated final consumption persists even when workflow evidence is rejected',t=>{
 const r=activeRun();recordUsageSnapshot(r,snapshot(r,1),seal.verify,100000);
 const store=new CycleStore(temp(t));store.create(r);
 const ports={clock:()=>100000,guards:async()=>({allowed:true}),telemetry:async()=>telemetry(),verifyUsage:seal.verify,verifyEvidence:seal.verify,verifyApproval:()=>false,runner:async()=>{},terminate:async()=>{},eligible:async()=>[],notify:async()=>{}};
 const controller=new CycleController(store,ports),usage=final(r,2),receipt={operationId:r.pendingOperation.id,usage,evidence:evidence(r,'implementation',99,{usageHash:hash(usage)})};
 const rejected=controller.reconcile(r.contract.runId,r.pendingOperation.id,receipt);
 assert.equal(rejected.state,'HELD_EVIDENCE');assert.equal(rejected.evidence.length,0);
 assert.equal(consumption(rejected,100000,telemetry()).totals.apiEquivalentUsd,2);
});

test('F23-R3: an unavailable meter times out and pauses a pending operation',async t=>{
 const store=new CycleStore(temp(t)),r=activeRun();r.pendingOperation=null;r.state='IMPLEMENTING';r.budget.checkpointGraceMs=5;store.create(r);
 let calls=0,aborted=false;
 const ports={clock:()=>100000,guards:async()=>({allowed:true}),telemetry:async(c,{operation})=>operation?new Promise(()=>{}):telemetry(),verifyUsage:seal.verify,verifyEvidence:seal.verify,verifyApproval:()=>false,notify:async()=>{},eligible:async()=>[],terminate:async()=>{},runner:async({signal})=>{calls++;signal.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});}};
 const start=performance.now(),paused=await new CycleController(store,ports).step(r.contract.runId);
 assert.ok(performance.now()-start<500);assert.equal(calls,1);assert.ok(aborted);assert.equal(paused.state,'PAUSED_BUDGET');assert.ok(paused.pendingOperation);
 assert.ok(paused.pause.reason.errors.some(e=>e.includes('unavailable')));
});
