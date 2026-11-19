import path from 'node:path';
import { CycleStore } from './store.mjs';
import { effectiveSettings, resolvePolicy, COVERAGE, PRESETS, RISKS } from './policy.mjs';
import { makeContract } from './contracts.mjs';
import { createRun, CycleController } from './controller.mjs';
export class CycleService {
  constructor({ dataRoot, ports = null }) { this.store = new CycleStore(path.join(dataRoot,'development-cycle')); this.controller = ports ? new CycleController(this.store,ports) : null; }
  view() { const s=this.store.read(); return { schemaVersion:1,settings:s.settings,requests:s.requests,coverage:COVERAGE,presets:PRESETS,risks:RISKS,runs:Object.values(s.runs).map(r=>({runId:r.contract.runId,planId:r.contract.planId,state:r.state,candidate:r.candidate,requested:r.contract.policy.preset,effective:r.contract.policy,settingsRevision:r.contract.settingsRevision,evidence:r.evidence,findings:r.findings,budget:r.budget,ledger:r.ledger,pause:r.pause,admission:r.admission,waitingReason:r.pause?.reason||r.state,provenance:r.contract.provenance})) }; }
  preview({planId='',risk='ordinary',incident=false,disputed=false,kind='coding',choice}={}) { const s=this.store.read(); const selection=effectiveSettings(s.settings,planId); return { ...resolvePolicy({...selection,...choice,risk,incident,disputed,kind}),provenance:selection.provenance,settingsRevision:selection.revision,coverage:COVERAGE['superagent-coding-v1'] }; }
  // Trusted SuperAgent entry: HTTP cannot submit a contract, evidence, approval or launch command.
  start(input, options={}) {
    if (!this.controller) throw new Error('cycle runner not installed; live enforcement unavailable');
    for (const key of Object.keys(input.classification || {})) if (!['risk','incident','disputed','kind'].includes(key)) throw new Error('classification cannot override settings or assurance');
    const s=this.store.read(), effective=effectiveSettings(s.settings,input.planId);
    const contract=makeContract({...input,selection:{...effective,...input.classification},settingsRevision:s.settings.revision,provenance:effective.provenance});
    return this.store.create(createRun(contract,this.controller.p.clock(),options));
  }
  async step(runId) { if (!this.controller) throw new Error('cycle runner not installed'); return this.controller.step(runId); }
}
