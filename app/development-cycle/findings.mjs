import { hash, id, text } from './contracts.mjs';
export function normalizeFinding(f) {
  id(f.goalId, 'repair goal'); text(f.invariant, 'invariant'); text(f.reproduction, 'reproduction');
  if (!Array.isArray(f.evidence) || !f.evidence.length || f.evidence.some(x => typeof x !== 'string' || !x)) throw new Error('evidenced findings required');
  const severity = f.severity || 'UNCLASSIFIED';
  if (!['CRITICAL', 'HIGH', 'MED', 'LOW', 'UNCLASSIFIED'].includes(severity)) throw new Error('invalid severity');
  text(f.rationale, 'severity rationale');
  // The host contract's stable invariant/goal anchors identity; prose cannot mint discovery.
  const fingerprint = hash({ goalId: f.goalId, invariant: f.invariant });
  return { ...f, severity, fingerprint, findingId: fingerprint.slice(0, 24), state: f.state || 'open' };
}
export function blocking(f) { return !!f.mandatory || f.disputed || ['HIGH', 'CRITICAL', 'UNCLASSIFIED'].includes(f.severity); }
export function findingGaps(findings) {
  const gaps = [];
  for (const f of findings) {
    if (f.state === 'resolved') { if (!f.resolution?.verified || !f.resolution.evidence?.length) gaps.push(`${f.findingId}: unverified resolution`); continue; }
    if (blocking(f)) { gaps.push(`${f.findingId}: blocking finding`); continue; }
    const d = f.deferral;
    if (f.state !== 'deferred' || !d || ['reason', 'owner', 'trigger', 'backlog'].some(k => typeof d[k] !== 'string' || !d[k].trim()) || !d.evidence?.length) gaps.push(`${f.findingId}: incomplete deferral`);
  }
  return gaps;
}
export function mergeFindings(previous, incoming) {
  const result = new Map(previous.map(f => [f.fingerprint, structuredClone(f)]));
  for (const raw of incoming) {
    const f = normalizeFinding(raw), old = result.get(f.fingerprint);
    if (old?.mandatory) f.mandatory = true;
    if (old && old.severity !== f.severity && !f.classificationReview?.verified) { f.disputed = true; f.severity = old.severity; }
    f.history = [...(old?.history || []), { state: f.state, severity: f.severity, evidence: f.evidence }];
    result.set(f.fingerprint, f);
  }
  return [...result.values()];
}
export function progress(previous, current, beforeChecks = [], afterChecks = []) {
  const old = new Map(previous.map(f => [f.fingerprint, f]));
  const R = current.some(f => old.has(f.fingerprint) && blocking(old.get(f.fingerprint)) && old.get(f.fingerprint).state !== 'resolved' && f.state === 'resolved' && f.resolution?.verified && f.resolution.evidence?.length);
  const C = afterChecks.some(c => c.status === 'pass' && c.verified && beforeChecks.some(p => p.id === c.id && p.status === 'fail' && p.legitimate));
  const D = current.some(f => !old.has(f.fingerprint) && f.evidence?.length);
  return { R, C, D, fullyStalled: !R && !C && !D, repairStalled: !R && !C };
}
