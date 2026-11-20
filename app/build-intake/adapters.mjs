// F36 adapters use existing policy and job authorities. No scheduler, usage thresholds or process reaper here.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA, RUN } from '../paths.mjs';
import { MODEL_ROUTES, ROLES, rolePick, checkCoverage } from './registry.mjs';
import { publish, hash } from './durable.mjs';
const execFileAsync = promisify(execFile);
// Keep job registration readable even in a minimal install without the optional F31 modules.
// This adapter never derives or changes job status.
let liveWorkers, failures;
try { liveWorkers = await import('../live-workers.mjs'); } catch { /* report unavailable below */ }
try { failures = await import('../failure-ledger.mjs'); } catch { /* no local failure taxonomy */ }
function jobRecords(dir) {
  let names; try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).flatMap(n => {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); return j && typeof j.id === 'string' ? [j] : []; }
    catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return []; throw e; }
  });
}
export const DISPATCH_FIELDS = Object.freeze(['identity.parent', 'identity.trackingPlan', 'provider.overrideTranscript', 'lifecycle.autoAnswer', 'identity.repository', 'identity.specPath', 'identity.name', 'provider.worker', 'provider.auditor', 'provider.repair',
  'provider.subscriptionOnly', 'execution.tier', 'execution.tests', 'execution.deadline', 'execution.repairLimit', 'resources.timeoutSeconds', 'runtime.attemptId', 'runtime.artifacts', 'runtime.logs']);
checkCoverage(DISPATCH_FIELDS);
const runExec = async (bin, args, options = {}) => {
  try { const r = await execFileAsync(bin, args, { timeout: 120000, maxBuffer: 1 << 20, ...options }); return { ...r, code: 0 }; }
  catch (e) { if (e.stdout !== undefined) return { code: e.code, stdout: e.stdout, stderr: e.stderr }; throw e; }
};
// Project F31 evidence only. Explicit repair-attempt records are required: labels, failure
// causes and repeated wrappers cannot establish that a repair actually ran.
export function workerLiveness(inputs = {}, options = {}) {
  if (!liveWorkers) return { available: false, state: 'unverified', reason: 'F31 live-worker authority unavailable' };
  const { repairAttempts, ...populationInputs } = inputs;
  const population = liveWorkers.livePopulation(populationInputs, options);
  const attempts = [...(inputs.history || []), ...(inputs.tracked || [])];
  const ledger = failures?.failureLedgerAvailability() || { available: false, reason: 'F31 failure ledger unavailable' };
  const failureSummary = (records) => {
    if (!ledger.available) return { ...ledger, count: null, byCause: null, attempts: [] };
    const attempts = failures.failureLedger(records), byCause = {};
    for (const attempt of attempts) byCause[attempt.cause] = (byCause[attempt.cause] || 0) + 1;
    return { available: true, count: attempts.length, byCause, attempts };
  };
  const agents = (list) => list.map(a => ({ key: a.key, confidence: a.confidence, rawIds: a.rawIds,
    processIdentities: [...new Set(a.records.map(liveWorkers.pidIdentity).filter(Boolean))] }));
  return { available: true, authority: 'F31', observedAt: new Date(options.now ?? Date.now()).toISOString(),
    counts: population.counts, workers: agents(population.workers), idle: agents(population.idle), unknown: agents(population.unknown),
    failures: failureSummary(attempts),
    repairs: Array.isArray(repairAttempts) ? { available: true, count: repairAttempts.length, failures: failureSummary(repairAttempts) }
      : { available: false, count: null, reason: 'Canonical repair-attempt records not supplied' } };
}
export function buildDispatchCommand(intent, { runDir, env = process.env }) {
  const b = intent.build, worker = b.answers.roles.worker, selected = MODEL_ROUTES[worker.pick]; rolePick(worker);
  const timeout = b.answers.deadline ? Math.min(b.defaults.values.timeoutSeconds, Math.floor((Date.parse(b.answers.deadline) - Date.now()) / 1000)) : b.defaults.values.timeoutSeconds;
  if (timeout < 1) throw new Error('Build deadline elapsed before dispatch');
  return { bin: 'bash', args: [path.join(runDir, 'bin', 'agent.sh'), selected.kind, b.source.repository, intent.promptFile, intent.outdir, String(timeout), worker.effort, '--plan', intent.plan,
    ...(b.source.ownerQuoteFile ? ['--owner-quote-file', b.source.ownerQuoteFile] : [])], shell: false,
    env: { ...env, AGENT_SUBSCRIPTION_ONLY: '1', AGENT_AUTO_ANSWER: '0', AGENT_ATTEMPT_ID: intent.id, BUDGET_ROLE: 'worker',
      ...(selected.harness === 'codex' ? { CODEX_MODEL_OVERRIDE: selected.model } : {}) } };
}
export function makeBuildAdapters({ dataDir = DATA, runDir = RUN, env = process.env, exec = runExec, spawnDetached } = {}) {
  async function route(role, input) {
    const task = `F36 ${role} role recommendation. ${input.recommendations.identity.name}. Tier ${input.recommendations.tier || 'T4'}. Independent audit required. Select a subscription role; preserve all owner holds.`;
    const r = await exec(process.execPath, [path.join(runDir, 'bin', 'jev-route.mjs'), task], { env });
    const line = String(r.stdout || '').split('\n').reverse().find(x => x.startsWith('{'));
    if (!line) throw new Error('Jev returned no decision');
    const result = JSON.parse(line);
    let choice;
    try { choice = rolePick({ pick: result.pick, effort: result.effort }); }
    catch (e) { e.code = 'INVALID_RECOMMENDATION'; throw e; }
    // F36's fallback is Sonnet, never a new provider choice hidden by a router error.
    if (result.error) choice = { pick: 'claude-sonnet', effort: 'medium' };
    // Only return known fields; router stdout and environment never enter launch cards.
    return { ...choice, chooser: result.error || result.disabled ? 'fallback' : 'Jev', evidence: `jev-route decision sha256:${hash(line)}`, ...(result.error ? { error: 'Jev unavailable' } : {}), ...(result.disabled ? { disabled: true } : {}) };
  }
  async function admit(build) {
    if (!fs.existsSync(path.join(runDir, 'bin', 'agent.sh')) || !fs.existsSync(path.join(runDir, 'bin', 'budget.mjs'))) return { ok: false, reason: 'Connect the canonical tracked agent.sh and existing budget admission first' };
    const checks = [];
    for (const role of ROLES) {
      const selected = MODEL_ROUTES[build.answers.roles[role].pick], provider = selected.provider === 'anthropic' ? 'claude' : selected.provider === 'opencode-go' ? 'go' : selected.provider;
      // Existing budget router owns role floors, holds, quota and subscription modes.
      const r = await exec(process.execPath, [path.join(runDir, 'bin', 'budget.mjs'), 'gate', provider, role === 'auditor' ? 'audit' : 'worker', '-', String(process.pid)], { env });
      if (r.code !== 0) return { ok: false, reason: `${role} provider/role admission refused or unavailable (${provider}); inspect existing budget gates` };
      checks.push({ role, provider, evidenceHash: hash(String(r.stdout || '')) });
    }
    return { ok: true, evidence: checks };
  }
  async function dispatch(intent) {
    const b = intent.build, w = b.answers.roles.worker;
    // decisions-gate (was jev-gate): the run folder's copy first, then the bundled add-on. The [jev...] tags below are the
    // old tag names, which every guard version accepts.
    const gateFile = ['decisions-gate', 'jev-gate'].map((n) => path.join(runDir, 'bin', n)).find((f) => fs.existsSync(f))
      || path.resolve(import.meta.dirname, '../../tools/addons/decisions-gate');
    const task = `Build ${b.answers.identity.name} at ${b.answers.tier}; spec ${b.source.specPath}.`;
    const fresh = await exec('python3', [gateFile, 'check', task], { env });
    const match = String(fresh.stdout || '').match(/Jev picked ([\w-]+).*?effort ([\w]+)\./s);
    if (!match) throw new Error('Fresh Jev evidence unavailable; reconcile this attempt before another launch');
    let tag = `[jev: ${w.pick} ${w.effort}]`;
    if (match[1] !== w.pick || match[2] !== w.effort) {
      if (w.chooser !== 'owner' || !b.source.ownerQuoteFile) throw new Error('Jev recommendation changed; fresh Jev differs from pinned role. Create a new intake or provide a verified owner override');
      const quote = b.answerEvidence?.roles?.evidence;
      if (typeof quote !== 'string' || quote.includes('"') || quote.includes('\n') || quote.trim().split(/\s+/).length < 3) throw new Error('Owner model override requires a genuine transcript quote of at least three words');
      tag = `[jev-override: owner-asked with "${quote}"]`;
    }
    const prompt = `Read ${b.source.specPath} and implement the pinned build contract at ${intent.configFile}.\n` +
      `Required tests: ${JSON.stringify(b.answers.tests)}. Tier: ${b.answers.tier}.\n` +
      `Role assignments (requested): ${JSON.stringify(b.answers.roles)}. Independent audit and bounded repair (${b.defaults.values.repairLimit}) remain required; worker rc0 is not acceptance.\n` +
      `Preserve existing gates, permissions, holds and repository locks. Write a report and checkpoints in ${intent.outdir}. No automatic install or outward action.\n[plan: ${intent.plan}]\n${tag}\n`;
    // Write the prompt once; recovery never changes pinned inputs.
    const promptRecord = path.join(intent.outdir, 'prompt-record.json');
    if (!publish(promptRecord, { prompt, sha256: hash(prompt) })) {
      const old = JSON.parse(fs.readFileSync(promptRecord, 'utf8'));
      if (old.sha256 !== hash(prompt)) throw new Error('Pinned prompt differs; reconcile without spawning');
    }
    const fd = fs.openSync(intent.promptFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, prompt); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const c = buildDispatchCommand(intent, { runDir, env: { ...env, AGENTGLIM_DATA: dataDir, JOBS_TRACK_DIR: path.join(dataDir, 'tracked-jobs') } });
    if (spawnDetached) return spawnDetached(c);
    const log = fs.openSync(path.join(intent.outdir, 'dispatcher.log'), 'a', 0o600);
    try {
      const child = spawn(c.bin, c.args, { cwd: b.source.repository, env: c.env, shell: false, detached: true, stdio: ['ignore', log, log], windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { fs.closeSync(log); }
    // No synthesized running receipt. A later recover reads the canonical job register, including fast exits.
    return { state: 'dispatched; registration pending' };
  }
  const jobs = () => [...new Map([...jobRecords(path.join(dataDir, 'tracked-jobs', '_archive')), ...jobRecords(path.join(dataDir, 'tracked-jobs'))].map(j => [j.id, j])).values()];
  return { dataDir, runDir, route, admit, dispatch, jobs,
    workerLiveness(record, options) {
      const all = jobs();
      const registered = all.filter(j => record.receipts.some(r => r.jobId === j.id &&
        (!liveWorkers?.pidIdentity(r) || !liveWorkers?.pidIdentity(j) || liveWorkers.sameLineage(r, j, options))));
      if (!registered.length) return { available: false, state: 'unverified', reason: 'Canonical receipt identity not found in current/archive job records' };
      // Receipt IDs bind this build; only F31-verified lineage may attach other discoveries.
      const tracked = all.filter(j => registered.includes(j) || registered.some(seed => liveWorkers?.sameLineage(seed, j, options)));
      return workerLiveness({ tracked }, options);
    } };
}
