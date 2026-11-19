import { hash, verifyContract } from './contracts.mjs';
export const STAGE_REQUIREMENTS = { baseline: 'testsFirst', testReview: 'independentTests', failureAnalysis: 'failureAnalysis', checking: 'acceptance', audit: 'audit', freshValidation: 'freshValidation', adversarial: 'adversarial', boundaryFaults: 'boundaryFaults' };
const commonErrors = (e, c, candidate, testsHash, verify) => {
  const errors = [];
  if (!e || !verify(e)) return ['untrusted or partial evidence'];
  if (e.schemaVersion !== 1 || e.runId !== c.runId || e.taskId !== c.taskId || e.contractHash !== c.hash) errors.push('foreign evidence identity');
  if (e.status !== 'complete' || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || !Number.isFinite(e.started) || !Number.isFinite(e.ended) || e.ended < e.started || !Array.isArray(e.command) || !e.command.length || !e.environment || !e.artifacts?.length || e.artifacts.some(x => !x.hash || !x.name)) errors.push('incomplete execution record');
  if (e.testsHash !== testsHash) errors.push('reviewed tests changed');
  if (e.environmentError || e.checks?.some(x => x.environmentError || x.legitimate === false || x.process?.completed === false)) errors.push('infrastructure or unclassified check failure');
  if (!['baseline','testAuthoring','testReview','failureAnalysis'].includes(e.stage) && e.candidate !== candidate) errors.push('stale candidate evidence');
  if (!e.producer?.context || !e.producer.role || !e.controls?.isolatedWorkspace || !e.controls?.protectedVerdicts) errors.push('missing execution controls');
  return errors;
};
// The append-only evidence history owns validator obligations, including failed and
// invalidated results. A new validator or changed candidate cannot retire a test.
export function validatorObligations(evidence, corrections = []) {
  const tests = new Map();
  for (const e of evidence) for (const t of e.adversarialTests || []) {
    if (!t || !/^validator-tests\/[a-zA-Z0-9_.-]+\.test\.mjs$/.test(t.name) || !/^[a-f0-9]{64}$/.test(t.hash) ||
        !Array.isArray(t.requiredTests) || !t.requiredTests.length || t.requiredTests.some(c => c.file !== t.name || typeof c.name !== 'string' || !c.name.trim()) ||
        new Set(t.requiredTests.map(c => c.name)).size !== t.requiredTests.length) throw new Error('invalid retained validator artifact');
    const previous = tests.get(t.name);
    if (previous && hash(previous.test) !== hash(t)) throw new Error('conflicting retained validator artifact');
    tests.set(t.name, { test:t, context:e.producer.context });
  }
  for (const c of corrections) for (const t of c.validatorRemovals || []) {
    const retained = tests.get(t.name);
    if (!retained || retained.test.hash !== t.hash) throw new Error('validator correction identity mismatch');
    tests.delete(t.name);
  }
  return [...tests.values()];
}
export function validatorGaps(evidence, latest, corrections = []) {
  let retained;
  try { retained = validatorObligations(evidence, corrections); } catch (e) { return [e.message]; }
  return retained.flatMap(({test:t}) => {
    const manifest = latest?.validatorManifest?.filter(x => x.name === t.name) || [];
    const checks = latest?.checks?.filter(c => c.id === `adversarial:${hash(t)}`) || [];
    return manifest.length === 1 && hash(manifest[0]) === hash(t) && checks.length === 1 && checks[0].status === 'pass' &&
      Array.isArray(checks[0].requiredTests) && hash(checks[0].requiredTests) === hash(t.requiredTests) && checks[0].executionGaps?.length === 0 ? [] : [`retained validator ${t.name} missing or failing`];
  });
}
export function evidenceGaps(contract, evidence, { candidate, testsHash = contract.testsHash, verify = () => false, stages = null, corrections = [] } = {}) {
  verifyContract(contract);
  const gaps = [], accepted = {};
  for (const [stage, requirement] of Object.entries(STAGE_REQUIREMENTS)) {
    if (stages && !stages.includes(stage)) continue;
    if (!contract.policy.requirements.includes(requirement)) continue;
    const e = evidence.filter(x => x.stage === stage && x.status !== 'invalidated').at(-1);
    if (!e) { gaps.push(`${stage}: missing evidence`); continue; }
    const errors = commonErrors(e, contract, candidate, testsHash, verify);
    const expectedRole = { baseline: 'checker', testReview: 'testReviewer', failureAnalysis: 'analyst', checking: 'checker', audit: 'auditor', freshValidation: 'validator', adversarial: 'validator', boundaryFaults: 'validator' }[stage];
    if (e.producer?.role !== expectedRole) errors.push('wrong role capability');
    if (stage === 'baseline') {
      if (e.exitCode === 0 || e.failureKind !== 'requirement' || !e.checks?.some(x => x.status === 'fail' && x.legitimate === true && contract.checks.some(c => c.id === x.id)) || e.environmentError || !e.baselineRevision) errors.push('red is not an intended requirement failure');
    } else {
      if (e.exitCode !== 0 || e.checks?.some(x => x.status !== 'pass') || !e.checks?.length) errors.push('checks did not pass');
    }
    if (stage === 'checking' || stage === 'freshValidation') {
      for (const check of contract.checks.filter(x => x.mandatory)) if (!e.checks?.some(x => x.id === check.id && x.status === 'pass')) errors.push(`required check ${check.id} not passing`);
    }
    if (stage === 'freshValidation' && (!e.controls?.freshContext || !e.controls?.contractOnly || !e.adversarialTests?.length)) errors.push('fresh validator did not add independent adversarial checks');
    if (stage === 'testReview' && (!e.controls?.contractOnly || !e.controls?.protectedTests || !e.testAuthor?.independent || e.testAuthor.context === e.builderContext || !e.testAuthor.context)) errors.push('independent authorship not controlled');
    if (errors.length) gaps.push(...errors.map(x => `${stage}: ${x}`)); else accepted[stage] = e;
  }
  if (!stages || stages.includes('freshValidation')) {
    const latest = evidence.filter(e => e.stage === 'freshValidation' && e.status !== 'invalidated').at(-1);
    gaps.push(...validatorGaps(evidence, latest, corrections).map(g => `freshValidation: ${g}`));
    if (evidence.some(e => e.adversarialTests?.length && !(verify(e) || e.status === 'invalidated' && verify({...e,status:'complete'})))) gaps.push('freshValidation: untrusted retained artifacts');
  }
  const baseline = accepted.baseline, final = accepted.checking;
  if (baseline && final && (baseline.sequence >= final.sequence || baseline.ended > final.started)) gaps.push('tests-first sequence is reversed');
  if (accepted.testReview && final && accepted.testReview.sequence >= final.sequence) gaps.push('test review must precede final checks');
  if (accepted.freshValidation && accepted.audit && accepted.freshValidation.sequence <= accepted.audit.sequence) gaps.push('validation is not fresh after audit');
  const builderContexts = new Set(evidence.filter(e => ['implementation', 'repair'].includes(e.stage)).map(e => e.producer?.context));
  if (accepted.testReview && builderContexts.has(accepted.testReview.testAuthor?.context)) gaps.push('testReview: builder authored its own accepted tests');
  for (const stage of ['testReview', 'audit', 'freshValidation']) if (accepted[stage] && builderContexts.has(accepted[stage].producer.context)) gaps.push(`${stage}: builder cannot approve itself`);
  return { gaps, accepted };
}
export function correctTests(run, correction, approval, now, verifyApproval) {
  if (correction.oldHash !== run.testsHash || !correction.newHash || (correction.oldHash === correction.newHash && !correction.validatorRemovals?.length)) throw new Error('test correction identity mismatch');
  const changedContract = correction.changesContract === true;
  if (!verifyApproval(approval, { type: changedContract ? 'scopeChange' : 'testCorrection', scope: hash(correction), now, authorities: changedContract ? ['owner'] : ['independentReviewer'] })) throw new Error('test correction approval required');
  if (correction.validatorRemovals && !Array.isArray(correction.validatorRemovals)) throw new Error('validator correction inventory required');
  if (correction.validatorRemovals) validatorObligations(run.evidence, [...(run.testCorrections || []), correction]);
  run.testCorrections ||= [];
  run.testCorrections.push({ ...correction, approval }); run.testsHash = correction.newHash;
  for (const e of run.evidence) e.status = 'invalidated';
  run.state = changedContract ? 'HELD_CONTRACT' : run.contract.policy.requirements.includes('independentTests') ? 'TEST_REVIEW' : 'BASELINE';
}
