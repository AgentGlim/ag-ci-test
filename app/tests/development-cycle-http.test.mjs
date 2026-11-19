import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import path from 'node:path';import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
import { CycleService } from '../development-cycle/service.mjs';import { cycleRoutes } from '../development-cycle/http.mjs';import {waitForServerReady} from './helpers/server-ready.mjs';import {temp,evidence,seal} from './development-cycle-fixtures.mjs';
export async function fixture(t){const home=temp(t);const ports={clock:()=>100000,guards:async()=>({allowed:true}),telemetry:async()=>({}),verifyEvidence:seal.verify,verifyApproval:()=>false,terminate:async()=>{},eligible:async()=>[],notify:async()=>{},runner:async({operation,run})=>({operationId:operation.id,evidence:evidence(run,operation.stage,run.evidence.length+1)})};const service=new CycleService({dataRoot:path.join(home,'data'),ports}),handler=cycleRoutes(service);const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;const post=(suffix,body,headers={})=>fetch(base+'/api/development-cycles'+suffix,{method:'POST',headers:{origin:base,'content-type':'application/json',...headers},body:JSON.stringify(body)});return{base,service,post};}
test('SET-04/COV-01: actual HTTP request, consumer application, runner consumption and readback agree',async t=>{const {base,service,post}=await fixture(t);const pending=await (await post('/settings',{scope:'global',choice:{preset:'T1'},expectedRevision:0})).json();let view=await(await fetch(base+'/api/development-cycles')).json();assert.equal(view.settings.global.preset,'T2');assert.equal(view.requests[0].status,'pending');service.store.apply(pending.id);view=await(await fetch(base+'/api/development-cycles')).json();assert.equal(view.settings.global.preset,'T1');assert.equal(view.requests[0].status,'applied');const r=service.start({runId:'http-run',taskId:'task',planId:'01-fixture',base:'tree',writeScope:['src'],testsHash:'core',classification:{risk:'layout'},checks:[{id:'behavior',requirement:'acceptance',criterion:'Behavior passes'},{id:'regression',requirement:'regressions',criterion:'Existing behavior passes'}]});assert.equal(r.contract.policy.preset,'T1');assert.equal(r.state,'IMPLEMENTING');for(let i=0;i<3;i++)await service.step(r.contract.runId);view=await(await fetch(base+'/api/development-cycles')).json();assert.equal(view.runs[0].state,'PASSED');assert.equal(view.runs[0].settingsRevision,1);});
test('HTTP rejects foreign origins, malformed/oversized/settings conflicts and dispatch injection',async t=>{const {base,post}=await fixture(t);assert.equal((await post('/settings',{choice:{preset:'T1'},expectedRevision:0},{origin:'https://evil.example'})).status,403);assert.equal((await post('/settings',{choice:{preset:'T8'},expectedRevision:0})).status,422);assert.equal((await post('/settings',{choice:{preset:'T1'},expectedRevision:99})).status,409);assert.equal((await post('/settings',{choice:{preset:'T1'},expectedRevision:0,padding:'x'.repeat(20000)})).status,413);for(const path of ['/launch','/approval','/evidence','/apply'])assert.equal((await post(path,{command:['anything'],authority:'owner'})).status,404);assert.equal((await fetch(base+'/api/development-cycles/settings',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{'})).status,400);});
test('HTTP preview and UI assets expose mandatory reasons and keyboard-native controls',async t=>{const {base,post}=await fixture(t);const p=await(await post('/preview',{risk:'critical',choice:{preset:'T3',advanced:{boundaryFaults:false}}})).json();assert.ok(p.requirements.includes('boundaryFaults'));assert.equal(p.preset,'T3');const page=await(await fetch(base+'/development-cycles')).text();assert.match(page,/aria-live="polite"/);assert.match(page,/Request settings change/);assert.match(page,/not yet enforced/);assert.equal((await fetch(base+'/development-cycles.js')).status,200);});
test('Full app mounts cycle surface and dashboard link with private isolated data', async t => {
  const home = temp(t);
  for (const dir of ['data', 'plans', 'run']) fs.mkdirSync(path.join(home, dir));
  fs.writeFileSync(path.join(home, 'env'), '');
  fs.writeFileSync(path.join(home, 'harness.json'), '{}');
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'),
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
      AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_RUN: path.join(home, 'run'),
      AGENTGLIM_DEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', d => errors += d);
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const port = await waitForServerReady(child);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/development-cycles')).status, 200, errors);
    assert.equal((await fetch(base + '/development-cycles.unknown')).status, 404);
    assert.equal((await (await fetch(base + '/api/development-cycles')).json()).settings.global.preset, 'T2');
    assert.match(await (await fetch(base + '/')).text(), /href="\/development-cycles"/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});
