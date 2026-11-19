import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SuperAgentWorkerAdapter } from '../development-cycle/worker-adapter.mjs';
import { CycleStore } from '../development-cycle/store.mjs';
import { CycleController } from '../development-cycle/controller.mjs';
import { hash } from '../development-cycle/contracts.mjs';
import { setupAdapter as setup } from './development-cycle-adapter-fixture.mjs';
import { admit } from '../development-cycle/admission.mjs';

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
