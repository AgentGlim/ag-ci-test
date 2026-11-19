import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { makeContract } from '../development-cycle/contracts.mjs';
import { hash } from '../development-cycle/contracts.mjs';
import { createRun } from '../development-cycle/controller.mjs';
import { createSealer } from '../development-cycle/worker-adapter.mjs';
export const seal=createSealer();
export const clock=()=>100000;
export function contract(overrides={}){return makeContract({runId:'fixture-run',taskId:'fixture-task',planId:'01-fixture',base:'tree-baseline',writeScope:['src'],testsHash:'core-v1',checks:[{id:'behavior',requirement:'acceptance',criterion:'Returns accepted behavior'},{id:'regression',requirement:'regressions',criterion:'Preserves existing behavior'}],...overrides});}
export function run(overrides={}){return createRun(contract(overrides),clock(),{effort:'medium'});}
const roles={failureAnalysis:'analyst',testAuthoring:'testAuthor',testReview:'testReviewer',baseline:'checker',implementation:'builder',repair:'builder',checking:'checker',audit:'auditor',freshValidation:'validator',adversarial:'validator',boundaryFaults:'validator',extraReview:'extraReviewer'};
export function evidence(r,stage,sequence,overrides={}){
 const validator={name:'validator-tests/fixture.test.mjs',hash:hash('fixture-validator'),requiredTests:[{file:'validator-tests/fixture.test.mjs',name:'negative-permission'}]};
 return seal.seal({schemaVersion:1,runId:r.contract.runId,taskId:r.contract.taskId,contractHash:r.contract.hash,stage,sequence,candidate:r.candidate,testsHash:r.testsHash,status:'complete',findingsHash:hash([]),usageHash:hash(null),actionable:false,started:sequence*10,ended:sequence*10+1,command:['fixture-check'],environment:{fixture:'isolated'},artifacts:[{name:'result',hash:'result-hash'}],producer:{role:roles[stage],context:`${stage}-${sequence}`},controls:{isolatedWorkspace:true,protectedVerdicts:true,protectedTests:true,contractOnly:true,freshContext:true},exitCode:stage==='baseline'?1:0,checks:r.contract.checks.map(c=>({id:c.id,status:stage==='baseline'?'fail':'pass',verified:true,legitimate:true})),failureKind:stage==='baseline'?'requirement':'',baselineRevision:stage==='baseline'?'baseline-tree':'',testAuthor:{independent:true,context:'author-context'},builderContext:'builder-context',adversarialTests:stage==='freshValidation'?[validator]:[],validatorManifest:stage==='freshValidation'?[validator]:[],...overrides,checks:overrides.checks || [...r.contract.checks.map(c=>({id:c.id,status:stage==='baseline'?'fail':'pass',verified:true,legitimate:true})),...(stage==='freshValidation'?[{id:`adversarial:${hash(validator)}`,status:'pass',requiredTests:validator.requiredTests,executionGaps:[]}]:[])]});}
export function complete(overrides={}){const r=run(overrides);r.candidate='final-tree';r.state='ADMISSION';r.evidence=['failureAnalysis','testAuthoring','testReview','baseline','implementation','checking','audit','adversarial','boundaryFaults','freshValidation'].map((s,i)=>evidence(r,s,i+1));return r;}
export function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cycle-'));
  t.after(async () => {
    const archive = process.env.AGENTGLIM_CYCLE_TEST_ARCHIVE || path.join(os.tmpdir(), '_archive');
    fs.mkdirSync(archive, { recursive: true });
    const dest = path.join(archive, `ag-cycle-${crypto.randomUUID()}`);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(root, dest);
        return;
      } catch (error) {
        // Windows can briefly hold a directory open after a spawned process closes.
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
        await delay(50);
      }
    }
  });
  return root;
}
export function finding(overrides={}){return {goalId:'fixture-task',invariant:'behavior',reproduction:'wrong result for fixture input',evidence:['receipt:check'],severity:'HIGH',rationale:'Mandatory behavior failure',state:'open',...overrides};}
