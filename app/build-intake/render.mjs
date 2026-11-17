import { clone, hash } from './durable.mjs';
import { REGISTRY } from './registry.mjs';
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\r\n]/g, ' ');
const show = (v) => escape(v === null ? 'unset' : typeof v === 'string' ? v : JSON.stringify(v));
export function render(r, reviewCount, liveness) {
  const json = clone(r.config), fields = json.fields;
  const observed = (name, v, reason, status = 'available') => { fields[`runtime.${name}`] = { requested: null, effective: v, origin: 'runtime', reason, verification: 'recorded; execution unverified', status, observedAt: r.updatedAt }; };
  observed('failedGate', r.lastRefusal?.message || null, 'Last refused gate; no successful dispatch implied', r.lastRefusal ? 'available' : 'not-applicable');
  observed('state', r.state, 'Intake lifecycle; not a worker liveness claim');
  observed('attemptId', r.attempt?.id || null, 'Persisted attempt', r.attempt ? 'available' : 'pending');
  observed('jobs', r.receipts.map(x => x.jobId), 'Existing tracked job records only');
  observed('processIdentity', r.receipts.map(x => ({ pid: x.pid, pidStart: x.pidStart })), 'Registration identity; not live verification');
  observed('dispatchTime', r.attempt?.at || null, 'Intent time; spawn not implied', r.attempt ? 'available' : 'pending');
  observed('receipts', r.receipts, 'Append-only evidence; source hashes retained');
  observed('provider', null, 'Actual provider not established by current job registration', 'unavailable');
  observed('account', null, 'Account alias not verified', 'unavailable');
  observed('logs', r.attempt ? [r.attempt.outdir] : [], 'Canonical attempt output directory');
  observed('artifacts', r.attempt ? [r.attempt.promptFile, r.attempt.configFile] : [], 'Pinned configuration and prompt');
  observed('liveness', liveness?.available ? { authority: liveness.authority, counts: liveness.counts,
    workers: liveness.workers, idle: liveness.idle, unknown: liveness.unknown } : 'unverified',
    liveness?.available ? 'F31 population; live, idle, unknown and history remain separate' : liveness?.reason || 'No F31 observation for this build', liveness?.available ? 'available' : 'unavailable');
  for (const name of ['failures', 'repairs']) observed(name, liveness?.[name] || null,
    liveness?.[name]?.available ? 'Read-only projection of canonical attempt evidence; no repair scheduling' : liveness?.[name]?.reason || 'Canonical attempt evidence unavailable', liveness?.[name]?.available ? 'available' : 'unavailable');
  if (liveness?.available) for (const name of ['liveness', 'failures', 'repairs']) {
    fields[`runtime.${name}`].verification = fields[`runtime.${name}`].status === 'available' ? 'F31 evidence observed; audit and installation unverified' : 'unverified';
    fields[`runtime.${name}`].observedAt = liveness.observedAt;
  }
  observed('nextAction', r.lastRefusal ? `Resolve refused gate: ${r.lastRefusal.message}` : r.state === 'intake' ? `Answer ${r.missing.join(', ') || 'all groups complete; ready for admission'}` : r.state === 'uncertain' ? 'Reconcile existing job evidence; never blindly retry' : 'Inspect tracked output; obtain independent audit and host validation', 'Next action from recorded state');
  observed('auditAcceptance', null, 'Worker completion does not prove independent audit acceptance', 'pending');
  observed('installed', false, 'No installation performed', 'not-applicable');
  fields['intake.reviewCount'].effective = reviewCount;
  const identity = r.answers.identity || r.recommendations.identity;
  const lines = [`**${escape(identity.name)}** · \`${r.id}\` · ${escape(identity.type)} · ${r.answers.tier || 'tier pending'} · ${r.answers.priority || 'priority pending'} · **${r.state}**`, ''];
  let group;
  for (const entry of REGISTRY) {
    if (entry.group !== group) {
      group = entry.group;
      lines.push(`### ${entry.title}`, '', '| Setting | Effective value | Requested value / origin / verification |', '| :--- | :--- | :--- |');
    }
    const f = fields[entry.id];
    lines.push(`| \`${entry.id}\` | ${f.status === 'available' ? show(f.effective) : `${show(f.effective)} (${f.status})`} | requested: ${show(f.requested)}; ${escape(f.origin)}; ${escape(f.verification)}; ${escape(f.reason)} |`);
  }
  const receiptHashes = r.receipts.map(x => x.sourceHash);
  lines.push('', `Schema ${r.schemaVersion} · defaults ${r.defaultsVersion} · receipt hashes: ${receiptHashes.join(', ') || 'pending'}`, '', 'Configuration validity, worker completion, audit acceptance and installed behavior are separate states.');
  return { json, cards: lines.join('\n'), receiptHashes, sourceHash: hash({ config: json, receipts: receiptHashes }) };
}
