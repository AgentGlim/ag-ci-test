// working.mjs: one list of the agents really running on a project row (2026-11-13, agent-icons fix).
// F31 (2026-11-16): identity, wrapper folding and the canonical live population now live in
// live-workers.mjs, shared with the Status card and count-check. This module keeps the row API
// (agentsOf, foldWrappers, normDir) and the SuperAgent transcript helper. Pure code, no I/O
// except an optional realpath inside live-workers.mjs.
export { normDir, makeRealCache, pidIdentity, requestIdentity, parentIdentity, sameLineage, foldWrappers, agentsOf, livePopulation, canonicalLiveCount, isActive } from './live-workers.mjs';

// SuperAgent row: transcript helpers (superagent.mjs) and tracked records (`all`, with statusOf = shownStatus).
// Only its own work counts: a helper whose record sits on a plan or has finished is dropped; plan headless takes and
// plan-tagged subagents stay on their plan rows. Returns { helpers, run }: helpers kept, plus own running records not
// already drawn as a helper.
export function superagentLive(wrLive = [], all = [], statusOf = (j) => j.status) {
  const byAgent = new Map(all.filter((j) => j && j.agentId).map((j) => [j.agentId, j]));
  const helpers = wrLive.filter((h) => { const j = byAgent.get(h.id); return !j || (j.project === 'SuperAgent' && statusOf(j) === 'running'); });
  const seen = new Set(helpers.map((h) => h.id));
  const run = all.filter((j) => j && j.project === 'SuperAgent' && statusOf(j) === 'running' && !seen.has(j.agentId) && !seen.has(j.id));
  return { helpers, run };
}
