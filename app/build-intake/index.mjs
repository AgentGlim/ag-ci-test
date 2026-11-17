import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA, append, latest, sequenceFile, read, publish, hash, clone, assertKeys, owner, safeInput } from './durable.mjs';
import { DEFAULTS, GROUPS, ROLES, validateDefaults, validateAnswer, rolePick, configuration, checkCoverage } from './registry.mjs';
import { render } from './render.mjs';
export { checkCoverage } from './registry.mjs';

export function createBuildIntake({ dataDir, runDir, route, admit, dispatch, jobs = () => [], workerLiveness, now = () => new Date().toISOString(), fault = () => {} }) {
  if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(runDir || '')) throw new Error('Private dataDir and runDir required');
  const root = path.join(dataDir, 'build-intake'), defaultsDir = path.join(root, 'defaults'), buildsDir = path.join(root, 'builds');
  const dir = (id) => { if (!/^b-[a-f0-9]{24}$/.test(id)) throw new Error('Invalid build ID'); return path.join(buildsDir, id); };
  const get = (id) => { const r = latest(dir(id)); if (!r) throw new Error('Build not found'); return r; };
  function records() {
    let names; try { names = fs.readdirSync(buildsDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.filter(x => /^b-[a-f0-9]{24}$/.test(x)).map(get);
  }
  function defaults(version) {
    if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 99999999)) throw new Error('Invalid defaults version');
    const d = version === undefined ? latest(defaultsDir) : read(sequenceFile(defaultsDir, version));
    if (!d || d.schemaVersion !== SCHEMA) throw new Error('Setup build defaults missing or unsupported; run setup first');
    validateDefaults(d.values);
    return { ...d, file: sequenceFile(defaultsDir, d.version) };
  }
  function initializeDefaults() {
    if (!latest(defaultsDir)) append(defaultsDir, { version: 1, values: validateDefaults({ ...DEFAULTS }), origin: 'recommended setup default', createdAt: now() });
    return defaults();
  }
  function previewDefaults(patch, request) {
    const chosen = owner(request), d = defaults();
    assertKeys(patch, Object.keys(DEFAULTS), 'defaults');
    const values = validateDefaults({ ...d.values, ...patch });
    const diff = Object.keys(DEFAULTS).filter(k => hash(d.values[k]) !== hash(values[k])).map(k => `${k}: ${JSON.stringify(d.values[k])} -> ${JSON.stringify(values[k])}`).join('\n');
    if (!diff) throw new Error('No defaults changes requested');
    const p = { schemaVersion: SCHEMA, baseVersion: d.version, values, request: chosen, diff, diffHash: hash(diff), createdAt: now() };
    p.id = hash(p); publish(path.join(root, 'previews', `${p.id}.json`), p);
    return p;
  }
  function applyDefaults(id, shownDiffHash) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown defaults preview');
    const p = read(path.join(root, 'previews', `${id}.json`));
    if (!p || p.diffHash !== shownDiffHash) throw new Error('Show the preview diff before applying its diffHash');
    const d = defaults();
    if (d.version !== p.baseVersion) throw new Error('Stale or already applied defaults preview; show a fresh diff');
    validateDefaults(p.values); owner(p.request);
    const won = append(defaultsDir, { version: d.version + 1, values: p.values, origin: 'owner', request: p.request, diff: p.diff, diffHash: p.diffHash, createdAt: now() }, d.sequence);
    if (!won) throw new Error('Stale defaults preview; another version was applied');
    return defaults();
  }
  const rounds = (r) => GROUPS.map(id => ({ id, recommended: clone(r.recommendations[id]), answered: Object.hasOwn(r.answers, id),
    reason: id === 'roles' ? 'Jev prefill per role; explicit acceptance or override required' : 'Per-build owner decision; explicit none is allowed for deadline/dependencies' }));
  function update(r, fields) {
    const next = { ...r, ...fields, updatedAt: now() };
    next.missing = GROUPS.filter(g => !Object.hasOwn(next.answers, g));
    if (next.state === 'intake') next.config = configuration(next);
    next.rounds = rounds(next);
    if (!append(dir(r.id), next, r.sequence)) throw new Error('Concurrent build change; reload this build and retry');
    return get(r.id);
  }
  async function begin(input) {
    assertKeys(input, ['requestKey', 'context', 'source', 'recommendations'], 'intake'); safeInput(input);
    assertKeys(input.context, ['session', 'entry'], 'context');
    if (input.context.session !== 'SuperAgent' || input.context.entry !== 'chat') throw new Error('F36 v1 supports SuperAgent chat launches only');
    if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 300) throw new Error('Stable chat requestKey required for idempotency');
    assertKeys(input.source, ['repository', 'featureDirectory', 'specPath', 'sourceRevision', 'parentItem', 'plan', 'ownerQuoteFile'], 'source');
    for (const k of ['repository', 'featureDirectory', 'specPath']) if (typeof input.source[k] !== 'string' || !path.isAbsolute(input.source[k])) throw new Error(`source.${k} must be an absolute path`);
    for (const k of ['parentItem', 'plan', 'ownerQuoteFile']) if (input.source[k] !== undefined && (typeof input.source[k] !== 'string' || !input.source[k].trim())) throw new Error(`source.${k} must be a nonempty string`);
    if (input.source.ownerQuoteFile && !path.isAbsolute(input.source.ownerQuoteFile)) throw new Error('source.ownerQuoteFile must be an absolute transcript path');
    if (input.source.plan && !/^\d\d-[a-z0-9][a-z0-9-]*$/.test(input.source.plan)) throw new Error('source.plan must be a canonical plan ID');
    if (typeof input.source.sourceRevision !== 'string' || !input.source.sourceRevision.trim()) throw new Error('sourceRevision required');
    assertKeys(input.recommendations, GROUPS.filter(x => x !== 'roles'), 'recommendations');
    const id = `b-${hash(input.requestKey).slice(0, 24)}`, fingerprint = hash(input), old = latest(dir(id));
    if (old) { if (old.fingerprint !== fingerprint) throw new Error('Idempotency key already belongs to a different request'); return old; }
    const recommendations = { identity: { name: 'New build', type: 'task', parent: input.source.plan || null }, priority: 'P2', tier: 'T4', deadline: null, tests: ['Run project acceptance tests'], dependencies: [], ...clone(input.recommendations), roles: {} };
    for (const role of ROLES) {
      let result;
      try {
        if (!route) throw new Error('Jev adapter unavailable');
        result = await route(role, { ...clone(input), recommendations: clone(recommendations) });
      } catch (e) {
        if (e.code === 'INVALID_RECOMMENDATION') throw e;
        result = { pick: 'claude-sonnet', effort: 'medium', chooser: 'fallback', evidence: 'Jev unavailable; existing Sonnet fallback; admission required' };
      }
      rolePick({ pick: result.pick, effort: result.effort });
      recommendations.roles[role] = { ...rolePick({ pick: result.pick, effort: result.effort }), chooser: result.error || result.disabled || result.chooser === 'fallback' ? 'fallback' : 'Jev', evidence: result.evidence || 'Jev router decision', reason: result.error ? 'Jev failure; existing gated fallback' : 'Per-role recommendation' };
    }
    const d = defaults(), r = { schemaVersion: SCHEMA, id, fingerprint, requestKeyHash: hash(input.requestKey), context: input.context, source: clone(input.source), defaults: d, defaultsVersion: d.version, recommendations,
      answers: {}, answerEvidence: {}, mode: 'ask', missing: [...GROUPS], state: 'intake', receipts: [], observations: [], reviewCount: review().count, createdAt: now(), updatedAt: now() };
    r.config = configuration(r); r.rounds = rounds(r);
    const won = append(dir(id), r), saved = get(id);
    if (!won && saved.fingerprint !== fingerprint) throw new Error('Idempotency key already belongs to a different request');
    return saved;
  }
  function answer(id, group, value, request) {
    const who = owner(request), r = get(id);
    if (r.state !== 'intake') throw new Error('Build settings are immutable after dispatch intent; create a new build');
    let v = validateAnswer(group, value);
    if (group === 'roles') v = Object.fromEntries(ROLES.map(role => {
      const choice = rolePick(v[role]), rec = r.recommendations.roles[role], same = choice.pick === rec.pick && choice.effort === rec.effort;
      return [role, { ...choice, chooser: same ? rec.chooser : 'owner', reason: same ? rec.reason : 'Explicit owner override', evidence: same ? rec.evidence : who.evidence, acceptedBy: 'owner', answerEvidence: who.evidence }];
    }));
    return update(r, { answers: { ...r.answers, [group]: v }, answerEvidence: { ...r.answerEvidence, [group]: who } });
  }
  function review() {
    const count = records().filter(r => r.receipts.length).length;
    const file = path.join(root, 'review.json');
    if (count >= 10 && !read(file)) publish(file, { schemaVersion: SCHEMA, id: 'ten-launch-review', at: now(), question: 'After 10 launches, would you like to unlock recommended mode in a future version?', groups: [...GROUPS], mode: 'ask', available: false });
    const request = read(file), decision = read(path.join(root, 'review-decision.json'));
    return { count, mode: 'ask', request: request ? { ...request, ...(decision ? { decision } : {}) } : null };
  }
  function recordReview(request) {
    const who = owner(request); if (!review().request) throw new Error('Ten-launch review not due');
    if (typeof request.unlock !== 'boolean') throw new Error('Review decision needs unlock true/false; recommended mode remains unavailable');
    publish(path.join(root, 'review-decision.json'), { ...who, at: now(), mode: 'ask', supported: false });
    return review();
  }
  function reconcile(r) {
    if (!r.attempt) return r;
    const candidates = jobs().filter(j => j && j.id && typeof j.outdir === 'string' && path.resolve(j.outdir) === path.resolve(r.attempt.outdir) && j.project === r.attempt.plan && /^agent\.sh(?:\s|$)/.test(j.launcher || ''));
    if (candidates.length > 1) {
      if (r.state !== 'uncertain') return update(r, { state: 'uncertain', observations: [...r.observations, { at: now(), reason: 'Multiple tracked jobs for one attempt; reconcile manually' }] });
      return r;
    }
    const job = candidates[0];
    if (!job) {
      if (['dispatching', 'registered'].includes(r.state)) return update(r, { state: 'uncertain', observations: [...r.observations, { at: now(), reason: 'No matching job receipt; do not relaunch' }] });
      return r;
    }
    const receipt = { jobId: job.id, attemptId: r.attempt.id, outdir: job.outdir, project: job.project, trackedStatus: job.status || 'unknown', pid: job.pid || null, pidStart: job.pidStart || null,
      registeredHarness: job.harness || null, registeredModel: job.model || null, sourceHash: hash(job), observedAt: now(), evidence: 'existing tracked-jobs registration; live execution unverified' };
    if (r.receipts.some(x => x.sourceHash === receipt.sourceHash)) return r;
    const state = ['done', 'failed', 'stopped'].includes(job.status) ? `worker-${job.status}` : 'registered';
    const saved = update(r, { receipts: [...r.receipts, receipt], state }); review(); return saved;
  }
  async function recover(id) {
    const r = get(id);
    try { return reconcile(r); } catch (e) { if (/Concurrent build change/.test(e.message)) return get(id); throw e; }
  }
  async function attemptLaunch(id) {
    let r = get(id);
    if (!['intake', 'prepared'].includes(r.state)) return recover(id);
    if (r.missing.length) throw new Error(`Owner answers required: ${r.missing.join(', ')}`);
    for (const g of GROUPS) validateAnswer(g, r.answers[g]);
    // Model diversity is not evidence of independence; the existing loop must supply separate audit context.
    if (r.answers.dependencies.some(dep => !records().some(x => x.id === dep && x.state === 'worker-done') && !jobs().some(j => j.id === dep && j.status === 'done' && j.rc === 0))) throw new Error('Dependencies require canonical completion evidence; no dependency can be assumed complete');
    if (r.answers.deadline && Date.parse(r.answers.deadline) <= Date.parse(now())) throw new Error('Build deadline has elapsed');
    if (!admit || !dispatch) throw new Error('Canonical agent.sh admission/dispatch adapter not connected');
    const gate = await admit(clone(r));
    if (!gate?.ok) throw new Error(`Launch refused: ${gate?.reason || 'existing admission unavailable'}`);
    // CAS again after async admission: only one process can own dispatch intent.
    if (get(id).sequence !== r.sequence) return recover(id);
    if (r.state === 'intake') {
      const attempt = { id: `${id}-a1`, at: now(), plan: r.answers.identity.parent || r.source.plan,
        outdir: path.join(dir(id), 'attempts', 'a1'), promptFile: path.join(dir(id), 'attempts', 'a1', 'prompt.md'), configFile: path.join(dir(id), 'attempts', 'a1', 'config.json') };
      if (!/^\d\d-[a-z0-9][a-z0-9-]*$/.test(attempt.plan || '')) throw new Error('Root project launch requires source.plan for canonical tracking');
      try { r = update(r, { state: 'prepared', attempt, lastRefusal: null, admission: { ...gate, at: now() } }); }
      catch (e) { if (/Concurrent build change/.test(e.message)) return recover(id); throw e; }
      fault('after-intent');
    }
    const snapshot = { config: r.config, id: r.id, defaultsVersion: r.defaultsVersion, answers: r.answers, source: r.source };
    publish(r.attempt.configFile, snapshot);
    // The dispatcher owns prompt creation; the pinned record already exists before any possible spawn.
    try { r = update(r, { state: 'dispatching' }); }
    catch (e) { if (/Concurrent build change/.test(e.message)) return recover(id); throw e; }
    await dispatch({ ...clone(r.attempt), build: clone(r), config: clone(r.config) });
    fault('after-spawn');
    return recover(id);
  }
  async function launch(id) {
    try { return await attemptLaunch(id); } catch (e) {
      const r = get(id);
      try { update(r, { lastRefusal: { message: e.message, at: now() }, observations: [...r.observations, { at: now(), refusal: e.message }] }); }
      catch (conflict) { if (!/Concurrent build change/.test(conflict.message)) throw conflict; }
      throw e;
    }
  }
  function summary(id) {
    const r = get(id), liveness = r.attempt && workerLiveness ? workerLiveness(r, { now: Date.parse(now()) }) : null;
    const s = render(r, review().count, liveness);
    publish(path.join(dir(id), 'summaries', `${s.sourceHash}.json`), { schemaVersion: SCHEMA, ...s, buildId: id, defaultsVersion: r.defaultsVersion });
    return s;
  }
  function reply(id, context, text) { return context?.session === 'SuperAgent' && context?.entry === 'chat' ? summary(id).cards : text; }
  const changeSettings = (id) => { get(id); throw new Error('Running/pinned build settings are immutable in v1; start a new build'); };
  return { initializeDefaults, defaults, previewDefaults, applyDefaults, begin, answer, get, launch, recover, summary, reply, review, recordReview, changeSettings, checkCoverage };
}
