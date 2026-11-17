import { hash, positive, text, id } from './contracts.mjs';
export function priceTokens(tokens, rate) {
  if (!rate?.version || !rate.model || !rate.source) throw new Error('versioned model price required');
  let total = 0;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (!Number.isFinite(tokens?.[k]) || tokens[k] < 0 || !Number.isFinite(rate[k]) || rate[k] < 0) throw new Error('incomplete token/price data');
    total += tokens[k] * rate[k] / 1e6;
  }
  return total;
}
// Calibration requires an account-exclusive interval, same window/reset, increasing cumulative meter and token-priced cost.
// Shared/unattributed activity is never silently assigned to this run.
export function calibrate(pairs, now, freshnessMs = 120000) {
  const valid = pairs.filter(p => p.exclusive === true && p.provider && p.window && p.resetId && p.beforeResetId === p.resetId && p.to > p.from && p.to <= now && now - p.to <= freshnessMs && p.afterPct > p.beforePct && p.beforePct >= 0 && p.afterPct <= 100 && p.apiEquivalentUsd > 0);
  if (!valid.length) throw new Error('no fresh attributable calibration');
  const key = p => `${p.provider}:${p.window}:${p.resetId}`;
  if (new Set(valid.map(key)).size !== 1) throw new Error('mixed calibration windows');
  const ordered = [...valid].sort((a,b) => a.from - b.from);
  if (ordered.some((p,i) => i && p.from < ordered[i-1].to)) throw new Error('overlapping calibration samples');
  const dollars = valid.reduce((n,p) => n + p.apiEquivalentUsd, 0), points = valid.reduce((n,p) => n + p.afterPct - p.beforePct, 0);
  return { provider: valid[0].provider, window: valid[0].window, resetId: valid[0].resetId, pointsPerUsd: points / dollars,
    at: Math.max(...valid.map(p => p.to)), samples: valid.length, sourceHash: hash(ordered), estimate: true };
}
export function account(ledger, event) {
  text(event.id, 'usage event'); text(event.operationId, 'operation'); text(event.provider, 'provider');
  if (!Number.isFinite(event.at)) throw new Error('usage timestamp required');
  if (event.wrapper || event.complete !== true) throw new Error('only complete leaf usage is accountable');
  const cost = priceTokens(event.tokens, event.price);
  const old = ledger.find(x => x.id === event.id || x.operationId === event.operationId);
  if (old) { if (hash(old) !== hash({ ...event, apiEquivalentUsd: cost })) throw new Error('conflicting duplicate usage'); return false; }
  ledger.push({ ...event, apiEquivalentUsd: cost }); return true;
}
export const needsLiveUsage = run => [...Object.keys(run.budget.targets), ...Object.keys(run.budget.hardCeilings)].some(m => m !== 'hours');
// Snapshots are authenticated host observations, cumulative for one operation,
// never account-wide deltas. Keep them after cancellation and final settlement.
export function recordUsageSnapshot(run, snapshot, verify, now) {
  if (typeof verify !== 'function' || !verify(snapshot)) throw new Error('untrusted active usage snapshot');
  if (snapshot.schemaVersion !== 1 || snapshot.runId !== run.contract.runId || snapshot.operationId !== run.pendingOperation?.id ||
      !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 || !Number.isFinite(snapshot.at) || snapshot.at > now ||
      snapshot.cumulative !== true || snapshot.wrapper || typeof snapshot.epoch !== 'string' || !snapshot.epoch || !snapshot.source || !snapshot.sourceHash) throw new Error('invalid active usage identity');
  id(snapshot.provider); priceTokens(snapshot.tokens, snapshot.price);
  run.operationUsage ||= {};
  const old = run.operationUsage[snapshot.operationId];
  if (old) {
    if (snapshot.sequence === old.sequence && hash(old) === hash(snapshot)) return false;
    if (snapshot.sequence <= old.sequence || snapshot.at < old.at || snapshot.provider !== old.provider || snapshot.epoch !== old.epoch ||
        hash(snapshot.price) !== hash(old.price) || Object.keys(old.tokens).some(k => snapshot.tokens[k] < old.tokens[k])) throw new Error('active usage reset/conflict');
  }
  run.operationUsage[snapshot.operationId] = structuredClone(snapshot); return true;
}
export function usageEntries(run) {
  const finalized = new Set(run.ledger.map(e=>e.operationId));
  return [...run.ledger, ...Object.values(run.operationUsage || {}).filter(s=>!finalized.has(s.operationId)).map(s=>({...s,apiEquivalentUsd:priceTokens(s.tokens,s.price)}))];
}
export function settleUsage(run, event) {
  const snapshot = run.operationUsage?.[event.operationId];
  if (snapshot && (event.provider !== snapshot.provider || hash(event.price) !== hash(snapshot.price) || event.at < snapshot.at ||
      Object.keys(snapshot.tokens).some(k=>event.tokens?.[k] < snapshot.tokens[k]))) throw new Error('final usage below observed consumption');
  return account(run.ledger,event);
}
export function consumption(run, now, telemetry = {}) {
  const totals = { hours: Math.max(0, now - run.started) / 3600000, apiEquivalentUsd: usageEntries(run).reduce((n,e) => n + e.apiEquivalentUsd, 0) };
  const errors = [], estimates = {}, costBasis = {};
  const metrics = new Set([...Object.keys(run.budget.targets), ...Object.keys(run.budget.hardCeilings)]);
  const fresh = x => x && Number.isFinite(x.at) && x.at <= now && now - x.at <= run.budget.freshnessMs;
  if ([...metrics].some(m => m !== 'hours')) {
    if (!fresh(telemetry.usage) || telemetry.usage.complete !== true || telemetry.usage.runId !== run.contract.runId) errors.push('usage telemetry missing/stale/incomplete');
    if (telemetry.usage?.liveAccounting !== true) errors.push('active usage accounting unavailable');
    if (run.pendingOperation) {
      const active = run.operationUsage?.[run.pendingOperation.id];
      if (!fresh(active)) errors.push('active usage snapshot missing/stale');
    }
    if (run.ledger.some(e => e.at > now)) errors.push('future usage record');
  }
  for (const metric of metrics) {
    if (!metric.startsWith('window:')) continue;
    const [, provider, window] = metric.split(':'), rate = telemetry.calibrations?.[metric], meter = telemetry.meters?.[metric];
    if (!fresh(rate) || !fresh(meter) || !rate.estimate || typeof rate.sourceHash !== 'string' || !rate.sourceHash || rate.provider !== provider || rate.window !== window || rate.resetId !== meter.resetId || !(rate.pointsPerUsd > 0)) { errors.push(`${metric}: missing/stale/reset calibration`); continue; }
    const usd = usageEntries(run).filter(e => e.provider === provider).reduce((n,e) => n + e.apiEquivalentUsd, 0);
    // Persisted prior-rate contributions survive resets: new calibrated windows do not erase consumption.
    costBasis[metric] = usd;
    const previous = run.windowAccrued?.[metric] || { points: 0, usd: 0 };
    totals[metric] = previous.points + Math.max(0, usd - previous.usd) * rate.pointsPerUsd;
    estimates[metric] = { estimate: true, pointsPerUsd: rate.pointsPerUsd, priceBasis: 'versioned API equivalent; not subscription bill', resetId: rate.resetId, at: rate.at, sourceHash: rate.sourceHash, providerMeter: meter };
  }
  return { totals, errors, estimates, costBasis };
}
export function budgetBarrier(run, now, telemetry) {
  const c = consumption(run, now, telemetry), reached = [];
  for (const [kind, limits] of [['hardCeiling', run.budget.hardCeilings], ['target', run.budget.targets]]) for (const [metric, limit] of Object.entries(limits)) if (c.totals[metric] >= limit) reached.push({ kind, metric, limit, actual: c.totals[metric] });
  return { ...c, pause: c.errors.length > 0 || reached.length > 0, reached };
}
export function extendBudget(run, proposal, approval, verifyApproval, now) {
  if (!proposal || !['targets', 'hardCeilings'].includes(proposal.kind)) throw new Error('invalid extension');
  if (!Object.hasOwn(run.budget[proposal.kind], proposal.metric)) throw new Error('cannot add an uncontracted metric');
  positive(proposal.value, 'new target');
  const old = run.budget[proposal.kind][proposal.metric];
  if (proposal.value <= old) throw new Error('extension must increase target');
  const hard = run.budget.hardCeilings[proposal.metric];
  if (proposal.kind === 'targets' && hard !== undefined && proposal.value > hard) throw new Error('owner hard ceiling remains binding');
  if (!verifyApproval(approval, { type: proposal.kind === 'hardCeilings' ? 'hardCeiling' : 'budgetExtension', scope: hash(proposal), authorities: proposal.kind === 'hardCeilings' ? ['owner'] : ['owner', 'superagent'], now })) throw new Error('budget approval required');
  run.extensions.push({ proposal, old, approval }); run.budget[proposal.kind][proposal.metric] = proposal.value;
}
