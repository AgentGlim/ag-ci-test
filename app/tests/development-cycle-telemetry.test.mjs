import test from 'node:test';import assert from 'node:assert/strict';
import {codexTokens,tokenUsageReceipt} from '../development-cycle/telemetry.mjs';
const stream=(usage={input_tokens:100,output_tokens:20,cached_input_tokens:40})=>[JSON.stringify({type:'turn.started'}),JSON.stringify({type:'turn.completed',usage})].join('\n');
test('D30: real per-turn token shape separates cache without double counting cumulative context',()=>{const parsed=codexTokens(stream()+'\n'+stream());assert.deepEqual(parsed.tokens,{input:120,output:40,cacheRead:80,cacheWrite:0});assert.equal(parsed.completedTurns,2);});
for(const input of ['', '{',JSON.stringify({type:'turn.started'}),JSON.stringify({type:'turn.completed',usage:{}}),stream()+'\n'+JSON.stringify({type:'turn.completed',usage:{}}),stream()+'\n'+JSON.stringify({type:'turn.failed'}),stream({input_tokens:10,cached_input_tokens:20,output_tokens:1}),stream({input_tokens:10,output_tokens:1}),stream({input_tokens:-1,cached_input_tokens:0,output_tokens:1})])test(`D30/BUD-07: partial/reset/invalid token stream fails closed (${input.length})`,()=>assert.throws(()=>codexTokens(input)));
test('D30/BUD-02: normalized usage binds a single operation and a versioned price',()=>{const u=tokenUsageReceipt({jsonl:stream(),operationId:'operation-1',provider:'codex',at:100000,price:{model:'fixture-model',version:'fixture-price-v1',source:'operator-config',input:1,output:2,cacheRead:0.1,cacheWrite:1}});assert.equal(u.id,'usage:operation-1');assert.equal(u.complete,true);assert.equal(u.tokens.input,60);assert.equal(u.tokens.cacheRead,40);});

test('F23-R3: adapter authenticates operation-scoped host observations; no built-in live meter fallback',async()=>{
 const {SuperAgentWorkerAdapter,createSealer}=await import('../development-cycle/worker-adapter.mjs');
 const {hash}=await import('../development-cycle/contracts.mjs');
 const adapter=Object.create(SuperAgentWorkerAdapter.prototype);adapter.sealer=createSealer();
 await assert.rejects(()=>adapter.snapshotUsage({runId:'run-1',operationId:'op-1'}),/unavailable/);
 const tokens={input:1,output:0,cacheRead:0,cacheWrite:0},price={model:'fixture',version:'v1',source:'host',input:1,output:1,cacheRead:1,cacheWrite:1};
 adapter.observeUsage=async()=>({provider:'codex',epoch:'epoch-1',sequence:1,at:100000,tokens,price,source:'host',sourceHash:hash(tokens),runId:'wrong',operationId:'wrong'});
 const s=await adapter.snapshotUsage({runId:'run-1',operationId:'op-1'});
 assert.equal(s.runId,'run-1');assert.equal(s.operationId,'op-1');assert.ok(adapter.sealer.verify(s));
 assert.equal(adapter.sealer.verify({...s,tokens:{...tokens,input:100}}),false);
});
