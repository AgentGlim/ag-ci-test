import { assertKeys, clone, safeInput } from './durable.mjs';
export const GROUPS = Object.freeze(['identity', 'priority', 'tier', 'roles', 'deadline', 'tests', 'dependencies']);
export const ROLES = Object.freeze(['worker', 'auditor', 'repair']);
export const DEFAULTS = Object.freeze({ timeoutSeconds: 3600, subscriptionOnly: true, independentAudit: true, repairLimit: 3,
  sandbox: 'workspace-write', permissions: 'existing harness gates', concurrency: 1, background: true,
  recovery: 'reconcile existing job state; never blindly retry', completion: 'tracked job receipt; audit acceptance separate',
  cancellation: 'canonical agent.sh stop with noretry', externalActions: 'explicit authorization required',
  secrets: 'safe aliases only; no credentials', checkpoints: 'existing harness checkpoints', install: 'separate authorized install and host verification',
  quota: 'existing provider admission and holds', budgetAction: 'existing gates; no new spending authority' });
export function validateDefaults(v) {
  assertKeys(v, Object.keys(DEFAULTS), 'defaults'); safeInput(v);
  for (const k of Object.keys(DEFAULTS)) if (!(k in v)) throw new Error(`Missing defaults field: ${k}`);
  if (!Number.isInteger(v.timeoutSeconds) || v.timeoutSeconds < 1 || v.timeoutSeconds > 86400) throw new Error('timeoutSeconds must be 1..86400');
  if (v.subscriptionOnly !== true) throw new Error('subscriptionOnly must stay true; F36 cannot enable API fallback');
  if (v.independentAudit !== true) throw new Error('independentAudit is required');
  if (v.sandbox !== 'workspace-write' || v.background !== true || v.concurrency !== 1) throw new Error('Unsupported sandbox/background/concurrency combination');
  if (!Number.isInteger(v.repairLimit) || v.repairLimit < 0 || v.repairLimit > 3) throw new Error('repairLimit must be 0..3');
  for (const [k, val] of Object.entries(DEFAULTS)) if (typeof val === 'string' && k !== 'sandbox' && v[k] !== val) throw new Error(`${k} is inherited policy; change it through its existing owner`);
  return clone(v);
}
export const MODEL_ROUTES = Object.freeze({
  'claude-sonnet': { kind: 'sonnet', harness: 'claude', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  'claude-haiku': { kind: 'haiku', harness: 'claude', provider: 'anthropic', model: 'claude-haiku-5-5' },
  'claude-opus': { kind: 'opus', harness: 'claude', provider: 'anthropic', model: 'claude-opus-5-5' },
  'claude-fable': { kind: 'fable', harness: 'claude', provider: 'anthropic', model: 'claude-fable-5-1' },
  'codex-sol': { kind: 'codex-only', harness: 'codex', provider: 'codex', model: 'gpt-6.1-sol' },
  'codex-terra': { kind: 'codex-only', harness: 'codex', provider: 'codex', model: 'gpt-6.1-terra' },
  'codex-astra': { kind: 'codex-only', harness: 'codex', provider: 'codex', model: 'gpt-6-astra' },
  'codex-luna': { kind: 'codex-only', harness: 'codex', provider: 'codex', model: 'gpt-6-luna' },
  'deepseek-flash': { kind: 'pi', harness: 'pi', provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
});
export function rolePick(value) {
  assertKeys(value, ['pick', 'effort', 'evidence', 'reason', 'chooser', 'acceptedBy', 'answerEvidence'], 'role');
  if (!MODEL_ROUTES[value.pick]) throw new Error(`Unsupported role model: ${value.pick}; select a current subscription route`);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)) throw new Error('Unsupported role effort');
  return { pick: value.pick, effort: value.effort };
}
const text = (x) => typeof x === 'string' && x.trim() && x.length <= 2000;
const list = (x) => Array.isArray(x) && x.length <= 100 && x.every(v => text(v) && !/[\r\n]/.test(v));
export function validateAnswer(group, v) {
  safeInput(v);
  if (!GROUPS.includes(group)) throw new Error(`Unknown answer group ${group}`);
  if (group === 'identity') {
    assertKeys(v, ['name', 'type', 'parent'], 'identity');
    if (!text(v.name) || !['task', 'feature', 'project'].includes(v.type)) throw new Error('identity needs name and task/feature/project type');
    if (!Object.hasOwn(v, 'parent') || (v.type !== 'project' && !/^\d\d-[a-z0-9][a-z0-9-]*$/.test(v.parent || '')) || (v.type === 'project' && v.parent !== null && !/^\d\d-[a-z0-9][a-z0-9-]*$/.test(v.parent || ''))) throw new Error('parent must be a plan; root projects explicitly answer parent:null');
  }
  if (group === 'priority' && (typeof v !== 'string' || !/^P[0-3]$/.test(v))) throw new Error('priority must be P0..P3');
  if (group === 'tier' && (typeof v !== 'string' || !/^T[1-5]$/.test(v))) throw new Error('tier must be T1..T5');
  if (group === 'deadline' && v !== null && (!text(v) || !/^\d{4}-\d\d-\d\dT/.test(v) || !Number.isFinite(Date.parse(v)))) throw new Error('deadline needs ISO time or explicit null');
  if (group === 'tests' && (!list(v) || !v.length)) throw new Error('Required tests must be a nonempty list');
  if (group === 'dependencies' && (!list(v) || v.some(x => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x)))) throw new Error('dependencies must be IDs or explicit []');
  if (group === 'roles') {
    assertKeys(v, ROLES, 'roles'); for (const r of ROLES) { if (!v[r]) throw new Error(`roles needs ${r}`); rolePick(v[r]); }
  }
  return clone(v);
}
// Registry owns the renderer and the adapter coverage contract; capability states are explicit.
const definitions = [
  ['identity', '🪪 Identity', ['buildId', 'name', 'type', 'parent', 'trackingPlan', 'parentItem', 'repository', 'featureDirectory', 'specPath', 'owner', 'sourceRevision']],
  ['intake', '💬 Intake', ['mode', 'defaultsVersion', 'schemaVersion', 'answers', 'missing', 'reviewCount']],
  ['execution', '🔁 Execution', ['priority', 'tier', 'tierRationale', 'phases', 'independentAudit', 'repairLimit', 'acceptance', 'deadline', 'tests', 'dependencies']],
  ['provider', '🧭 Providers', ['worker', 'auditor', 'repair', 'accountAlias', 'subscriptionOnly', 'fallback', 'codexBin', 'overrideTranscript']],
  ['resources', '⚙️ Resources', ['concurrency', 'timeoutSeconds', 'cpu', 'ram', 'gpu', 'processLimit']],
  ['budget', '💰 Budget', ['tokenCap', 'spendCap', 'quota', 'action']],
  ['safety', '🔒 Safety', ['sandbox', 'writableRoots', 'permissions', 'holds', 'approvals', 'externalActions', 'secrets', 'repositoryLocks', 'duplicateProtection']],
  ['lifecycle', '📦 Lifecycle', ['background', 'autoAnswer', 'checkpoints', 'recovery', 'completion', 'cancellation', 'install']],
  ['runtime', '📋 Observations', ['state', 'failedGate', 'attemptId', 'jobs', 'processIdentity', 'dispatchTime', 'receipts', 'provider', 'account', 'logs', 'artifacts', 'liveness', 'failures', 'repairs', 'nextAction', 'auditAcceptance', 'installed']],
];
export const REGISTRY = Object.freeze(definitions.flatMap(([group, title, ids]) => ids.map(name => Object.freeze({ id: `${group}.${name}`, group, title,
  type: ['answers', 'worker', 'auditor', 'repair'].includes(name) ? 'object' : 'json', applicability: 'chat launch',
  classification: group === 'runtime' ? 'observation' : ['identity', 'intake', 'execution', 'provider'].includes(group) ? 'per-build or inherited' : 'setup default or inherited',
  sensitivity: 'private configuration; no credentials', owner: group === 'runtime' ? 'existing job tracker / F31' : 'build intake / existing harness policy',
  validation: 'validateDefaults / validateAnswer / adapter admission', recommendationResolver: 'setup recommendations / Jev / existing harness',
}))));
export function checkCoverage(ids) {
  const known = new Set(REGISTRY.map(x => x.id)); const gaps = ids.filter(x => !known.has(x));
  if (gaps.length) throw new Error(`Unregistered launch options: ${gaps.join(', ')}`);
  return true;
}
const value = (effective, origin, reason, verification = 'configured', status = effective === null ? 'unset' : 'available', requested = effective) => ({ requested, effective, origin, reason, verification, status, observedAt: null });
export function configuration(r) {
  const a = r.answers, d = r.defaults.values, f = {};
  for (const entry of REGISTRY) f[entry.id] = value(null, 'runtime', 'Not observed', 'unverified', 'pending');
  const put = (id, v, origin = 'inherited', reason = 'Pinned setup recommendation', verification) => { f[id] = value(v, origin, reason, verification); };
  for (const [k, v] of Object.entries({ buildId: r.id, ...(a.identity || r.recommendations.identity), ...r.source, owner: 'owner' })) {
    if (REGISTRY.some(x => x.id === `identity.${k}`)) put(`identity.${k}`, v, k === 'buildId' ? 'runtime' : 'owner', 'Linked launch identity', 'recorded');
  }
  put('identity.trackingPlan', a.identity?.parent || r.source.plan || null, 'owner', 'Canonical tracked parent plan', 'recorded');
  const missing = GROUPS.filter(g => !Object.hasOwn(a, g));
  for (const [k, v] of Object.entries({ mode: 'ask', defaultsVersion: r.defaultsVersion, schemaVersion: r.schemaVersion, answers: r.answerEvidence, missing, reviewCount: r.reviewCount })) put(`intake.${k}`, v, 'runtime', 'Recorded intake', 'recorded');
  for (const k of ['priority', 'tier', 'deadline', 'tests', 'dependencies']) put(`execution.${k}`, a[k] ?? null, 'owner', Object.hasOwn(a, k) ? 'Explicit per-build answer' : 'Owner answer pending', Object.hasOwn(a, k) ? 'recorded' : 'unverified');
  put('execution.tierRationale', 'Owner-selected tier; existing assurance floors still apply');
  put('execution.phases', ['PLAN', '(WORK → independent AUDIT → bounded REPAIR)*', 'HOST VALIDATION', 'authorized INSTALL', 'LIVE VERIFICATION']);
  for (const k of ['independentAudit', 'repairLimit']) put(`execution.${k}`, d[k], 'inherited', 'Requested loop contract; actual audit/repair execution requires evidence', 'requested');
  put('execution.acceptance', 'Worker rc0 is not audit acceptance, installation or owner verification');
  for (const role of ROLES) {
    const assignment = a.roles?.[role] || r.recommendations.roles[role];
    put(`provider.${role}`, { ...assignment, requestedRoute: MODEL_ROUTES[assignment.pick] }, assignment.chooser, 'Resolved requested role route; execution/provider not verified', 'requested');
    f[`provider.${role}`].requested = assignment;
  }
  put('provider.overrideTranscript', r.source.ownerQuoteFile || null, 'owner', 'Transcript source for canonical override verification; no auth contents', 'requested');
  put('provider.subscriptionOnly', d.subscriptionOnly);
  put('provider.fallback', 'Existing Sonnet recommendation on Jev failure; all live gates required');
  put('provider.accountAlias', null, 'runtime', 'F33 account pinning out of scope', 'unverified');
  put('provider.codexBin', null, 'runtime', 'Resolved binary unavailable in current receipt', 'unverified'); f['provider.codexBin'].status = 'unavailable';
  for (const k of ['concurrency', 'timeoutSeconds']) put(`resources.${k}`, d[k]);
  for (const id of ['resources.cpu', 'resources.ram', 'resources.processLimit', 'budget.tokenCap', 'budget.spendCap']) f[id] = value(null, 'inherited', 'No supported per-launch enforcement in the connected adapter', 'unverified', 'unsupported');
  f['resources.gpu'] = value(null, 'inherited', 'GPU requests not exposed by this v1 adapter', 'unverified', 'not-applicable');
  put('budget.quota', d.quota); put('budget.action', d.budgetAction);
  for (const k of ['sandbox', 'permissions', 'externalActions', 'secrets']) put(`safety.${k}`, d[k]);
  put('safety.writableRoots', [r.source.repository, r.source.featureDirectory], 'owner', 'Requested roots; actual confinement belongs to canonical agent.sh', 'requested');
  put('safety.holds', 'Rechecked by existing admission and agent.sh'); put('safety.approvals', 'Existing authorization only; per-build answers required');
  put('safety.repositoryLocks', 'Existing agent.sh repository lock'); put('safety.duplicateProtection', 'Atomic logical intent; no replay of uncertain dispatch');
  put('lifecycle.autoAnswer', false, 'inherited', 'No automatic answer continuation in bounded canonical dispatch');
  for (const k of ['background', 'checkpoints', 'recovery', 'completion', 'cancellation', 'install']) put(`lifecycle.${k}`, d[k]);
  for (const id of ['runtime.provider', 'runtime.account', 'runtime.liveness']) f[id].status = 'unavailable';
  return { schemaVersion: r.schemaVersion, defaultsVersion: r.defaultsVersion, fields: f };
}
