import { evidenceGaps } from './evidence.mjs';
import { findingGaps } from './findings.mjs';
export function admit(run, verify) {
  const e = evidenceGaps(run.contract, run.evidence, { candidate: run.candidate, testsHash: run.testsHash, verify, corrections: run.testCorrections });
  const gaps = [...e.gaps, ...findingGaps(run.findings)];
  if (run.contract.policy.held) gaps.push(run.contract.policy.held);
  if (run.pendingOperation || run.pause || run.liveHold || run.state?.startsWith('HELD')) gaps.push('run dispatch/hold unresolved');
  const deferred = run.findings.filter(f => f.state === 'deferred');
  return { passed: !gaps.length, status: gaps.length ? 'Not passed' : deferred.length ? 'Passed with deferred findings' : 'Passed',
    gaps, deferred: { MED: deferred.filter(f => f.severity === 'MED').length, LOW: deferred.filter(f => f.severity === 'LOW').length, backlog: deferred.map(f => f.deferral?.backlog || '') } };
}
