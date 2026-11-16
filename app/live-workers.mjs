// live-workers.mjs: one canonical answer to "which workers are live right now?" (F31, 2026-11-16).
//
// The Status card, a project row's work icons and _run/bin/count-check.mjs used to count different
// populations. Here one pure function decides identity and classification:
//
//   identity   = pid + process start ticks when both are known, else a verified request/dispatch
//                lineage key (matching non-empty `req`, or a parent pid/start pair that names the other
//                record). An outdir is a location, never an identity. A label is never an identity.
//   confidence = 'live'    the worker has process/harness/heartbeat evidence
//                'unknown' a running record with no liveness evidence on this host (counted separately,
//                          never silently promoted to live)
//   population = live workers, idle entries, unseen notices, and saved/attempt history are distinct
//                buckets. History and notices are never counted as workers and are never rewritten.
//
// No I/O besides an optional realpath (path normalisation) and the injected `alive` callback.

import fs from 'node:fs';
import { procRoot, readProcessStat } from './proc.mjs';

// ---------- path normalisation ----------
// Successes are cached (a real path does not change while the process runs). Failures are cached for a
// short TTL only: a failed lookup must not poison an alias that is created a moment later (audit finding 3).
const REAL_TTL_MS = 5000, REAL_MAX = 5000;
export function makeRealCache(ttlMs = REAL_TTL_MS) {
  const cache = new Map();
  return function norm(d, real = true) {
    if (!d || typeof d !== 'string') return null;
    let s = d.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!real) return s;
    const hit = cache.get(s);
    if (hit && (hit.ok || Date.now() - hit.at < ttlMs)) return hit.v;
    let v = s, ok = false;
    try { v = fs.realpathSync(s).replace(/\\/g, '/'); ok = true; } catch { ok = false; }
    if (cache.size > REAL_MAX) cache.clear();
    cache.set(s, { v, ok, at: Date.now() });
    return v;
  };
}
const defaultNorm = makeRealCache();
export const normDir = (d, real = true) => defaultNorm(d, real);

// ---------- identity ----------
const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

// Start tokens are Linux ticks, Windows FILETIME strings, or macOS's opaque ps lstart.
const startToken = (x) => typeof x === 'number' ? (Number.isFinite(x) && x > 0 ? String(x) : null)
  : typeof x === 'string' && (/^[1-9]\d*$/.test(x) || /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(x)) ? x : null;
// Only a pid together with its start token is an identity: a bare pid can be reused by the OS.
export function pidIdentity(j) {
  const pid = num(j?.pid), start = startToken(j?.pidStart);
  return pid && start ? `pid:${pid}:${start}` : null;
}
// Verified request lineage: the launcher's request token, shared by wrapper and take records.
export function requestIdentity(j) {
  // A request pathname is reusable. Only a verified immutable dispatch generation identifies a take.
  const generation = str(j?.dispatchGeneration);
  return j?.dispatchVerified === true && generation ? `dispatch:${generation}` : null;
}
// A parent's pid+start, declared on the child, is verified process lineage.
export function parentIdentity(j) {
  const pid = num(j?.parentPid ?? j?.ppid), start = startToken(j?.parentStart);
  return pid && start ? `pid:${pid}:${start}` : null;
}
// Live process ancestry: Map(pid -> start ticks) from this pid up to init. Read-only /proc.
export function readAncestry(pid, { limit = 40 } = {}) {
  const chain = new Map();
  let p = num(pid);
  for (let i = 0; p && p > 1 && i < limit; i++) {
    let stat;
    try { stat = fs.readFileSync(`${procRoot()}/${p}/stat`, 'utf8'); } catch { break; }
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = num(rest[19]), ppid = num(rest[1]);
    if (!start) break;
    chain.set(p, String(start));
    p = ppid;
  }
  return chain;
}
// The ancestor's pid must appear in the descendant's live ancestry with the SAME start ticks: PID reuse
// and an unrelated later take never match. Injected for tests; default reads /proc.
export function processLineage(a, b, ancestryOf = readAncestry) {
  const pa = pidIdentity(a), pb = pidIdentity(b);
  if (!pa || !pb || pa === pb) return false;
  const ca = ancestryOf(num(a.pid));
  if (ca && ca.get(num(a.pid)) === String(num(a.pidStart)) && ca.get(num(b.pid)) === String(num(b.pidStart))) return true;  // b is a's ancestor
  const cb = ancestryOf(num(b.pid));
  if (cb && cb.get(num(b.pid)) === String(num(b.pidStart)) && cb.get(num(a.pid)) === String(num(a.pidStart))) return true;  // a is b's ancestor
  return false;
}

// True only when two records provably describe the same worker/dispatch lineage.
export function sameLineage(a, b, { ancestryOf } = {}) {
  if (!a || !b) return false;
  const pa = pidIdentity(a), pb = pidIdentity(b);
  if (pa && pa === pb) return true;
  const ra = requestIdentity(a), rb = requestIdentity(b);
  if (ra && ra === rb) return true;
  return processLineage(a, b, ancestryOf);
}

const isWrapper = (j) => !!j && /^agent\.sh/.test(j.launcher || '');
const isTake = (j) => !!j && !isWrapper(j) && (!!j.req || !!j.requestId || /^headless-take/.test(j.launcher || ''));

// Fold a wrapper into its take only with verified lineage. Common outdir + time ordering is not
// lineage (audit finding 2): two unrelated runs can reuse one outdir at any later time.
export function foldWrappers(list, { real = true, norm = normDir, ancestryOf } = {}) {
  const takes = list.filter(isTake);
  if (!takes.length) return list;
  const drop = new Set(), into = new Map();
  for (const w of list) {
    if (!isWrapper(w)) continue;
    const t = takes.find((x) => sameLineage(w, x, { ancestryOf }) &&
      (x.started || 0) >= (w.started || 0) - 5000 &&
      (w.status === 'running' || (w.ended || Infinity) >= (x.started || 0) - 5000));
    if (!t || drop.has(w)) continue;
    drop.add(w); into.set(t, [...(into.get(t) || []), w]);
  }
  return list.filter((j) => !drop.has(j)).map((j) => {
    const wrappers = into.get(j); if (!wrappers) return j;
    const w = wrappers[0];
    const status = j.status === 'running' || (w.status === 'running' && j.status == null) ? 'running' : j.status;
    const st = [j.started, w.started].filter(Boolean);
    return { ...j, status, lineageRecords: [...wrappers, ...(j.lineageRecords || [])], rawIds: [...new Set([...(j.rawIds || [j.id]), ...wrappers.flatMap(w => w.rawIds || [w.id])].filter(Boolean))], wrapperOf: w.id, started: st.length ? Math.min(...st) : j.started };
  });
}

// ---------- shared evidence and population ----------
const HISTORY = new Set(['done', 'failed', 'stopped', 'error', 'skipped', 'archived']);
const IDLE = new Set(['idle', 'paused', 'waiting']);
export const HEARTBEAT_MS = 30 * 60e3;
export function localProcessLive(j) {
  if (!pidIdentity(j)) return null;
  const st = readProcessStat(j.pid);
  return st ? String(st.starttime) === String(j.pidStart) && st.state !== 'Z' : null;
}
export function workerState(j, { isLive = localProcessLive, now = Date.now() } = {}) {
  if (!j || HISTORY.has(j.status) || j.rc != null && String(j.rc).trim() !== '' || j.activity === 'finished') return 'history';
  if (IDLE.has(j.status) || j.idle || j.paused || j.stopped || j.waiting || j.activity === 'idle') return 'idle';
  // A PID record cannot be rescued by its own recent heartbeat after that process generation died.
  if (pidIdentity(j)) return isLive(j) === true ? 'live' : 'unknown';
  if (j.pid) return 'unknown';
  const hb = Number(j.heartbeat);
  if (hb > 0 && now >= hb && now - hb < HEARTBEAT_MS) return 'live';
  if (j.transcriptVerified === true && j.parentVerified === true && j.activity === 'running' &&
      Number(j.lastActivity) > 0 && now >= j.lastActivity && now - j.lastActivity < HEARTBEAT_MS) return 'live';
  return 'unknown';
}

// Identity is resolved before presentation. Raw records and IDs remain provenance, never rewritten.
export function agentsOf({ harness = [], tracked = [], manual = [], goal = null } = {}, opts = {}) {
  const entries = [...tracked.map(job => ({ job, source: 'tracked' })),
    ...harness.map(work => ({ work, source: 'harness' })),
    ...manual.map(work => ({ work, source: 'manual' })),
    ...(goal ? [{ work: goal, source: 'goal' }] : [])];
  const groups = [];
  const record = a => a.job || a.work;
  const wrapperPair = (a, b) => (isWrapper(a) && isTake(b)) || (isWrapper(b) && isTake(a));
  for (const e of entries) {
    const j = record(e), state = workerState(j, opts);
    if (state === 'history') continue;
    const members = [j, ...(j.lineageRecords || [])];
    const match = groups.find(g => !(isTake(j) && g.records.some(r => isTake(r) && pidIdentity(r) && pidIdentity(j) && pidIdentity(r) !== pidIdentity(j))) && members.some(j => g.records.some(r =>
      (pidIdentity(j) && pidIdentity(j) === pidIdentity(r)) ||
      (j.id && j.id === r.id && (!pidIdentity(j) || !pidIdentity(r) || pidIdentity(j) === pidIdentity(r))) ||
      (wrapperPair(j, r) && sameLineage(j, r, opts)))));
    if (match) { match.records.push(...members); match.entries.push(e); match.states.push(state); }
    else groups.push({ records: members, entries: [e], states: [state] });
  }
  const result = groups.map((g, i) => {
    const jobs = g.entries.filter(e => e.job).map(e => e.job);
    const work = g.entries.find(e => e.work)?.work;
    const job = jobs.find(isTake) || jobs[0];
    const dispatches = g.records.map(requestIdentity).filter(Boolean).sort();
    const identities = [...dispatches, ...g.records.map(pidIdentity).filter(Boolean).sort()];
    const rawIds = [...new Set(g.records.flatMap(j => j.rawIds || [j.id]).filter(Boolean))].sort();
    const confidence = g.states.includes('live') ? 'live' : g.states.includes('idle') ? 'idle' : 'unknown';
    return { key: identities[0] || (rawIds[0] ? `record:${rawIds[0]}` : `source:${i}`),
      ...(job ? { job } : {}), ...(work ? { work } : {}), confidence, rawIds, records: g.records };
  });
  const keys = new Map(); for (const a of result) keys.set(a.key, (keys.get(a.key) || 0) + 1);
  for (const a of result) if (keys.get(a.key) > 1) a.key += `:${pidIdentity(a.job || a.work) || a.rawIds[0]}`;
  return result;
}
export function livePopulation({ harness = [], tracked = [], manual = [], goal = null, notices = [], history = [] } = {}, opts = {}) {
  const all = agentsOf({ harness, tracked, manual, goal }, opts);
  const workers = all.filter(a => a.confidence === 'live');
  const idle = all.filter(a => a.confidence === 'idle'), unknown = all.filter(a => a.confidence === 'unknown');
  const recs = [...history, ...tracked.filter(j => workerState(j, opts) === 'history')];
  return { workers, idle, unknown, notices: [...notices], history: recs,
    counts: { live: workers.length, workers: workers.length, idle: idle.length, unknown: unknown.length,
      notices: notices.length, history: recs.length } };
}
export const canonicalLiveCount = (inputs, opts) => livePopulation(inputs, opts).counts.live;

// Every row type and the card consume this same snapshot-time population. Global duplicate discoveries
// are assigned once, preferring the row with the tracked record. IDs remain attached for count-check.
export function snapshotPopulation(snap, opts = {}) {
  const rows = [...(snap.projects || []), ...(snap.otherRows || []), ...(snap.watcherRow ? [snap.watcherRow] : [])];
  const inputs = rows.map(row => ({ row, tracked: (row.tracked || []).filter(j => j.kind !== 'autonomous'),
    harness: [...(row.working || []).filter(w => !['manual','goal'].includes(w.role)),
      ...(row.live || []).map(h => ({ ...h, id: h.job || h.id, activity: 'running' }))],
    manual: (row.working || []).filter(w => w.role === 'manual'), goal: (row.working || []).find(w => w.role === 'goal') }));
  const population = livePopulation({ tracked: inputs.flatMap(x => x.tracked),
    harness: inputs.flatMap(x => x.harness), manual: inputs.flatMap(x => x.manual),
  }, opts);
  const goals = inputs.filter(x => x.goal).map(x => x.goal);
  const combined = goals.length ? livePopulation({ tracked: inputs.flatMap(x => x.tracked),
    harness: [...inputs.flatMap(x => x.harness), ...goals], manual: inputs.flatMap(x => x.manual) }, opts) : population;
  for (const x of inputs) {
    x.row.agents = []; x.row.agentsIdle = []; x.row.agentsUnknown = [];
  }
  for (const bucket of ['workers', 'idle', 'unknown']) for (const a of combined[bucket]) {
    const owner = inputs.find(x => x.tracked.some(j => a.records.includes(j))) ||
      inputs.find(x => [...x.harness, ...x.manual, x.goal].some(j => j && a.records.includes(j)));
    if (owner) owner.row[bucket === 'workers' ? 'agents' : bucket === 'idle' ? 'agentsIdle' : 'agentsUnknown'].push(a);
  }
  for (const x of inputs) x.row.active = x.row.agents.length;
  return combined;
}

// ---------- terminal lifecycle ----------
// A terminal rc always beats a queue-taken flag that never produced claude.done. The raw record keeps
// rc, notes and lifecycle timestamps; only the derived `active` flag changes.
export function isActive({ rc, liveDir = false, queueTaken = false, claudeDone = false } = {}) {
  if (rc != null && String(rc).trim() !== '') return false;
  return !!liveDir || (!!queueTaken && !claudeDone);
}
