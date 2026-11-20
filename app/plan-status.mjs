// Plan status is a read-only projection of driver state and current verification evidence.
import fs from 'node:fs';
import path from 'node:path';
import { auditEstimate } from './audit-estimate.mjs';

export const STATUS_POLL_MS = 15000;
export const timeMs = (v) => typeof v === 'number' ? v : Date.parse(String(v || '').replace(' ', 'T')) || 0;
const bad = (j) => ['failed', 'stopped', 'blocked', 'busy'].includes(j.status || j.outcome);
export function epochOf(p = {}) {
  const reopen = (p.history || []).filter(h => h.step === 'reopen').at(-1);
  return { revision: Number(p.rev?.n) || 0, at: Math.max(timeMs(p.rev?.atMs), timeMs(p.rev?.at), timeMs(reopen?.at)) };
}
const normalized = (v) => String(v || '').replaceAll('\\', '/').replace(/\/$/, '');
// Exact harness attempt lineage. Labels and dispatch generations are not step identities.
export function attemptKey(j) {
  const out = normalized(j.outdir);
  const m = /^(.*\/_build\/(.+))\/attempts\/([^/]+)\/(\d+)$/.exec(out);
  if (m) return `${j.project || j.plan || ''}:${m[1]}:run:${m[3]}`;
  if (j.stepId && (j.project || j.plan)) return `${j.project || j.plan}:step:${j.stepId}:round:${j.round || ''}:revision:${j.revision || ''}`;
  return null;
}
export function historicalFailure(j, epoch) {
  if (!bad(j) || j.status === 'running') return false;
  const step = j.stepId || j.step || /\/_build\/([^/]+)/.exec(normalized(j.outdir))?.[1] || '';
  const rev = /^v(\d+)-/.exec(step)?.[1];
  const at = timeMs(j.ended || j.updated || j.finished || j.started);
  return !!((epoch.at && at && at < epoch.at) || (epoch.revision && rev && +rev < epoch.revision));
}
export function foldAttempts(records) {
  const groups = new Map(), plain = [];
  for (const raw of records.filter(Boolean)) {
    const j = String(raw.rc) === '75' && raw.status !== 'running'
      ? { ...raw, status: 'busy', endReason: 'busy, retried' } : { ...raw };
    const key = attemptKey(j);
    if (!key) { plain.push(j); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => timeMs(a.started) - timeMs(b.started) || normalized(a.outdir).localeCompare(normalized(b.outdir), undefined, { numeric: true }));
    const kept = [];
    for (const j of list) {
      // Only terminal unsuccessful attempts are superseded. Never swallow live or successful work.
      const older = kept.filter(x => bad(x) && timeMs(x.ended || x.started) <= timeMs(j.started));
      const prior = [...older.flatMap(x => [...(x.retryHistory || []), { ...x, retryHistory: undefined }]), ...(j.retryHistory || [])];
      for (const old of older) kept.splice(kept.indexOf(old), 1);
      j.retryHistory = prior; j.retryCount = prior.length;
      kept.push(j);
    }
    plain.push(...kept);
  }
  return plain;
}
export function projectAttempts(records, state = {}) {
  const epoch = epochOf(state), history = [], active = [];
  for (const j of foldAttempts(records)) (historicalFailure(j, epoch) ? history : active).push(j);
  return { active, history, epoch };
}
// A requirement rate measures progress; only an explicit final verdict establishes acceptance.
const rate = (pass, total) => Number.isSafeInteger(pass) && Number.isSafeInteger(total)
  && total > 0 && pass >= 0 && pass <= total ? Math.round(100 * pass / total) : null;
function requirementRate(text, kind) {
  // Bare fractions often describe tests, screenshots or diagnostics, not product requirements.
  let inRequirements = false;
  for (const line of text.split('\n')) {
    if (/^\s*#{1,6}\s/.test(line)) inRequirements = /\brequirements\b/i.test(line);
    const counted = inRequirements && /^\s*(\d+) pass,\s*(\d+) partial,\s*out of (\d+)\b/i.exec(line);
    if (counted && +counted[1] + +counted[2] <= +counted[3]) return rate(+counted[1], +counted[3]);
    const summary = /^\s*requirements?\s*(?:pass\s*rate|completion)?\s*:\s*(.*)$/i.exec(line)?.[1];
    if (!summary) continue;
    const totals = /^(\d+) pass(?:es)?\s*\/\s*(\d+) partial\s*\/\s*(\d+) fail\b/i.exec(summary);
    if (totals) return rate(+totals[1], +totals[1] + +totals[2] + +totals[3]);
    const total = /^(\d+) pass\s*\/\s*(\d+) total\b/i.exec(summary);
    if (total) return rate(+total[1], +total[2]);
    const fraction = /^(\d+)\s*\/\s*(\d+)(?:\s+pass\b|\s*=)/i.exec(summary);
    if (fraction) return rate(+fraction[1], +fraction[2]);
  }
  if (kind !== 'verify') return null;
  let statusColumn = -1, pass = 0, total = 0;
  for (const line of text.split('\n')) {
    if (!/^\s*\|/.test(line)) { statusColumn = -1; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
    if (cells.some(c => /^requirement$/i.test(c))) {
      // Regression tables contain earlier PASS cells; prefer the current after/result column.
      statusColumn = cells.findIndex(c => /^after(?:\s|$)/i.test(c));
      if (statusColumn < 0) statusColumn = cells.findIndex(c => /^(?:status|result)$/i.test(c));
      continue;
    }
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    const result = statusColumn < 0 ? null : /^(pass|partial(?:ly)?|fail(?:ed)?|blocked|incomplete|unknown)\b/i.exec(cells[statusColumn] || '');
    if (result) { total++; if (result[1].toLowerCase() === 'pass') pass++; }
  }
  return rate(pass, total);
}
export function verification(md, kind = 'verify') {
  const text = String(md || '').replace(/[*_`]/g, '');
  const verdictLine = text.split('\n').find(l => /^\s*(?:#{1,6}\s*)?(?:verdict|overall verdict|result)\s*:/i.test(l)) || '';
  const value = verdictLine.replace(/^\s*(?:#{1,6}\s*)?(?:verdict|overall verdict|result)\s*:\s*/i, '');
  const negative = /\b(not built|not implemented|fail(?:ed)?|partial(?:ly)?|blocked|incomplete|unfinished|regressed)\b/i.exec(value)?.[0].toLowerCase();
  const verdict = negative ? negative.startsWith('partial') ? 'partial' : negative
    : /^(?:pass|fully built|fully implemented|complete(?:d)?|built)(?=\s|[.;,]|$)/i.test(value) ? 'pass' : 'unknown';
  const estimate = auditEstimate(String(md || ''));
  // The shared estimator also reads prose about test-suite progress. Reject that ambiguity here.
  const completion = estimate && (!/\b(?:tests?|suites?)\b/i.test(estimate.text)
    || /\b(?:spec|requirements?|product)\s+completion\b/i.test(estimate.text))
    && Number.isFinite(estimate.pct) && estimate.pct >= 0 && estimate.pct <= 100 ? estimate : null;
  const pct = requirementRate(text, kind) ?? completion?.pct ?? null;
  return { pct, verdict, text: (verdictLine || completion?.text || text.split('\n').find(l => l.trim()) || '').trim().slice(0, 300) };
}
function evidence(file, source, round) {
  try { const stat = fs.statSync(file); if (!stat.isFile()) return null;
    return { ...verification(fs.readFileSync(file, 'utf8'), source), source, round, at: stat.mtimeMs };
  } catch (e) { if (e.code === 'ENOENT') return null; return { source, round, at: 0, pct: null, verdict: 'unreadable', text: `Cannot read ${source}` }; }
}
export function readPlanStatus(plans, dir, state = {}, now = Date.now()) {
  const build = path.join(plans, dir, '_build'), epoch = epochOf(state);
  const verify = evidence(path.join(build, 'VERIFY.md'), 'verify', 'verify');
  const current = (e) => e && (!epoch.at || e.at >= epoch.at) && (e.source === 'verify' || !epoch.revision || e.round.startsWith(`v${epoch.revision}-`));
  let names = []; try { names = fs.readdirSync(build); } catch {}
  const audits = names.filter(n => /^v\d+-r\d+$/.test(n)).map(n => evidence(path.join(build, n, 'AUDIT.md'), 'audit', n)).filter(current).sort((a, b) => b.at - a.at || b.round.localeCompare(a.round, undefined, { numeric: true }));
  const freshVerify = current(verify) ? verify : null;
  const latest = state.stage === 'done' && freshVerify ? freshVerify
    : [freshVerify, audits[0]].filter(Boolean).sort((a, b) => b.at - a.at || (a.source === 'verify' ? -1 : 1))[0] || null;
  const mismatch = state.stage === 'done' && (!freshVerify || freshVerify.verdict !== 'pass' || freshVerify.pct != null && freshVerify.pct < 90);
  const reason = mismatch ? !freshVerify ? 'Driver done; current final VERIFY missing or stale'
    : `Driver done; VERIFY ${freshVerify.verdict}${freshVerify.pct == null ? '' : ` (${freshVerify.pct}%)`}` : null;
  return { stage: state.stage || '', epoch, pct: latest?.pct ?? null, verdict: latest?.verdict || 'unknown', source: latest?.source || null,
    evidenceAt: latest?.at || null, checkedAt: now, mismatch, reason,
    progress: latest ? { pct: latest.pct, word: latest.verdict.toUpperCase(), round: latest.round, text: latest.text } : null };
}
