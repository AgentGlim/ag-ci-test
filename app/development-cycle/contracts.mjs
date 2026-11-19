import crypto from 'node:crypto';
import { resolvePolicy, POLICY_VERSION, PRESETS } from './policy.mjs';
export const VERSION = 1;
export const RUBRIC = Object.freeze({ version: 1, CRITICAL: 'Boundary escape or unauthorized execution/spending/disclosure', HIGH: 'Mandatory behavior, isolation or assurance fails', MED: 'Nonmandatory functional degradation', LOW: 'Nonmandatory cosmetic defect' });
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new Error('non-JSON semantic content');
}
export const hash = v => crypto.createHash('sha256').update(canonical(v)).digest('hex');
export const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export function id(value, label = 'identity') { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`invalid ${label}`); return value; }
export function text(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`invalid ${label}`); return value; }
export function positive(value, label) { if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`); return value; }
export function bounded(value) { if (Buffer.byteLength(canonical(value)) > 1048576) throw new Error('payload too large'); return value; }
export function validateChoice(choice) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('invalid settings choice');
  for (const k of Object.keys(choice)) if (!['preset', 'advanced'].includes(k)) throw new Error('unknown setting');
  if (choice.preset !== undefined && !Object.hasOwn(PRESETS, choice.preset)) throw new Error('unknown preset');
  resolvePolicy(choice);
  return bounded(structuredClone(choice));
}
export function validateSettings(s) {
  if (s.schemaVersion !== VERSION || s.policyVersion !== POLICY_VERSION || !Number.isSafeInteger(s.revision) || s.revision < 0) throw new Error('unsupported settings schema/revision');
  validateChoice(s.global);
  if (!s.plans || Object.getPrototypeOf(s.plans) !== Object.prototype) throw new Error('invalid plans');
  for (const [p, choice] of Object.entries(s.plans)) { id(p, 'plan'); validateChoice(choice); }
  return bounded(s);
}
export function validateBudget(b = {}) {
  for (const k of Object.keys(b)) if (!['targets', 'hardCeilings', 'freshnessMs', 'checkpointGraceMs'].includes(k)) throw new Error('unknown budget field');
  const result = { targets: {}, hardCeilings: {}, freshnessMs: 120000, checkpointGraceMs: 10000, ...structuredClone(b) };
  for (const name of ['targets', 'hardCeilings']) {
    if (!result[name] || Array.isArray(result[name]) || typeof result[name] !== 'object') throw new Error('invalid budget targets');
    for (const [metric, value] of Object.entries(result[name])) {
      if (!['hours', 'apiEquivalentUsd'].includes(metric) && !/^window:[a-z0-9-]+:(5h|7d|1mo)$/.test(metric)) throw new Error('unknown budget metric');
      positive(value, metric);
    }
  }
  positive(result.freshnessMs, 'freshness'); positive(result.checkpointGraceMs, 'grace');
  if (result.checkpointGraceMs > 60000) throw new Error('checkpoint grace exceeds supported bound');
  return result;
}
export function makeContract(input) {
  bounded(input);
  const { runId, taskId, planId, base, writeScope, testsHash, checks, selection = {}, budget = {}, settingsRevision = 0, provenance = 'global', repairGoal = taskId } = input;
  [runId, taskId, planId, repairGoal].forEach(x => id(x)); text(base, 'base'); text(testsHash, 'test hash');
  if (!Array.isArray(writeScope) || !writeScope.length || writeScope.some(p => typeof p !== 'string' || !p || p.includes('..'))) throw new Error('explicit confined write scope required');
  if (!Array.isArray(checks) || !checks.length || new Set(checks.map(x => x.id)).size !== checks.length) throw new Error('unique acceptance checks required');
  for (const c of checks) { id(c.id, 'check'); id(c.requirement, 'requirement'); text(c.criterion, 'acceptance criterion'); if (c.mandatory !== undefined && typeof c.mandatory !== 'boolean') throw new Error('invalid mandatory flag'); }
  for (const requirement of ['acceptance','regressions']) if (!checks.some(c => c.requirement === requirement && c.mandatory !== false)) throw new Error(`mandatory ${requirement} check required`);
  const c = { schemaVersion: VERSION, policyVersion: POLICY_VERSION, runId, taskId, planId, base, writeScope: [...writeScope],
    testsHash, checks: checks.map(x => ({ ...x, mandatory: x.mandatory !== false })), policy: resolvePolicy(selection), budget: validateBudget(budget),
    settingsRevision, provenance, repairGoal, rubric: RUBRIC, adapter: { id: 'superagent-coding-v1', version: 1 },
    permissions: { deploy: false, liveRollout: false }, approvalLifetimeMs: 1800000 };
  return { ...c, hash: hash(c) };
}
export function verifyContract(c) {
  const { hash: recorded, ...semantic } = c;
  if (c.schemaVersion !== VERSION || c.policyVersion !== POLICY_VERSION || c.adapter?.version !== 1 || c.adapter.id !== 'superagent-coding-v1' || hash(semantic) !== recorded) throw new Error('unsupported or changed contract');
  return c;
}
export function validApproval(a, { type, contract, candidate, scope, now, authorities }) {
  return !!a && a.type === type && a.runId === contract.runId && a.contractHash === contract.hash && a.candidate === candidate &&
    a.scope === scope && a.decision === 'approved' && authorities.includes(a.authority) && typeof a.reason === 'string' && !!a.reason.trim() &&
    Number.isFinite(a.at) && a.at <= now && now - a.at <= contract.approvalLifetimeMs && a.expiresAt > now;
}
