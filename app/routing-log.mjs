// routing-log.mjs: the /routing decisions log (plan 89, D06, D07, D10). One table, four sources:
//   jev        Jev router picks            <data>/jev-route.ndjson (written by harness/bin/jev-route.mjs)
//   gemini     Gemini Decisions picks      <data>/gemini-shadow.ndjson (written by jev-gate; shadow until G2)
//   superagent agent routing overrides     <run>/jev-override.ndjson, every category except owner-asked / plan-pinned
//   owner      owner manual settings       owner-asked overrides, plan-pinned overrides and jev-gate plan pins
// Light fields (time, prompt, source, pick, effort, reason, match tick) are read live on every page load.
// Heavy fields (cost, task success, accuracy, summary counts; D11, D12) come from <data>/routing-summary.json,
// rebuilt every 30 minutes by app/routing-summary.mjs (superagent-check.sh, D08).
import fs from 'node:fs';
import path from 'node:path';
import { DATA, RUN } from './paths.mjs';

export const SOURCES = ['jev', 'gemini', 'superagent', 'owner'];
export const OWNER_CATEGORIES = new Set(['owner-asked', 'plan-pinned']);
export const files = (data = DATA, run = RUN) => ({
  route: path.join(data, 'jev-route.ndjson'), gemini: path.join(data, 'gemini-shadow.ndjson'), gate: path.join(data, 'jev-gate.ndjson'),
  override: path.join(run, 'jev-override.ndjson'), summary: path.join(data, 'routing-summary.json'), usage: path.join(data, 'jev-usage.ndjson'),
  jobs: path.join(data, 'tracked-jobs'),
});
export const MATCH_WINDOW_MS = 180e3; // a Gemini shadow row belongs to the Jev pick made within 3 minutes of it

// Read only the tail of big logs so a page load stays cheap.
export function readTail(file, maxBytes = 4 << 20) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut
    return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === 'object');
  } finally { fs.closeSync(fd); }
}
// "2026-11-19T10:37:57-0600" (python %z) and ISO Z both -> ISO; null when unparseable.
export function iso(t) {
  if (typeof t === 'number') return new Date(t).toISOString();
  const s = String(t || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
const short = (t, n = 90) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const pct = (p) => (typeof p === 'number' ? `${Math.round(p * 100)}%` : '?');

// Stable ids: source + raw time + occurrence of that pair (append-only logs keep ids stable).
function idMaker() { const seen = {}; return (src, t) => { const k = `${src}:${t}`; seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? `${k}:${seen[k]}` : k; }; }

export function buildRows({ data = DATA, run = RUN } = {}) {
  const F = files(data, run), id = idMaker(), rows = [];
  const gem = readTail(F.gemini).filter((r) => r.src === 'gemini' && r.t);
  const gemRows = gem.map((r) => {
    const g = r.gemini || null, t = iso(r.t);
    const reason = r.error ? `Gemini error: ${r.error}${r.detail ? ` (${short(r.detail, 60)})` : ''}; Jev answered`
      : `${r.answered ? 'answered' : 'shadow only, Jev answered'}; confidence ${pct(g?.p)}${r.jev ? `; Jev picked ${r.jev.pick} ${r.jev.effort}` : ''}`;
    return { id: id('gemini', r.t), t, source: 'gemini', prompt: short(r.prompt), promptFull: String(r.prompt || '').slice(0, 600),
      pick: g?.pick || null, effort: g?.effort || null, p: g?.p ?? null, reason, match: typeof r.match === 'boolean' ? r.match : null,
      matchEffort: typeof r.matchEffort === 'boolean' ? r.matchEffort : null, jevPick: r.jev?.pick || null, answered: !!r.answered,
      error: r.error || null, cost: { tokens: r.tokens ?? null, usd: r.costUsd ?? null }, plan: r.plan || null };
  });
  rows.push(...gemRows);
  const gemByTime = gemRows.filter((g) => g.jevPick && g.t).map((g) => ({ ms: Date.parse(g.t), g }));
  for (const r of readTail(F.route)) {
    if (!r.t || !r.pick) continue;
    const t = iso(r.t), ms = Date.parse(t);
    const rk = Object.entries(r.ranked || {}).sort((a, b) => b[1] - a[1]).find(([m]) => m !== r.pick);
    const notes = [`confidence ${pct(r.pPick)}`, rk ? `runner-up ${rk[0]} ${pct(rk[1])}` : null, r.design ? 'design job' : null,
      r.usageDemoted?.length ? `usage demoted ${r.usageDemoted.length}` : null, r.error ? `Jev error, fallback: ${r.error}` : null].filter(Boolean);
    const twin = gemByTime.filter((x) => x.g.jevPick === r.pick && Math.abs(x.ms - ms) <= MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(a.ms - ms) - Math.abs(b.ms - ms))[0];
    rows.push({ id: id('jev', r.t), t, source: 'jev', prompt: short(r.task), promptFull: String(r.task || '').slice(0, 600), pick: r.pick,
      effort: r.effort || null, p: r.pPick ?? null, reason: notes.join('; '), match: twin && twin.g.match !== null ? twin.g.match : null,
      gemini: twin ? { pick: twin.g.pick, effort: twin.g.effort, id: twin.g.id } : null, cost: null });
  }
  for (const r of readTail(F.override)) {
    if (!r.t || !r.category) continue;
    const src = OWNER_CATEGORIES.has(r.category) ? 'owner' : 'superagent';
    rows.push({ id: id(src, r.t), t: iso(r.t), source: src, prompt: '', promptFull: '', pick: r.harness || null, effort: null, p: null,
      reason: `${r.category}: ${short(String(r.reason || '').replace(/^owner-asked with /, '').replace(`${r.category}:`, '').trim(), 140)}${r.decision === 'deny' ? ` (refused: ${short(r.why, 60)})` : ''}`,
      decision: r.decision || null, match: null, cost: null });
  }
  for (const r of readTail(F.gate)) {
    if (r.src !== 'check' || r.decision !== 'pinned' || !r.t) continue;
    rows.push({ id: id('owner', r.t), t: iso(r.t), source: 'owner', prompt: '', promptFull: '', pick: (r.picks || []).join(' or ') || null,
      effort: null, p: null, reason: `plan pin: ${r.plan || '?'} ${r.phase || ''} (PLAN.md)`.trim(), match: null, cost: null });
  }
  return rows.filter((r) => r.t).sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
}

export function readSummary(data = DATA) {
  try { return JSON.parse(fs.readFileSync(files(data).summary, 'utf8')); } catch { return null; }
}

// Live view for /api/routing: newest rows (default 500), per-source counts, heavy fields merged from the 30-min summary.
export function decisionsLog({ data = DATA, run = RUN, limit = 500 } = {}) {
  const all = buildRows({ data, run }), summary = readSummary(data);
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const r of all) counts[r.source]++;
  // newest `limit` rows, but keep at least the newest 100 of every source so a busy source cannot hide the others
  const keep = new Set(all.slice(0, limit).map((r) => r.id));
  for (const s of SOURCES) all.filter((r) => r.source === s).slice(0, 100).forEach((r) => keep.add(r.id));
  const heavy = summary?.rows || {};
  const rows = all.filter((r) => keep.has(r.id)).map((r) => {
    const h = heavy[r.id];
    return h ? { ...r, cost: { ...(r.cost || {}), ...(h.cost || {}) }, success: h.success ?? null, successWhy: h.successWhy ?? null, job: h.job ?? null } : r;
  });
  return { sources: SOURCES, counts, total: all.length, rows,
    summary: summary ? { at: summary.at, totals: summary.totals, accuracy: summary.accuracy, g2: summary.g2 } : null };
}
