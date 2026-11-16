// done-ack.mjs: finished-job notices that stay until the owner has seen them (design: plan 68
// _build/done-ack-design-20261113/DESIGN.md). Pure functions over a store folder and `now`; the server, the
// harness tool (harness/bin/done-ack.mjs) and tests all use them. The dashboard says "finished" and "seen".
//
// Store: <data>/done-ack/
//   state.json      { v, baselineAt, lastSweepAt, chains: { key: firstStarted } }
//   <key>.json      the notice (tmp + rename); refreshed only while unseen
//   <key>.ack       seen marker; created with flag "wx" (first writer wins). Its existence means seen.
//   _archive/       Undo moves markers to _archive/undone/; prune moves old seen pairs to _archive/YYYY-MM/. Never deleted.
import fs from 'node:fs';
import path from 'node:path';
import { foldWrappers, normDir } from './working.mjs';
import { isRealJob, shownStatus, cleanLabel } from './jobs.mjs';

export const DEFAULTS = Object.freeze({ minMinutes: 2, keepDays: 30, notify: 'failed', maxPerRow: 6, cap: 60 });
export const KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;
export const VIA = ['click', 'bulk', 'row', 'report', 'chat', 'chat-ref', 'superseded'];
const RELAUNCH_MS = 30 * 60e3, NOSTART_MS = 30e3, SETTLE_MS = 5e3;
const ROUND_DIR = /\/_build\/(?:v\d+-r\d+|[^/]*-(?:verify|focus|final|gate|setup))(?:\/|$)/;

export const storeDir = (data) => path.join(data, 'done-ack');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeAtomic = (f, obj) => { const t = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; fs.writeFileSync(t, JSON.stringify(obj, null, 1)); fs.renameSync(t, f); };
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const safeKey = (k) => String(k || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);

export function readState(dir) { return rd(path.join(dir, 'state.json')) || null; }
function saveState(dir, st) { fs.mkdirSync(dir, { recursive: true }); writeAtomic(path.join(dir, 'state.json'), st); }

// ---------- scope (DESIGN 4.2) ----------
// -> null when the job is owner-facing, else the reason it is skipped
export function skipReason(j, { hasWrapper = false } = {}) {
  if (!isRealJob(j)) return 'test job';
  if (j.kind === 'autonomous') return 'pipeline round';
  if (j.kind === 'one-on-one' && !j.pid && !j.launcher) return 'chat turn';
  if (j.quiet || /\[quiet\]/i.test(j.label || '')) return 'quiet';
  const lb = j.launchedBy;
  if (lb && (lb.headless || lb.agentId)) return 'launched by an agent';
  if (!lb) {
    const take = !!j.req || /^headless-take/.test(j.launcher || '');
    if (take && !hasWrapper && j.project !== 'SuperAgent') return 'queue take without a launcher';
    if (j.outdir && ROUND_DIR.test(String(j.outdir).replace(/\\/g, '/'))) return 'pipeline round folder';
  }
  if (j.launcher === 'claude Agent tool' && !j.agentId) return 'foreground Agent call';
  return null;
}
export const ownerFacing = (j, o) => skipReason(j, o) == null;

// stopped on purpose: a stop reason, a stopped/noretry file, or "stopped by" / "never started"
function stoppedOnPurpose(j) {
  if (j.stopReason) return true;
  if (/stopped by|never started/i.test(j.endReason || '')) return true;
  if (j.outdir) for (const f of ['stopped', 'noretry']) if (exists(path.join(j.outdir, f))) return true;
  return false;
}
// end state -> 'done' | 'failed' | 'stopped' | null (skip)
export function outcomeOf(j, wrapper = null) {
  let st = shownStatus(j);
  if (st === 'running' || st === 'idle') return null;
  if (st === 'stopped') { if (j.summary) st = 'done'; else if (stoppedOnPurpose(j)) return null; }
  if (st === 'done' && wrapper && wrapper.status === 'failed') st = 'failed';
  return ['done', 'failed', 'stopped'].includes(st) ? st : 'failed';
}

// ---------- one-sentence description (DESIGN 4.5) ----------
const TAGS = /\[(?:jev|plan|task|quiet)[^\]]*\]\s*/gi;
export function cleanSentence(s, max = 140) {
  let t = String(s || '').replace(TAGS, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^you are [^.]*\.\s*/i, '');
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t); if (m) t = m[1];
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}
const pathOrId = (s) => /^[\w./~-]+$/.test(s) && (/[/]/.test(s) || /^[0-9a-f-]{8,}$/i.test(s));
export function sentenceOf(j) {
  if (j.desc) return { desc: cleanSentence(j.desc), descFrom: j.descFrom || 'flag' };
  const tag = /\[task:\s*([^\]]+)\]/i.exec(j.label || '');
  if (tag) return { desc: cleanSentence(tag[1]), descFrom: 'tag' };
  const lab = String(j.label || '').replace(TAGS, '').trim();
  if (lab.split(/\s+/).length >= 3 && !pathOrId(lab)) return { desc: cleanSentence(lab), descFrom: 'label' };
  for (const f of [j.promptFile, j.outdir && path.join(j.outdir, 'prompt.md')]) {
    if (!f) continue;
    try { const t = fs.readFileSync(f, 'utf8').slice(0, 20000); const tt = /\[task:\s*([^\]]+)\]/i.exec(t);
      const s = cleanSentence(tt ? tt[1] : t.split('\n').filter((l) => l.trim() && !/^#/.test(l)).join(' '));
      if (s && !pathOrId(s)) return { desc: s, descFrom: tt ? 'tag' : 'prompt' }; } catch {}
  }
  return { desc: cleanLabel(lab || j.slug || 'job'), descFrom: 'slug' };
}
const headline = (j) => { const l = String(j.summary || '').split('\n').map((x) => x.trim()).find((x) => x && !/^#/.test(x)); return l ? l.slice(0, 200) : null; };

// ---------- store ----------
export function noticePath(dir, key) { return path.join(dir, `${key}.json`); }
export function markerPath(dir, key) { return path.join(dir, `${key}.ack`); }
export function readNotice(dir, key) {
  const n = rd(noticePath(dir, key));
  return n && typeof n === 'object' ? n : { v: 1, key, broken: true, outcome: 'done', label: 'finished job', desc: 'finished job, details unavailable', ids: [key] };
}
export function readMarker(dir, key) { return rd(markerPath(dir, key)); }

// every notice in the store: [{ key, n, seen, marker }]. A small parsed-notice cache keeps the 10 s sweep cheap.
const cache = new Map();
export function listAll(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const acks = new Set(names.filter((x) => x.endsWith('.ack')).map((x) => x.slice(0, -4)));
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json') || f === 'state.json') continue;
    const key = f.slice(0, -5), p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    let c = cache.get(p);
    if (!c || c.m !== st.mtimeMs) { c = { m: st.mtimeMs, n: readNotice(dir, key) }; cache.set(p, c); }
    out.push({ key, n: c.n, seen: acks.has(key) });
  }
  if (cache.size > 20000) cache.clear();
  return out;
}
export const unseenOf = (dir) => listAll(dir).filter((x) => !x.seen);
const rank = (a, b) => ((a.n.outcome === 'done' ? 1 : 0) - (b.n.outcome === 'done' ? 1 : 0)) || ((b.n.ended || 0) - (a.n.ended || 0));
export const sortUnseen = (l) => [...l].sort(rank);

// mark seen. keys: notice keys. -> keys whose marker this call created
export function ack(dir, keys, marker) {
  const changed = [];
  for (const k of keys) {
    if (!KEY_RE.test(k) || !exists(noticePath(dir, k))) continue;
    try { fs.writeFileSync(markerPath(dir, k), JSON.stringify({ at: Date.now(), ...marker }), { flag: 'wx' }); changed.push(k); } catch {}
  }
  return changed;
}
// undo: the marker moves to _archive/undone/ (never deleted)
export function unack(dir, keys, now = Date.now()) {
  const changed = [], to = path.join(dir, '_archive', 'undone');
  for (const k of keys) {
    if (!KEY_RE.test(k) || !exists(markerPath(dir, k))) continue;
    fs.mkdirSync(to, { recursive: true });
    try { fs.renameSync(markerPath(dir, k), path.join(to, `${k}.${now}.ack`)); changed.push(k); } catch {}
  }
  return changed;
}
// seen notices older than keepDays move to _archive/YYYY-MM/ with their marker
export function prune(dir, { now = Date.now(), keepDays = DEFAULTS.keepDays } = {}) {
  const moved = [];
  for (const x of listAll(dir)) {
    if (!x.seen) continue;
    const m = readMarker(dir, x.key); if (!m || now - (m.at || 0) < keepDays * 86400e3) continue;
    const to = path.join(dir, '_archive', new Date(m.at).toISOString().slice(0, 7)); fs.mkdirSync(to, { recursive: true });
    try { fs.renameSync(noticePath(dir, x.key), path.join(to, `${x.key}.json`)); fs.renameSync(markerPath(dir, x.key), path.join(to, `${x.key}.ack`)); moved.push(x.key); } catch {}
  }
  return moved;
}

// ---------- sweep (DESIGN 4.4) ----------
// records: every tracked record (raw). Returns { created: [keys], superseded: [keys] }.
export function sweep(dir, records, { now = Date.now(), minMinutes = DEFAULTS.minMinutes } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let st = readState(dir);
  if (!st) { st = { v: 1, baselineAt: now, lastSweepAt: now, chains: {} }; saveState(dir, st); return { created: [], superseded: [] }; }
  st.chains ||= {};
  const raw = records.filter(Boolean), byId = new Map(raw.map((j) => [j.id, j]));
  const jobs = foldWrappers(raw);
  const all = listAll(dir), byAlias = new Map();
  for (const x of all) for (const id of x.n.ids || [x.key]) byAlias.set(id, x);
  const created = [], superseded = [];
  // relaunches since the last sweep replace older unseen notices of the same chain
  for (const j of jobs) {
    if (!j.started || j.started < (st.lastSweepAt || 0) - 1000 || j.started < st.baselineAt) continue;
    const jd = normDir(j.outdir), key = safeKey(j.id);
    for (const x of all) {
      if (x.seen || x.key === key || (x.n.ended || 0) > j.started + 1000) continue;
      const od = x.n.outdir ? normDir(x.n.outdir) : null;
      const sameDir = jd && od && (jd === od || new RegExp(`^${od.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r\\d+$`).test(jd));
      const sameLabel = x.n.outcome !== 'done' && x.n.project === j.project && x.n.label && x.n.label === cleanLabel(j.label) && j.started - (x.n.ended || 0) < RELAUNCH_MS;
      if (!sameDir && !sameLabel) continue;
      if (ack(dir, [x.key], { by: 'superagent', via: 'superseded', by_job: key }).length) { superseded.push(x.key); x.seen = true; }
      st.chains[key] = Math.min(st.chains[key] || Infinity, st.chains[x.key] || x.n.started || j.started);
    }
  }
  for (const j of jobs) {
    if (shownStatus(j) === 'running') continue;
    const ended = j.ended || (j.activity === 'finished' ? j.heartbeat : null) || null;
    if (!ended || ended < st.baselineAt) continue;
    const key = safeKey(j.id), have = byAlias.get(j.id) || (j.wrapperOf && byAlias.get(j.wrapperOf));
    const wrapper = j.wrapperOf ? byId.get(j.wrapperOf) : null;
    if (wrapper && wrapper.status === 'running') continue; // the wrapper publishes the final exit code
    const outcome = outcomeOf(j, wrapper);
    if (have) { if (!have.seen) refresh(dir, have, j, outcome, now); continue; }
    if (!outcome || !ownerFacing(j, { hasWrapper: !!wrapper })) continue;
    const from = Math.min(j.started || ended, st.chains[key] || Infinity);
    if (outcome === 'done' && ended - from < minMinutes * 60e3) continue;
    const s = sentenceOf(j);
    const n = { v: 1, key, ids: [...new Set([j.id, j.wrapperOf, j.agentId].filter(Boolean))], agentId: j.agentId || null,
      project: j.project || 'Unassigned', isPlan: !!j.isPlan, kind: j.kind || null, label: cleanLabel(j.label), desc: s.desc, descFrom: s.descFrom,
      outcome, status: j.status || null, rc: j.rc ?? null, endReason: j.endReason || null, started: j.started || null, chainStarted: st.chains[key] || null, ended,
      harness: j.harness || null, model: j.model || null, outdir: j.outdir || null, result: headline(j), summary: j.summary ? String(j.summary).slice(0, 4000) : null,
      launchedBy: j.launchedBy || null, created: now, settled: now - ended >= SETTLE_MS };
    try { writeAtomic(noticePath(dir, key), n); created.push(key); } catch {}
  }
  // write state only when something changed or once a minute (fewer writes; relaunch checks are idempotent)
  if (created.length || superseded.length || now - (st.lastSweepAt || 0) >= 60e3) { st.lastSweepAt = now; saveState(dir, st); }
  return { created, superseded };
}
// an unseen notice may only get worse (done -> failed) and fill in rc / summary / result
function refresh(dir, x, j, outcome, now) {
  const n = { ...x.n }; let ch = false;
  if (outcome && outcome !== 'done' && n.outcome === 'done') { n.outcome = outcome; ch = true; }
  if (n.rc == null && j.rc != null) { n.rc = j.rc; ch = true; }
  if (!n.summary && j.summary) { n.summary = String(j.summary).slice(0, 4000); n.result = headline(j); ch = true; }
  if (!n.settled && now - (n.ended || now) >= SETTLE_MS) { n.settled = true; ch = true; }
  if (ch && !n.broken && !exists(markerPath(dir, x.key))) try { writeAtomic(noticePath(dir, x.key), n); } catch {}
}

// ---------- views ----------
// the small per-icon item the snapshot carries
export function item(n) {
  return { key: n.key, outcome: n.outcome, label: n.label, desc: n.desc, project: n.project, ended: n.ended || null,
    tookMs: n.ended && (n.chainStarted || n.started) ? n.ended - (n.chainStarted || n.started) : null, rc: n.rc ?? null, endReason: n.endReason || null,
    harness: n.harness || null, model: n.model || null, result: n.result || null, effort: n.effort || null, hasReport: !!(n.summary || n.outdir), broken: !!n.broken };
}
// full rows for the side panel; state unseen|seen|all
export function listFor(dir, { state = 'unseen', row = null, rowOf = (n) => n.project, limit = 50, before = null } = {}) {
  const all = listAll(dir);
  let l = all.filter((x) => state === 'all' || (state === 'seen' ? x.seen : !x.seen)).filter((x) => !row || rowOf(x.n) === row);
  const withM = l.map((x) => ({ ...item(x.n), row: rowOf(x.n), seen: x.seen ? readMarker(dir, x.key) || { at: 0 } : null }));
  if (state === 'seen') withM.sort((a, b) => (b.seen.at || 0) - (a.seen.at || 0)); else withM.sort((a, b) => ((a.outcome === 'done') - (b.outcome === 'done')) || (b.ended || 0) - (a.ended || 0));
  const f = before ? withM.filter((x) => (x.seen?.at || x.ended || 0) < before) : withM;
  return { items: f.slice(0, limit), more: f.length > limit, unseen: all.filter((x) => !x.seen).length, seen: all.filter((x) => x.seen).length };
}

// ---------- handles (tool) ----------
// handle: key, alias id, agentId, outdir, or an exact label unique among unseen. -> { key } | { code, error, cands? }
export function resolveHandle(dir, h, records = []) {
  const all = listAll(dir);
  const hit = all.find((x) => x.key === h || (x.n.ids || []).includes(h) || (x.n.agentId && x.n.agentId === h));
  if (hit) return { key: hit.key };
  const nd = normDir(h);
  const byDir = all.filter((x) => x.n.outdir && normDir(x.n.outdir) === nd).sort((a, b) => (a.seen - b.seen) || (b.n.ended || 0) - (a.n.ended || 0));
  if (byDir.length) return { key: byDir[0].key };
  const lab = all.filter((x) => !x.seen && (x.n.label === h || x.n.label?.toLowerCase() === String(h).toLowerCase()));
  if (lab.length === 1) return { key: lab[0].key };
  if (lab.length > 1) return { code: 3, error: 'ambiguous', cands: lab.map((x) => x.key) };
  const run = records.find((j) => (j.id === h || j.agentId === h || (j.outdir && normDir(j.outdir) === nd)) && shownStatus(j) === 'running');
  if (run) return { code: 5, error: 'still running' };
  return { code: 4, error: 'unknown job' };
}
