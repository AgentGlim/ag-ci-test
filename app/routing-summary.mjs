#!/usr/bin/env node
// routing-summary.mjs: the 30-minute job behind the /routing decisions log (plan 89, D08, D11, D12).
//   node app/routing-summary.mjs            rebuild <data>/routing-summary.json and print one summary line
//   node app/routing-summary.mjs --dry      print the summary JSON, write nothing
// Heavy fields per row: cost (routing tokens / USD, rough spend points of the pick) and task success.
// Totals: rows per source, success per source, Gemini vs Jev accuracy (pick and effort) and the G2 gate status.
// Task success (D12), scored from verify results and follow-up jobs only (no model grading):
//   success  linked job's verify passed and no follow-up fix job within 48 h
//   partial  exactly one follow-up fix job within 48 h
//   fail     job failed, verify failed, or 2+ follow-up fix jobs
//   unknown  no linked job, no verify result yet, launch refused by the harness (rc 65/75/78) or job stopped from outside
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RUN, PLANS } from './paths.mjs';
import { buildRows, files, SOURCES } from './routing-log.mjs';
import { TIER, TIER_COST } from './routing.mjs';

export const WINDOW_MS = 48 * 3600e3;
export const LINK_MS = 30 * 60e3; // a launch must start within 30 minutes of its routing decision
export const KEEP_DAYS = 30;
export const G2_N = 50, G2_RATE = 0.85; // D04
export const FIX_RE = /\b(fix(es|ed|ing)?|hot-?fix|repair|redo|re-?do|follow-?up|regress\w*|rework|patch up|broke|still (fails?|broken))\b/i;
export const REFUSED_RC = new Set([65, 75, 78]);
const VERIFY_RE = /\bverif(y|ies|ied|ication)\b/i;

export function fallbackPassRate(md) { // used only when plans _run/bin/reopen-guards.mjs cannot be loaded
  let pass = 0, fail = 0;
  for (const line of String(md).split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    if (/\|\s*\**(pass|passed|ok|yes|done)\b/i.test(line)) pass++;
    else if (/\|\s*\**(fail|failed|no|red|regressed|missing)\b/i.test(line)) fail++;
  }
  return pass + fail ? pass / (pass + fail) : null;
}
async function passRateFn(run) {
  try { const m = await import(path.join(run, 'bin', 'reopen-guards.mjs')); if (typeof m.passRate === 'function') return m.passRate; } catch {}
  return fallbackPassRate;
}

export function loadJobs(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (j && j.id && j.started) out.push(j); } catch {} }
  return out.sort((a, b) => a.started - b.started);
}
const promptCache = new Map();
function promptText(job) {
  if (!job.promptFile) return [job.label, job.desc, job.req].filter(Boolean).join('\n');
  if (!promptCache.has(job.promptFile)) {
    let t = ''; try { const fd = fs.openSync(job.promptFile, 'r'); const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); t = b.slice(0, n).toString('utf8'); } catch {}
    promptCache.set(job.promptFile, t);
  }
  return `${promptCache.get(job.promptFile)}\n${job.label || ''}`;
}
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

// The launch a decision led to: first unclaimed job started within LINK_MS whose prompt carries the routing tag
// ([jev: pick effort]) for Jev/Gemini picks, or the override reason for override rows.
export function linkJob(row, jobs, claimed) {
  const t = Date.parse(row.t);
  let needle = null;
  if ((row.source === 'jev' || (row.source === 'gemini' && row.answered)) && row.pick && row.effort) needle = `[jev: ${row.pick} ${row.effort}]`;
  else if ((row.source === 'superagent' || row.source === 'owner') && row.decision === 'allow') {
    const r = String(row.reason || '').replace(/^[\w-]+:\s*/, '').replace(/^"|"$/g, '');
    needle = r.length >= 8 ? r.slice(0, 60) : null;
  }
  if (!needle) return null;
  const n = norm(needle);
  return jobs.find((j) => !claimed.has(j.id) && j.started >= t - 5e3 && j.started <= t + LINK_MS && norm(promptText(j)).includes(n)) || null;
}

// Verify evidence for a job: a VERIFY.md (job outdir, else the plan's _build) written after the job started and within 48 h.
export function verifyFor(job, { plans = PLANS, passRate = fallbackPassRate } = {}) {
  const cands = [job.outdir && path.join(job.outdir, 'VERIFY.md'), job.project && path.join(plans, job.project, '_build', 'VERIFY.md')].filter(Boolean);
  for (const f of cands) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < job.started || st.mtimeMs > job.started + WINDOW_MS) continue;
    let rate = null; try { rate = passRate(fs.readFileSync(f, 'utf8')); } catch {}
    if (rate == null) continue;
    return { passed: rate >= 0.9, rate: Math.round(rate * 100) / 100, file: f };
  }
  return null;
}

// Significant label words: no fix words, numbers, dates or generic job words.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'run', 'runs', 'audit', 'round', 'pass', 'step', 'job', 'jobs', 'plan',
  'again', 'agent', 'task', 'build', 'write', 'only', 'more', 'check', 'resume', 'headless', 'pi', 'codex', 'claude', 'opus', 'sonnet', 'haiku']);
export const words = (s) => new Set(String(s || '').toLowerCase().replace(FIX_RE, ' ').split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !/^(19|20)\d{6}/.test(w) && !STOP.has(w)));
// A follow-up fix job: same plan, started within 48 h after the job, a fix-type label, and about the same work
// (half or more of the smaller label's significant words shared, or its prompt names the job's output folder).
export function followUps(job, jobs) {
  const base = words(`${job.label || ''} ${job.desc || ''}`);
  return jobs.filter((j) => {
    if (j.id === job.id || !j.project || j.project !== job.project || j.started <= job.started || j.started > job.started + WINDOW_MS) return false;
    if (!FIX_RE.test(`${j.label || ''} ${j.desc || ''}`) || VERIFY_RE.test(j.label || '')) return false;
    if (job.outdir && promptText(j).includes(job.outdir)) return true;
    const w = words(`${j.label || ''} ${j.desc || ''}`);
    if (!w.size || !base.size) return false;
    const shared = [...w].filter((x) => base.has(x)).length;
    return shared / Math.min(w.size, base.size) >= 0.5;
  });
}

export function scoreSuccess(job, jobs, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!job) return { success: 'unknown', successWhy: 'no linked job' };
  if (job.status === 'running') return { success: 'unknown', successWhy: 'job still running' };
  // A launch the harness refused (Jev guard 65, role grid 75, launch gate 78) or a job stopped from outside never did the
  // task, so it says nothing about the pick: unknown, not fail.
  if (REFUSED_RC.has(Number(job.rc))) return { success: 'unknown', successWhy: `launch refused (rc ${job.rc}); the task never ran` };
  if (job.status === 'stopped') return { success: 'unknown', successWhy: `job stopped before it finished${job.endReason ? ` (${String(job.endReason).slice(0, 80)})` : ''}` };
  if (job.status === 'failed' || (job.rc != null && Number(job.rc) !== 0)) return { success: 'fail', successWhy: `job ${job.status || 'failed'} (rc ${job.rc ?? '?'})` };
  const fu = followUps(job, jobs), v = verifyFor(job, opts);
  const fuTxt = fu.length ? `; follow-ups: ${fu.slice(0, 3).map((j) => j.label || j.id).join(' | ')}` : '';
  if (v && !v.passed) return { success: 'fail', successWhy: `verify ${Math.round(v.rate * 100)}% (< 90%)${fuTxt}` };
  if (fu.length >= 2) return { success: 'fail', successWhy: `${fu.length} follow-up fix jobs within 48 h${fuTxt}` };
  if (fu.length === 1) return { success: 'partial', successWhy: `1 follow-up fix job within 48 h${fuTxt}` };
  if (v && v.passed) return { success: 'success', successWhy: `verify ${Math.round(v.rate * 100)}%, no follow-up fix job${now < job.started + WINDOW_MS ? ' so far (48 h window open)' : ' in 48 h'}` };
  return { success: 'unknown', successWhy: now < job.started + WINDOW_MS ? 'no verify result yet (48 h window open)' : 'no verify result' };
}

// Jev routing tokens: the route-model + route-effort calls logged just before the decision.
export function jevTokens(row, usage) {
  const t = Date.parse(row.t);
  const calls = usage.filter((u) => typeof u.t === 'number' && u.t >= t - 60e3 && u.t <= t + 2e3 && /^route-/.test(u.key || ''));
  return calls.length ? calls.reduce((s, u) => s + (u.input || 0) + (u.output || 0), 0) : null;
}

export function accuracy(rows) {
  const g = rows.filter((r) => r.source === 'gemini' && !r.error && r.jevPick).sort((a, b) => (a.t < b.t ? 1 : -1));
  const rate = (list, k) => (list.length ? Math.round(1000 * list.filter((r) => r[k] === true).length / list.length) / 1000 : null);
  const last = g.slice(0, G2_N);
  const errors = {};
  for (const r of rows) if (r.source === 'gemini' && r.error) errors[r.error] = (errors[r.error] || 0) + 1;
  return { compared: g.length, pick: rate(g, 'match'), effort: rate(g, 'matchEffort'), lastN: last.length, lastPick: rate(last, 'match'), lastEffort: rate(last, 'matchEffort'), errors };
}
export function g2Status(acc) {
  if (acc.lastN < G2_N) return { state: 'collecting', text: `${acc.lastN} of ${G2_N} shadow picks compared; Gemini stays shadow-only` };
  if (acc.lastPick >= G2_RATE) return { state: 'ready', text: `last ${G2_N}: pick matches Jev ${Math.round(acc.lastPick * 100)}% (>= 85%). Owner decision G2; Gemini stays shadow-only until approved` };
  return { state: 'below', text: `last ${G2_N}: pick matches Jev ${Math.round(acc.lastPick * 100)}% (< 85%); Gemini stays shadow-only` };
}

export async function buildSummary({ data = DATA, run = RUN, plans = PLANS, now = Date.now() } = {}) {
  const F = files(data, run), passRate = await passRateFn(run);
  const since = now - KEEP_DAYS * 86400e3;
  const rows = buildRows({ data, run }).filter((r) => Date.parse(r.t) >= since);
  const jobs = loadJobs(F.jobs).filter((j) => j.started >= since - LINK_MS);
  const usage = (() => { try { return fs.readFileSync(F.usage, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((u) => u && u.t >= since - 60e3); } catch { return []; } })();
  const claimed = new Set(), out = {};
  const tot = { rows: {}, success: {}, points: 0, jevTokens: 0, geminiTokens: 0, geminiUsd: 0 };
  for (const s of SOURCES) { tot.rows[s] = 0; tot.success[s] = { success: 0, partial: 0, fail: 0, unknown: 0 }; }
  for (const r of [...rows].sort((a, b) => (a.t < b.t ? -1 : 1))) { // oldest first so each job goes to its own decision
    tot.rows[r.source]++;
    const cost = {};
    const tier = TIER[r.pick];
    if (tier && (r.source !== 'gemini' || r.answered)) { cost.points = TIER_COST[tier]; tot.points += cost.points; }
    if (r.source === 'jev') { const k = jevTokens(r, usage); if (k != null) { cost.tokens = k; tot.jevTokens += k; } }
    if (r.source === 'gemini') { tot.geminiTokens += r.cost?.tokens || 0; tot.geminiUsd += r.cost?.usd || 0; }
    let s = { success: null, successWhy: 'shadow pick: never ran' };
    if (r.source !== 'gemini' || r.answered) {
      const job = linkJob(r, jobs, claimed);
      if (job) claimed.add(job.id);
      s = { ...scoreSuccess(job, jobs, { now, plans, passRate }), job: job ? { id: job.id, label: job.label || null, project: job.project || null } : null };
      tot.success[r.source][s.success]++;
    }
    out[r.id] = { cost, ...s };
  }
  tot.geminiUsd = +tot.geminiUsd.toFixed(6);
  const acc = accuracy(rows);
  return { at: new Date(now).toISOString(), keepDays: KEEP_DAYS, totals: tot, accuracy: acc, g2: g2Status(acc), rows: out };
}

async function main(argv) {
  const s = await buildSummary();
  if (argv.includes('--dry')) { console.log(JSON.stringify(s, null, 1)); return 0; }
  const f = files().summary, tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f); // atomic replace: the page never reads a half-written file
  const t = s.totals, a = s.accuracy;
  console.log(`ROUTING-SUMMARY: rows jev ${t.rows.jev}, gemini ${t.rows.gemini}, superagent ${t.rows.superagent}, owner ${t.rows.owner}; `
    + `gemini vs jev pick ${a.pick == null ? '-' : Math.round(a.pick * 100) + '%'} on ${a.compared}; G2 ${s.g2.state}; `
    + `jev success ${t.success.jev.success}/${t.success.jev.partial}/${t.success.jev.fail}/${t.success.jev.unknown} (ok/partial/fail/unknown)`);
  return 0;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not process.exit(): a piped --dry print is bigger than one pipe buffer and must flush first
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log(`ROUTING-SUMMARY: failed: ${String(e?.message || e).slice(0, 200)}`); process.exitCode = 1; });
}
