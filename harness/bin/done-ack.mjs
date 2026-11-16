#!/usr/bin/env node
// done-ack.mjs: finished jobs the owner has not seen yet (the dashboard's green and red finished icons).
// Packaged in agentglim/harness/bin; the harness keeps a link at <run>/bin/done-ack.mjs. Works with the server down:
// it writes the store (<data>/done-ack/) directly and runs the same sweep the server runs.
//   done-ack.mjs list [--row DIR] [--json]                unseen jobs: key, outcome, age, row, label, sentence
//   done-ack.mjs show <job>                               the notice and the job's result text
//   done-ack.mjs ack <job...> --quote "<owner's words>"   mark seen; --quote is required
//   done-ack.mjs ack --all --quote "..."                  everything unseen right now
//   done-ack.mjs unack <job...>                           undo
//   done-ack.mjs count                                    "3 not seen (1 failed)"
// <job>: notice key, any alias id, agentId, outdir, or an exact label unique among unseen jobs.
// Exit: 0 done or already seen, 2 usage (no quote), 3 ambiguous, 4 unknown, 5 still running.
// Rule (owner Q1 2026-11-14): ack only when the owner's own message is about that job, and quote the owner's words.
// Never ack because you reported it.
import path from 'node:path';
import { harnessConfig } from '../config.mjs';
import * as DA from '../../app/done-ack.mjs';
import { readTracked } from '../../app/jobs.mjs';

const H = harnessConfig();
const DIR = DA.storeDir(H.roots.data), TJ = path.join(H.roots.data, 'tracked-jobs');
const a = process.argv.slice(2), cmd = a[0];
const flags = {}, pos = [];
for (let i = 1; i < a.length; i++) {
  if (a[i] === '--json' || a[i] === '--all') flags[a[i].slice(2)] = true;
  else if (a[i].startsWith('--')) { const v = a[i + 1]; if (v === undefined) { console.error(`${a[i]} needs a value`); process.exit(2); } flags[a[i].slice(2)] = v; i++; }
  else pos.push(a[i]);
}
const records = (() => { try { return readTracked(TJ); } catch { return []; } })();
try { DA.sweep(DIR, records, { minMinutes: { ...DA.DEFAULTS, ...(H.doneAck || {}) }.minMinutes }); } catch {}
const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const resolve = (h) => { const r = DA.resolveHandle(DIR, h, records); if (r.key) return r.key;
  console.error(`${h}: ${r.error}${r.cands ? ` (${r.cands.join(', ')})` : ''}`); process.exit(r.code); };

if (cmd === 'list' || cmd === 'count') {
  let u = DA.sortUnseen(DA.unseenOf(DIR)); if (flags.row) u = u.filter((x) => x.n.project === flags.row);
  const bad = u.filter((x) => x.n.outcome !== 'done').length;
  if (cmd === 'count') { console.log(`${u.length} not seen${bad ? ` (${bad} failed)` : ''}`); process.exit(0); }
  if (flags.json) { console.log(JSON.stringify(u.map((x) => DA.item(x.n)), null, 1)); process.exit(0); }
  if (!u.length) console.log('nothing unseen');
  for (const x of u) console.log(`${x.key}  ${x.n.outcome === 'done' ? 'finished' : x.n.outcome}  ${x.n.ended ? ago(x.n.ended) : '?'}  ${x.n.project}  ${x.n.label}: ${x.n.desc}`);
  process.exit(0);
}
if (cmd === 'show') {
  if (!pos.length) { console.error('show <job>'); process.exit(2); }
  const k = resolve(pos[0]), n = DA.readNotice(DIR, k), m = DA.readMarker(DIR, k);
  console.log(JSON.stringify({ ...n, seen: m || null }, null, 1)); process.exit(0);
}
if (cmd === 'ack') {
  if (typeof flags.quote !== 'string' || !flags.quote.trim()) { console.error('ack needs --quote "<the owner\'s words>"'); process.exit(2); }
  if (!flags.all && !pos.length) { console.error('ack <job...> --quote "..." or ack --all --quote "..."'); process.exit(2); }
  const keys = flags.all ? DA.unseenOf(DIR).map((x) => x.key) : pos.map(resolve);
  const ch = DA.ack(DIR, keys, { by: 'superagent', via: 'chat', quote: flags.quote.slice(0, 500), session: process.env.CLAUDE_SESSION_ID || null });
  console.log(`marked seen: ${ch.length ? ch.join(', ') : 'nothing new'}${keys.length > ch.length ? ` (already seen: ${keys.filter((k) => !ch.includes(k)).join(', ')})` : ''}`);
  process.exit(0);
}
if (cmd === 'unack') {
  if (!pos.length) { console.error('unack <job...>'); process.exit(2); }
  const ch = DA.unack(DIR, pos.map(resolve)); console.log(`back to not seen: ${ch.join(', ') || 'nothing'}`); process.exit(0);
}
console.log('usage: done-ack.mjs list [--row DIR] [--json] | show <job> | ack <job...> --quote "..." | ack --all --quote "..." | unack <job...> | count');
process.exit(cmd ? 2 : 0);
