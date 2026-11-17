#!/usr/bin/env node
// Opt-in SuperAgent coding entry point. No mode/provider/driver changes and no implicit live adapter.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {CycleService} from '../../app/development-cycle/service.mjs';

export async function cycleCli(argv, env=process.env) {
  const [command, value, ...extra]=argv;
  if(extra.length || !['show','apply','start','step','run','recover-lock'].includes(command)) throw new Error('usage: development-cycle.mjs show | apply REQUEST_ID | start INPUT_JSON | step RUN_ID | run RUN_ID | recover-lock');
  if(!env.AGENTGLIM_DATA || !path.isAbsolute(env.AGENTGLIM_DATA)) throw new Error('set AGENTGLIM_DATA to the resolved private data root');
  let ports=null;
  if(['start','step','run'].includes(command)) {
    if(!env.AGENTGLIM_CYCLE_PORTS || !path.isAbsolute(env.AGENTGLIM_CYCLE_PORTS)) throw new Error('trusted cycle ports are not installed; live enforcement unavailable');
    const module=await import(pathToFileURL(fs.realpathSync(env.AGENTGLIM_CYCLE_PORTS)).href);
    if(module.schemaVersion!==1 || typeof module.createCyclePorts!=='function') throw new Error('unsupported cycle ports interface');
    ports=await module.createCyclePorts({dataRoot:env.AGENTGLIM_DATA});
  }
  const service=new CycleService({dataRoot:env.AGENTGLIM_DATA,ports});
  if(command==='show') return service.view();
  if(command==='apply') return service.store.apply(value);
  if(command==='recover-lock') return service.store.recoverLock();
  if(command==='start') {
    const file=fs.realpathSync(value);if(fs.statSync(file).size>65536)throw new Error('input too large');
    const input=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Object.keys(input.budget?.targets || {}).length) throw new Error('explicit run budget targets required before pilot start; no example defaults');
    return service.start(input);
  }
  if(command==='step') return service.step(value);
  // Productive repair has no arbitrary round limit. Every call rechecks live guards and the shared budget.
  let run;
  do { run=await service.step(value); }
  while(!['PASSED','PASSED_WITH_DEFERRED_FINDINGS','CANCELLED','FAILED_INFRASTRUCTURE'].includes(run.state) && !run.state.startsWith('HELD') && !run.state.startsWith('WAITING') && !run.pause);
  return run;
}
if(process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await cycleCli(process.argv.slice(2)))+'\n'); }
  catch(e) { process.stderr.write(`development-cycle: ${e.message}\n`);process.exitCode=2; }
}
