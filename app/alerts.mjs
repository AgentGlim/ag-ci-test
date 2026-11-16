// alerts.mjs: the AgentGlim "Alerts" panel (owner 2026-11-16, alert digest build, plan 68 harness work).
//
// ONE panel, two tabs (BUILD "Shared work"): Alerts and Attempt history. It reads the harness's own files and shows
// them; it keeps no second copy of the data and no second classifier:
//   <run>/alerts/alerts.ndjson        every alert, full record (failalert, jobcheck, agent-headless append it)
//   <run>/alert_digest/state.json     digest counts per key (written by _run/bin/alert-digest.mjs)
//   <run>/chat_inbox/<ms>.json        the open digest; (.answered) = one reply closed it
//   <plans>/_run/bin/failure-cause.mjs  the ONE failure-cause classifier (digest key = from|plan|kind|cause)
// Answers go through the harness's own chat-write path, so the SuperAgent inbox and /control see exactly what
// the panel did. No paths.mjs import: the caller passes run/plans/data (server.mjs already has them), which keeps
// this file testable from the plans workspace until it is installed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const MAX_ROWS = 5000;
const MAX_TEXT = 4000;

export const alertsFile = (run) => path.join(run, 'alerts', 'alerts.ndjson');
export const digestDir = (run) => path.join(run, 'alert_digest');
export const inboxDir = (run) => path.join(run, 'chat_inbox');

// The harness classifier, imported from the plans folder: one implementation, never a copy.
const cache = new Map();
async function classifierFor(plans) {
  if (!plans) return null;
  if (cache.has(plans)) return cache.get(plans);
  let mod = null;
  try { mod = await import(pathToFileURL(path.join(plans, '_run', 'bin', 'failure-cause.mjs')).href); } catch { mod = null; }
  cache.set(plans, mod);
  return mod;
}

export async function causeOf(row, plans) {
  if (row && row.cause) return { cause: row.cause, label: null, urgent: row.urgent === true };
  const mod = await classifierFor(plans);
  if (!mod) return { cause: 'unknown', label: null, urgent: false };
  const c = mod.classify(row);
  return { cause: c.cause, label: mod.CAUSES[c.cause]?.label || null, urgent: c.urgent };
}

export function readAlerts(run) {
  const rows = [];
  for (const line of readText(alertsFile(run)).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && (r.from || r.text)) rows.push(r);
    } catch { /* a half-written line is not an alert */ }
  }
  return rows.length > MAX_ROWS ? rows.slice(-MAX_ROWS) : rows;
}

const answeredAtOf = (file) => {
  if (!fs.existsSync(`${file}.answered`)) return null;
  const rec = readJson(`${file}.answered`, null);
  const t = rec && rec.answeredAt ? Date.parse(rec.answeredAt) : NaN;
  if (Number.isFinite(t)) return t;
  try { return fs.statSync(`${file}.answered`).mtimeMs; } catch { return null; }
};

export function digestRows(run) {
  const state = readJson(path.join(digestDir(run), 'state.json'), { keys: {} });
  return Object.entries(state.keys || {}).map(([key, v]) => {
    const file = v.inbox ? path.join(inboxDir(run), `${v.inbox}.json`) : null;
    const at = file ? answeredAtOf(file) : null;
    const open = !!(file && fs.existsSync(file) && at == null);
    const rec = file && fs.existsSync(file) ? readJson(file, null) : null;
    return { key, ms: v.inbox || null, file, count: v.count || 0, lastDigestAt: v.lastDigestAt || null,
      firstAt: v.firstAt || null, lastAt: v.lastAt || null, urgent: v.urgent === true, answered: !!v.inbox && !open,
      answeredAt: at, open, text: rec ? String(rec.text || '').slice(0, MAX_TEXT) : null,
      cause: v.cause || null, from: v.from || null, plan: v.plan || null, kind: v.kind || null };
  });
}

export const keyOf = (r, cause) => r.key || `${r.from || 'unknown'}|${r.plan || 'SuperAgent'}|${r.kind || 'alert'}|${cause || 'unknown'}`;

/**
 * The panel's data: one group per key (urgent first, then newest), each with its count, first and last seen time,
 * the answered flag and the attempt rows behind it. `days` limits the window; `since` (ms) overrides it.
 */
export async function view({ run, plans = null, days = 7, now = Date.now(), since = null } = {}) {
  if (!run) throw new Error('view({ run }) is required');
  const rows = readAlerts(run);
  const stamps = rows.map((r) => Date.parse(r.at) || 0).filter((t) => t > 0);
  const newest = stamps.length ? Math.max(...stamps) : now;
  const from = since != null ? Number(since) : newest - days * 86400e3;
  const digests = new Map(digestRows(run).map((d) => [d.key, d]));
  const groups = new Map();
  for (const r of rows) {
    const at = Date.parse(r.at) || 0;
    if (at && at < from) continue;
    const c = await causeOf(r, plans);
    const key = keyOf(r, c.cause);
    const g = groups.get(key) || { key, from: r.from || 'unknown', plan: r.plan || 'SuperAgent', kind: r.kind || 'alert',
      cause: c.cause, label: c.label, urgent: c.urgent, count: 0, first: null, last: null, jobs: new Set(), attempts: [] };
    g.count++;
    g.urgent = g.urgent || r.urgent === true || c.urgent;
    if (r.job) g.jobs.add(String(r.job));
    if (at) { g.first = g.first ? Math.min(g.first, at) : at; g.last = g.last ? Math.max(g.last, at) : at; }
    if (g.attempts.length < 200) g.attempts.push({ at: r.at || null, job: r.job ? String(r.job) : null, rc: r.rc ?? null,
      cause: c.cause, urgent: c.urgent === true, text: String(r.text || '').slice(0, 500) });
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => {
    const d = digests.get(g.key) || null;
    return { key: g.key, from: g.from, plan: g.plan, kind: g.kind, cause: g.cause, label: g.label, urgent: g.urgent,
      count: g.count, first: g.first ? new Date(g.first).toISOString() : null, last: g.last ? new Date(g.last).toISOString() : null,
      jobs: [...g.jobs].slice(-200), attempts: g.attempts.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)),
      answered: d ? d.answered : false, answeredAt: d && d.answeredAt ? new Date(d.answeredAt).toISOString() : null,
      open: d ? d.open : false, ms: d ? d.ms : null, digestText: d ? d.text : null, digestCount: d ? d.count : 0 };
  }).sort((a, b) => (Number(b.urgent) - Number(a.urgent)) || ((Date.parse(b.last) || 0) - (Date.parse(a.last) || 0)));
  return {
    at: new Date(now).toISOString(), run, file: alertsFile(run), days, since: new Date(from).toISOString(),
    stats: { alerts: list.reduce((n, g) => n + g.count, 0), groups: list.length, urgent: list.filter((g) => g.urgent).length,
      open: list.filter((g) => g.open).length, answered: list.filter((g) => g.answered).length,
      woke: [...digests.values()].filter((d) => d.ms).length },
    groups: list,
  };
}

/** One reply closes one digest, through the harness's own chat-write path. */
export function answer(ms, text, { run, plans, data = null } = {}) {
  if (!/^\d{10,16}$/.test(String(ms || ''))) return Promise.resolve({ ok: false, error: 'ms must be the <ms> of a digest' });
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return Promise.resolve({ ok: false, error: 'reply text (1..8000)' });
  const script = path.join(plans || '', '_run', 'bin', 'chat-write.mjs');
  if (!run || !fs.existsSync(script)) return Promise.resolve({ ok: false, error: `chat-write.mjs not found at ${script || '(no plans folder)'}` });
  return new Promise((resolve) => {
    const env = { ...process.env, AGENTGLIM_RUN: run, CHAT_INBOX: inboxDir(run) };
    if (data) env.CHAT_DATA_DIR = path.join(data, 'control');
    const p = spawn('node', [script, '--reply', text, '--to', String(ms)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, code, out: out.trim(), error: code === 0 ? null : (err || out).trim().slice(0, 300) }));
  });
}

/** The weekly line /handoff-review carries (same numbers as `node _run/bin/alert-patterns.mjs --weekly-line`). */
export function weeklyLine(v) {
  const byCause = new Map();
  for (const g of v.groups) byCause.set(g.cause, (byCause.get(g.cause) || 0) + g.count);
  const top = [...byCause.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([c, n]) => `${c} ${n}`).join(', ');
  return `alerts (${v.days}d): ${v.stats.alerts} in ${v.stats.groups} groups; top: ${top || 'none'}; answered ${v.stats.answered}/${v.stats.groups}`;
}
