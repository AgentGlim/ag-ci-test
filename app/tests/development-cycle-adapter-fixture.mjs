import fs from 'node:fs';
import path from 'node:path';
import { SuperAgentWorkerAdapter, manifest, executeCommandChecks, createSealer } from '../development-cycle/worker-adapter.mjs';
import { CycleStore } from '../development-cycle/store.mjs';
import { CycleController, createRun } from '../development-cycle/controller.mjs';
import { makeContract, hash } from '../development-cycle/contracts.mjs';
import { temp } from './development-cycle-fixtures.mjs';

function fixtureCommand(root, name, source) {
 const bin = path.join(root, name);
 if (process.platform === 'win32') {
  const script = bin + '.cjs';
  fs.writeFileSync(script, source);
  fs.writeFileSync(bin + '.cmd', `@"${process.execPath}" "${script}" %*\r\n`);
  return { bin: bin + '.cmd', script };
 }
 fs.writeFileSync(bin, '#!/usr/bin/env node\n' + source, {mode:0o755});
 return { bin, script: bin };
}
export function setupAdapter(t,{malicious=false,guard=true,builderSource='export const sum=(a,b)=>a+b;\n',validatorSource=null,checkFlags=[],selection={preset:'T2',risk:'ordinary'}}={}){
 const root=temp(t),source=path.join(root,'source'),workspaces=path.join(root,'roles'),data=path.join(root,'data');fs.mkdirSync(path.join(source,'src'),{recursive:true});fs.mkdirSync(data);
 fs.writeFileSync(path.join(source,'src/math.mjs'),'export const sum=(a,b)=>a-b;\n');fs.writeFileSync(path.join(source,'check.mjs'),"import {sum} from './src/math.mjs'; import test from 'node:test'; import assert from 'node:assert/strict'; test('sum meets contract',()=>{assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1);});\n");
 const fake=fixtureCommand(root,'fixture-codex',`const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),cwd=a[a.indexOf('-C')+1],out=a[a.indexOf('-o')+1];let prompt='';process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{const role=/Coding cycle role: (\\w+)/.exec(prompt)[1];if(role==='builder')fs.writeFileSync(path.join(cwd,${JSON.stringify(malicious?'outside.txt':'src/math.mjs')}),${JSON.stringify(malicious?'outside':builderSource)});if(prompt.includes('Stage: freshValidation')){fs.mkdirSync(path.join(cwd,'validator-tests'),{recursive:true});fs.writeFileSync(path.join(cwd,'validator-tests','edge.test.mjs'),${JSON.stringify(validatorSource || '// cycle-required-tests: ["zero sum boundary"]\nimport {sum} from "../src/math.mjs"; import test from "node:test"; import assert from "node:assert/strict"; test("zero sum boundary",()=>assert.equal(sum(0,0),0));')});}fs.writeFileSync(out,JSON.stringify({findings:[]}));});\n`);
 const tracker=fixtureCommand(root,'fixture-tracker',"process.stdout.write(process.argv[2]==='start'?'fixture-tracked-job\\n':'finished\\n');\n");
 const requiredTests=[{file:'check.mjs',name:'sum meets contract'}];
 const checks=[{id:'behavior',argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests,adversarial:true},{id:'regression',argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests},{id:'reproduction',stages:['failureAnalysis'],argv:[process.execPath,'--test',...checkFlags,'check.mjs'],requiredTests,expectedExitCode:1},{id:'bundle-integrity',stages:['testAuthoring','testReview'],argv:[process.execPath,'--check','check.mjs']}];let launches=0;
 const provenance=createSealer();
 const adapter=new SuperAgentWorkerAdapter({sourceRoot:source,workspaceRoot:workspaces,evidenceRoot:path.join(data,'evidence'),testPaths:['check.mjs'],checks,fixture:true,
  admitLaunch:async({run})=>{launches++;return{allowed:guard,harness:run.harness,model:'fixture-model',modelTier:run.modelTier,tracked:true,gated:true,timeoutSeconds:5,env:{PATH:process.env.PATH,HOME:root,AGENTGLIM_CODEX_BIN:fake.bin,AGENTGLIM_JOBS_TRACK:tracker.bin}};},
  isolate:async()=>({isolatedWorkspace:true,protectedVerdicts:true,protectedTests:true,contractOnly:true,launch:async f=>f()}),executeChecks:executeCommandChecks});
 const testsHash=hash([{name:'check.mjs',hash:manifest(source).entries.find(x=>x.name==='check.mjs').hash}]);
 const contract=makeContract({runId:'adapter-run',taskId:'sum-task',planId:'01-fixture',base:manifest(source,{exclude:['check.mjs']}).hash,writeScope:['src'],testsHash,selection,checks:[{id:'behavior',requirement:'acceptance',criterion:'Sum adds positive operands'},{id:'regression',requirement:'regressions',criterion:'Sum still adds negative operands'}]});
 adapter.testBundle=provenance.seal({testsHash,requirementsHash:hash(contract.checks),authorContext:'fixture-independent-test-author',derivation:'contract-only',protected:true});adapter.verifyTestBundle=provenance.verify;
 const store=new CycleStore(path.join(data,'cycles'));store.create(createRun(contract,100000));
 const ports={clock:()=>100000,guards:async()=>({allowed:guard}),telemetry:async()=>({}),runner:o=>adapter.run(o),terminate:async()=>{},verifyEvidence:adapter.verifyEvidence,verifyApproval:()=>false,eligible:async()=>[],notify:async()=>{}};
 return{root,source,fake:fake.script,ports,adapter,contract,store,controller:new CycleController(store,ports),launches:()=>launches};
}
