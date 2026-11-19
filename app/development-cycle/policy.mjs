export const POLICY_VERSION = 1;
export const BASE = ['acceptance', 'regressions', 'audit'];
export const PRESETS = Object.freeze({
  T1: [], T2: ['testsFirst'], T3: ['testsFirst', 'independentTests', 'freshValidation'],
  T4: ['failureAnalysis', 'adversarial', 'freshValidation'],
  T5: ['testsFirst', 'independentTests', 'freshValidation', 'boundaryFaults'],
});
export const RISKS = Object.freeze({
  layout: [], ordinary: ['testsFirst'], shared: ['testsFirst', 'independentTests', 'freshValidation'],
  incident: ['failureAnalysis', 'adversarial', 'freshValidation'],
  critical: ['testsFirst', 'independentTests', 'freshValidation', 'boundaryFaults'],
});
export const REQUIREMENTS = [...new Set([...BASE, ...Object.values(PRESETS).flat()])];
const METHODS = { build: [], testsFirst: ['testsFirst'], failureDriven: ['failureAnalysis', 'adversarial'] };
export const COVERAGE = Object.freeze({
  'superagent-coding-v1': 'isolated adapter verified; live rollout not enabled',
  worker: 'not yet enforced', driver: 'not yet enforced', featureLoop: 'not yet enforced',
  headless: 'not yet enforced', manual: 'not yet enforced', noncoding: 'out of scope',
});
export function resolvePolicy({ preset = 'T2', risk = 'ordinary', incident = false, advanced = {}, kind = 'coding', disputed = false } = {}) {
  if (!Object.hasOwn(PRESETS, preset)) throw new Error('unknown preset');
  if (typeof advanced !== 'object' || !advanced || Array.isArray(advanced)) throw new Error('invalid advanced controls');
  for (const [k, v] of Object.entries(advanced)) {
    if (k === 'method') { if (!Object.hasOwn(METHODS, v)) throw new Error('invalid method'); }
    else if (!REQUIREMENTS.includes(k) || typeof v !== 'boolean') throw new Error('invalid advanced requirement');
  }
  if (typeof incident !== 'boolean' || typeof disputed !== 'boolean') throw new Error('invalid classification');
  const reasons = {}, add = (r, why) => { (reasons[r] ||= []).push(why); };
  BASE.forEach(r => add(r, 'existing workflow guard'));
  const requested = new Set(PRESETS[preset]);
  if (advanced.method) { requested.delete('testsFirst'); requested.delete('failureAnalysis'); requested.delete('adversarial'); METHODS[advanced.method].forEach(r => requested.add(r)); }
  for (const [r, value] of Object.entries(advanced)) if (r !== 'method') value ? requested.add(r) : requested.delete(r);
  requested.forEach(r => add(r, `requested ${preset}/advanced`));
  (RISKS[risk] || []).forEach(r => add(r, `mandatory risk:${risk}`));
  if (incident) RISKS.incident.forEach(r => add(r, 'mandatory incident'));
  if (reasons.independentTests) add('testsFirst', 'independent tests require baseline');
  return { policyVersion: POLICY_VERSION, preset, advanced: structuredClone(advanced), risk, incident, kind,
    held: kind !== 'coding' ? 'out of scope' : !Object.hasOwn(RISKS, risk) || disputed ? 'classification unresolved' : null,
    requirements: Object.keys(reasons).sort(), mandatory: Object.keys(reasons).filter(r => reasons[r].some(x => !x.startsWith('requested'))).sort(), reasons };
}
export function effectiveSettings(settings, planId) {
  const override = Object.hasOwn(settings.plans, planId) ? settings.plans[planId] : null;
  return { ...settings.global, ...override, provenance: override ? `plan:${planId}` : 'global', revision: settings.revision };
}
