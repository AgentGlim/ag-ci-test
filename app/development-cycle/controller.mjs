import crypto from 'node:crypto';
import { verifyContract, validApproval, hash } from './contracts.mjs';
import { admit } from './admission.mjs';
import { evidenceGaps, correctTests } from './evidence.mjs';
import { mergeFindings, findingGaps, progress } from './findings.mjs';
import { budgetBarrier, settleUsage, recordUsageSnapshot, needsLiveUsage, extendBudget } from './budget.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const STAGES = Object.freeze({
  FAILURE_ANALYSIS: 'failureAnalysis', TEST_AUTHORING: 'testAuthoring', TEST_REVIEW: 'testReview', BASELINE: 'baseline',
  IMPLEMENTING: 'implementation', REPAIRING: 'repair', CHECKING: 'checking', AUDITING: 'audit',
  ADVERSARIAL: 'adversarial', BOUNDARY_FAULTS: 'boundaryFaults', FRESH_VALIDATION: 'freshValidation', EXTRA_REVIEW: 'extraReview',
});
const TERMINAL = new Set(['PASSED', 'PASSED_WITH_DEFERRED_FINDINGS', 'CANCELLED']);
export function createRun(contract, now, { harness = 'codex', modelTier = 'standard', effort = 'medium' } = {}) {
  verifyContract(contract); if (!EFFORTS.includes(effort)) throw new Error('effort must be low/medium/high/xhigh; never Max');
  if (!['codex', 'claude', 'pi'].includes(harness)) throw new Error('unsupported harness');
  const req = contract.policy.requirements;
  return { schemaVersion: 1, revision: 0, contract: structuredClone(contract), candidate: contract.base, testsHash: contract.testsHash,
    state: contract.policy.held ? 'HELD_CLASSIFICATION' : req.includes('failureAnalysis') ? 'FAILURE_ANALYSIS' : req.includes('independentTests') ? 'TEST_AUTHORING' : req.includes('testsFirst') ? 'BASELINE' : 'IMPLEMENTING',
    started: now, harness, modelTier, effort, findings: [], evidence: [], checks: [], ledger: [], budget: structuredClone(contract.budget), windowAccrued: {},
    extensions: [], events: [], notifications: [], episodes: {}, pendingOperation: null, pause: null, admission: null };
}
export function chooseEscalation(run, eligible) {
  const goal = run.contract.repairGoal;
  const episode = run.episodes[goal] ||= { goal, effortTried: false, alternateTried: false, history: [] };
  if (!episode.effortTried && run.effort !== 'xhigh') {
    episode.effortTried = true; run.effort = EFFORTS[EFFORTS.indexOf(run.effort) + 1]; episode.history.push({ type: 'effort', effort: run.effort }); return 'REPAIRING';
  }
  episode.effortTried = true;
  if (!episode.alternateTried) {
    episode.alternateTried = true;
    const allowed = run.harness === 'codex' ? ['claude'] : run.harness === 'claude' ? ['codex'] : ['codex', 'claude'];
    const pick = eligible.find(x => allowed.includes(x.harness) && x.modelTier === run.modelTier && x.subscription === true && x.allowed === true && (run.harness !== 'pi' || x.jevApproved));
    episode.history.push({ type: 'alternate', pick: pick || null });
    if (pick) { run.harness = pick.harness; return 'REPAIRING'; }
  }
  const actualAlternate = episode.history.some(e => e.type === 'alternate' && e.pick);
  if (actualAlternate && run.progress?.D && !run.progress.fullyStalled) return 'REPAIRING';
  return 'WAITING_REVIEW_APPROVAL';
}
export class CycleController {
  constructor(store, ports) {
    for (const p of ['clock', 'guards', 'telemetry', 'runner', 'terminate', 'verifyEvidence', 'eligible', 'notify', 'verifyApproval']) if (typeof ports[p] !== 'function') throw new Error(`missing trusted port ${p}`);
    this.store = store; this.p = ports;
  }
  approval(run, approval, options) {
    return this.p.verifyApproval(approval) && validApproval(approval, { ...options, contract: run.contract, candidate: run.candidate });
  }
  async barrier(run) {
    const guards = await this.p.guards(run.contract);
    let telemetry = {}, accountingError = null, timeout;
    try {
      telemetry = await Promise.race([
        this.p.telemetry(run.contract, {operation:run.pendingOperation}),
        new Promise((_,reject)=>{ timeout=setTimeout(()=>reject(new Error('usage telemetry unavailable')),Math.min(1000,run.budget.checkpointGraceMs)); }),
      ]) || {};
    } catch (e) { accountingError = e.message; }
    finally { clearTimeout(timeout); }
    // Telemetry is read through a trusted port; snapshot authenticity is separately
    // verified before any durable accounting or comparison. Unknown inputs hold.
    run = this.store.run(run.contract.runId);
    if (needsLiveUsage(run) && typeof this.p.verifyUsage !== 'function') accountingError = 'authenticated active usage accounting unavailable';
    if (telemetry.activeUsage) {
      try {
        run = this.store.update(run.contract.runId, run.revision, r => recordUsageSnapshot(r,telemetry.activeUsage,this.p.verifyUsage,this.p.clock()));
      } catch (e) { accountingError = e.message; }
    }
    const budget = budgetBarrier(run, this.p.clock(), telemetry);
    if (accountingError) { budget.errors.push(accountingError); budget.pause = true; }
    // Accrue at every observation, so a reset/handoff cannot reprice prior work.
    if (Object.keys(budget.estimates).length) this.store.update(run.contract.runId,run.revision,r=>this.accrueWindows(r,budget));
    return { guards, budget, held: guards.allowed !== true, telemetry };
  }
  async pause(run, barrier, pausing = false) {
    run = this.store.run(run.contract.runId);
    let paused = this.store.update(run.contract.runId, run.revision, r => {
      if (!r.pause || !['PAUSING','PAUSED_BUDGET','HELD_PERMISSION'].includes(r.state)) r.stateBeforePause = r.state;
      r.state = pausing ? 'PAUSING' : barrier.held ? 'HELD_PERMISSION' : 'PAUSED_BUDGET'; r.liveHold = barrier.held;
      const alreadyPaused = !!r.pause;
      r.pause = { at: this.p.clock(), reason: barrier.held ? guardsReason(barrier.guards) : barrier.budget, candidate: r.candidate, testsHash: r.testsHash, contractHash: r.contract.hash };
      this.accrueWindows(r, barrier.budget);
      if (alreadyPaused) return;
      const event = { id: `${r.contract.runId}:pause:${r.revision}`, type: 'cycle-paused', runId: r.contract.runId, candidate: r.candidate, reason: r.pause.reason, delivered: false };
      r.notifications.push(event); r.events.push({ type: 'pause', at: this.p.clock(), reason: r.pause.reason });
    });
    await this.flushNotifications(paused.contract.runId); return this.store.run(paused.contract.runId);
  }
  async flushNotifications(runId) {
    for (const event of this.store.run(runId).notifications.filter(x => !x.delivered)) {
      try { await this.p.notify(event); const r = this.store.run(runId); this.store.update(runId, r.revision, s => { s.notifications.find(x => x.id === event.id).delivered = true; }); }
      catch { /* Durable outbox; retry with same id, never spawn a session to notify. */ }
    }
  }
  async step(runId) {
    let run = this.store.run(runId);
    if (TERMINAL.has(run.state) || run.pause || run.state.startsWith('HELD') || run.state.startsWith('WAITING')) return run;
    if (run.pendingOperation) return this.store.update(runId, run.revision, r => { r.state = 'HELD_UNKNOWN_RESULT'; });
    const barrier = await this.barrier(run);
    run = this.store.run(runId);
    if (barrier.held || barrier.budget.pause) return this.pause(run, barrier);
    if (run.state === 'ADMISSION') return this.finalize(run);
    const stage = STAGES[run.state];
    if (!stage) throw new Error(`invalid workflow state ${run.state}`);
    const operation = { id: crypto.randomUUID(), stage, at: this.p.clock(), candidate: run.candidate, contractHash: run.contract.hash };
    run = this.store.update(runId, run.revision, r => { r.pendingOperation = operation; r.events.push({ type: 'dispatch-intent', ...operation }); });
    const abort = new AbortController(); let polling = false, crossed = null, pollTask = Promise.resolve();
    // The runner must implement bounded cancellation. An unacknowledged call stays unknown and cannot be replayed.
    const timer = setInterval(() => {
      if (polling || crossed) return; polling = true;
      pollTask = (async () => {
        try { const b = await this.barrier(this.store.run(runId)); if (b.held || b.budget.pause) { crossed = b; abort.abort(new Error('cycle budget/guard barrier')); await this.pause(this.store.run(runId), b, true); } }
        catch (e) { crossed = { held: true, guards: { reason: e.message }, budget: {} }; abort.abort(e); }
        finally { polling = false; }
      })();
    }, Math.min(1000, run.budget.checkpointGraceMs));
    let result, graceTimer;
    const interrupted = new Promise(resolve => abort.signal.addEventListener('abort', () => {
      graceTimer = setTimeout(() => {
        // A missing acknowledgement remains unknown even when termination was requested.
        Promise.resolve().then(() => this.p.terminate({ operation, runId, reason: 'checkpoint grace expired' })).catch(() => {});
        resolve({ interrupted: true });
      }, run.budget.checkpointGraceMs);
    }, { once: true }));
    try { result = await Promise.race([this.p.runner({ operation, run: structuredClone(run), signal: abort.signal, graceMs: run.budget.checkpointGraceMs }), interrupted]); }
    catch (e) {
      clearInterval(timer); await pollTask;
      run = this.store.run(runId);
      const held = this.store.update(runId, run.revision, r => { r.state = 'HELD_UNKNOWN_RESULT'; r.events.push({ type: 'infrastructure', operationId: operation.id, reason: String(e.message || e) }); });
      if (crossed) return this.pause(held, crossed);
      return held;
    } finally { clearInterval(timer); await pollTask; clearTimeout(graceTimer); }
    run = this.store.run(runId);
    if (result?.interrupted) {
      run = this.store.update(runId, run.revision, r => { r.state = 'HELD_UNKNOWN_RESULT'; r.events.push({type:'termination-requested', operationId:operation.id, partial:true}); });
      return this.pause(run, crossed);
    }
    if (!this.validResult(run, result, operation)) {
      return this.store.update(runId, run.revision, r => { r.state = 'HELD_EVIDENCE'; r.events.push({ type: 'rejected-result', operationId: operation.id }); });
    }
    const eligible = stage === 'audit' ? await this.p.eligible(run) : [];
    run = this.store.run(runId);
    run = this.store.update(runId, run.revision, r => this.applyResult(r, result, eligible));
    const after = crossed || await this.barrier(run);
    if (after.held || after.budget.pause) return this.pause(run, after);
    run = this.store.run(runId);
    if (Object.keys(after.budget.estimates).length) run = this.store.update(runId, run.revision, r => this.accrueWindows(r, after.budget));
    if (run.state === 'ADMISSION') return this.finalize(run);
    if (run.state === 'WAITING_REVIEW_APPROVAL') {
      run = this.store.update(runId, run.revision, r => { r.notifications.push({ id: `${runId}:review:${r.contract.repairGoal}`, type: 'review-decision', runId, contractHash: r.contract.hash, candidate: r.candidate, goal: r.contract.repairGoal, episode: r.episodes[r.contract.repairGoal], progress: r.progress, budget: after.budget, delivered: false }); });
      await this.flushNotifications(runId);
    }
    return this.store.run(runId);
  }
  applyResult(r, result, eligible) {
    const e = result.evidence, stage = r.pendingOperation.stage;
    // Provider consumption remains payable even if workflow evidence is rejected.
    if (result.usage) settleUsage(r, result.usage);
    if (e.sequence !== r.evidence.length + 1 || e.testsHash !== r.testsHash || e.status !== 'complete' || !Number.isFinite(e.ended) || (stage !== 'baseline' && stage !== 'implementation' && stage !== 'repair' && e.candidate !== r.candidate)) { r.state = 'HELD_EVIDENCE'; return; }
    const semantic = evidenceGaps(r.contract, [...r.evidence, e], { candidate: r.candidate, testsHash: r.testsHash, verify: this.p.verifyEvidence, stages: [stage], corrections: r.testCorrections });
    // Failed checks/audits/validator probes are legitimate repair inputs; malformed provenance is not.
    const repairStages = ['checking', 'audit', 'freshValidation', 'adversarial', 'boundaryFaults'];
    const provenanceGaps = semantic.gaps.filter(g => !repairStages.includes(stage) || !/checks did not pass|required check .* not passing|retained validator .* missing or failing/.test(g));
    if (provenanceGaps.length) { r.state = 'HELD_EVIDENCE'; r.events.push({type:'evidence-gaps', gaps:provenanceGaps}); return; }
    r.pendingOperation = null; r.evidence.push(e);
    r.events.push({ type: 'result', operationId: result.operationId, evidenceHash: hash(e), at: this.p.clock() });
    const good = e.exitCode === 0 && e.checks?.length && e.checks.every(c => c.status === 'pass');
    const needs = x => r.contract.policy.requirements.includes(x);
    switch (stage) {
      case 'failureAnalysis': r.state = good ? needs('independentTests') ? 'TEST_AUTHORING' : needs('testsFirst') ? 'BASELINE' : 'IMPLEMENTING' : 'HELD_EVIDENCE'; break;
      case 'testAuthoring': r.state = good ? 'TEST_REVIEW' : 'HELD_EVIDENCE'; break;
      case 'testReview': r.state = good ? 'BASELINE' : 'HELD_EVIDENCE'; break;
      case 'baseline': r.state = e.exitCode !== 0 && e.failureKind === 'requirement' && !e.environmentError && e.checks?.some(c => c.status === 'fail' && r.contract.checks.some(x => x.id === c.id)) ? 'IMPLEMENTING' : 'HELD_EVIDENCE'; break;
      case 'implementation': case 'repair':
        if (e.environmentError) { r.state = 'FAILED_INFRASTRUCTURE'; break; }
        r.candidate = e.candidate; r.state = 'CHECKING'; break;
      case 'checking': r.priorChecks = r.checks; r.checks = e.checks || []; r.state = 'AUDITING'; break;
      case 'audit': {
        const previous = r.findings; r.findings = mergeFindings(previous, result.findings || []);
        r.progress = progress(previous, r.findings, r.priorChecks, r.checks);
        r.events.push({ type: 'progress', ...r.progress });
        if (!good || findingGaps(r.findings).length || r.checks.some(x => x.status !== 'pass')) {
          r.state = r.auditLoops && r.progress.repairStalled ? chooseEscalation(r, eligible) : 'REPAIRING'; r.auditLoops = (r.auditLoops || 0) + 1;
        } else { r.state = needs('adversarial') ? 'ADVERSARIAL' : needs('boundaryFaults') ? 'BOUNDARY_FAULTS' : needs('freshValidation') ? 'FRESH_VALIDATION' : 'ADMISSION'; }
        break;
      }
      case 'adversarial': r.state = good ? needs('boundaryFaults') ? 'BOUNDARY_FAULTS' : 'FRESH_VALIDATION' : 'REPAIRING'; break;
      case 'boundaryFaults': r.state = good ? needs('freshValidation') ? 'FRESH_VALIDATION' : 'ADMISSION' : 'REPAIRING'; break;
      case 'freshValidation': r.state = good ? 'ADMISSION' : 'REPAIRING'; break;
      case 'extraReview': r.state = result.actionable === true ? 'REPAIRING' : 'WAITING_DECISION'; break;
      default: throw new Error('unknown result stage');
    }
  }
  validResult(run, result, operation) {
    const e = result?.evidence;
    try {
      if (needsLiveUsage(run) && !result?.usage) return false;
      if (result?.usage) {
        if (result.usage.at > this.p.clock()) return false;
        settleUsage(structuredClone(run),result.usage);
      }
    } catch { return false; }
    return !!e && result.operationId === operation.id && this.p.verifyEvidence(e) && e.runId === run.contract.runId && e.contractHash === run.contract.hash && e.stage === operation.stage &&
      e.findingsHash === hash(result.findings || []) && e.usageHash === hash(result.usage || null) && (!result.usage || result.usage.operationId === operation.id) && e.actionable === (result.actionable === true);
  }
  accrueWindows(run, budget) {
    for (const [metric, estimate] of Object.entries(budget?.estimates || {})) {
      run.windowAccrued[metric] = { points: budget.totals[metric], usd: budget.costBasis[metric], estimate };
    }
  }
  finalize(run) {
    return this.store.update(run.contract.runId, run.revision, r => {
      r.admission = admit(r, this.p.verifyEvidence);
      r.state = r.admission.passed ? r.admission.status === 'Passed' ? 'PASSED' : 'PASSED_WITH_DEFERRED_FINDINGS' : 'HELD_EVIDENCE';
    });
  }
  async resume(runId, approval, proposal, identities) {
    let run = this.store.run(runId); if (!run.pause) throw new Error('run is not paused');
    if (run.pendingOperation) throw new Error('unknown in-flight operation requires reconciliation');
    if (!identities || identities.contractHash !== run.contract.hash) throw new Error('contract changed; new contract required');
    if (run.state === 'HELD_CONTRACT' || run.stateBeforePause === 'HELD_CONTRACT') throw new Error('contract changed; new contract required');
    if (identities.testsHash !== run.testsHash) throw new Error('tests changed; separate test correction approval required');
    if (proposal) run = this.store.update(runId, run.revision, r => extendBudget(r, proposal, approval, (a,o) => this.approval(r,a,o), this.p.clock()));
    else if (!this.approval(run, approval, { type: 'resume', scope: 'resume', now: this.p.clock(), authorities: ['owner', 'superagent'] })) throw new Error('resume approval required');
    const barrier = await this.barrier(run); run = this.store.run(runId); if (barrier.held || barrier.budget.pause) return run;
    return this.store.update(runId, run.revision, r => {
      const changed = r.candidate !== identities.candidate;
      if (changed) for (const e of r.evidence) if (!['baseline','testAuthoring','testReview','failureAnalysis'].includes(e.stage)) e.status = 'invalidated';
      // A separately approved correction must finish its review/baseline even if code also changed.
      const prerequisite = ['FAILURE_ANALYSIS', 'TEST_AUTHORING', 'TEST_REVIEW', 'BASELINE'].includes(r.stateBeforePause);
      r.candidate = identities.candidate; r.state = changed && !prerequisite ? 'CHECKING' : r.stateBeforePause;
      r.pause = null; r.liveHold = false; r.events.push({ type: 'resume', approval, at: this.p.clock() });
    });
  }
  correctTests(runId, correction, approval) {
    const run = this.store.run(runId);
    if (run.pendingOperation) throw new Error('unknown in-flight operation requires reconciliation');
    if (TERMINAL.has(run.state) || run.state === 'HELD_CONTRACT' || run.stateBeforePause === 'HELD_CONTRACT') throw new Error('new contract required');
    return this.store.update(runId, run.revision, r => {
      const pausedState = r.state;
      correctTests(r, correction, approval, this.p.clock(), (a, o) => this.approval(r, a, o));
      if (r.pause) { r.stateBeforePause = r.state; r.state = pausedState; }
    });
  }
  async approveReview(runId, approval, skill) {
    const r = this.store.run(runId);
    if (r.state !== 'WAITING_REVIEW_APPROVAL' || !skill || !['astra', 'fable'].includes(skill.model) || !skill.verified || !skill.entryPoint) throw new Error('verified review skill unavailable');
    if (!this.approval(r, approval, { type: 'premiumReview', scope: hash(skill), now: this.p.clock(), authorities: ['superagent', 'owner'] })) throw new Error('scoped review approval required');
    const b = await this.barrier(r); if (b.held || b.budget.pause) return this.pause(r,b);
    return this.store.update(runId,this.store.run(runId).revision,s => { s.reviewSkill = skill; s.reviewApproval = approval; s.state = 'EXTRA_REVIEW'; });
  }
  reconcile(runId, operationId, result) {
    const r = this.store.run(runId);
    if (!r.pendingOperation || r.pendingOperation.id !== operationId || !this.validResult(r,result,r.pendingOperation)) throw new Error('trusted operation reconciliation required');
    return this.store.update(runId,r.revision,s => {
      const pausedState = s.state;
      this.applyResult(s,result,[]);
      if (s.pause) { s.stateBeforePause = s.state; s.state = pausedState; }
    });
  }
}
const guardsReason = g => g.reason || 'live external guard disallows dispatch';
