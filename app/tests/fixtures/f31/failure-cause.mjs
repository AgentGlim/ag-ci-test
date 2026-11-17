#!/usr/bin/env node
// Recorded shared failure-cause authority, 2026-11-17. Test fixture only.
// Source SHA-256: 93496b1be2eca63336a41a38184af1541c0a87b0d5b83ed2e073bccfc85cfe65
// failure-cause.mjs: the ONE failure-cause classifier (owner 2026-11-16, alert digest build, shared-work note).
//
// Why one module: the alert digest key (`from` + `plan` + `kind` + cause) and F31's job-status-integrity failure
// ledger must name a failure the same way, or the two views disagree about how many "timeouts" there were.
// F31 imports `classify` / `classifyJob` / `CAUSES` from here instead of writing its own list.
//
// Plain code, no model calls, no I/O. Callers pass what they know:
//   classify({ from, kind, plan, text, rc, endReason, cause })  -> { cause, label, urgent, key }
//   classifyJob(jobRecord)                                      -> same, from a jobs-track record
// `cause` wins when the caller already knows it (failalert's problem kind, agent-headless' blocked/needs-input),
// as long as it is a known cause id. Otherwise the first matching rule below decides.
//
// urgent = may bypass the digest's answered-suppression and wake the owner at once (BUILD rule 5):
//   kind=blocked/needs-input that needs the owner, and limit / circuit-breaker alerts.
// The 30-minute per-key dedupe still applies to urgent alerts (they are digests too).

export const CAUSES = Object.freeze({
  // launch / environment
  'nested-launch-refused': { label: 'nested or independent launch refused (guard, sandbox isolation, or a headless rc 78 stop)', urgent: false },
  'codex-unavailable': { label: 'Codex would not start (helper or binary missing)', urgent: false },
  'guard-refused': { label: 'refused by a launch guard (rc 64/65)', urgent: false },
  'repo-lock': { label: 'refused by the repo write lock (rc 79)', urgent: false },
  // needs the owner
  'blocked-needs-owner': { label: 'blocked: needs an owner decision', urgent: true },
  'provider-limit': { label: 'limit or circuit breaker (usage, quota, budget, rate limit)', urgent: true },
  // how the job ended
  'timeout': { label: 'timed out', urgent: false },
  'killed': { label: 'killed, no exit code', urgent: false },
  'noreport': { label: 'ended rc 0 but wrote no report', urgent: false },
  'silent': { label: 'still running but silent', urgent: false },
  'owner-stop': { label: 'stopped on purpose by the owner or the SuperAgent', urgent: false },
  'real-failure': { label: 'real work failure', urgent: false },
  // jobcheck's own problems (AgentGlim vs live agents)
  'jobcheck-timecap': { label: 'jobcheck hit its time cap', urgent: false },
  'jobcheck-snapshot': { label: 'jobcheck could not read AgentGlim', urgent: false },
  'jobcheck-registration': { label: 'job registration / board row mismatch', urgent: false },
  'jobcheck-problem': { label: 'jobcheck problem it could not fix', urgent: false },
  'unknown': { label: 'cause not recognised', urgent: false },
});

const JOBCHECK_RULES = [
  [/time cap/i, 'jobcheck-timecap'],
  [/could not run|fetch failed|snapshot/i, 'jobcheck-snapshot'],
  [/not shown under|missing from Active builds|other-projects row|maps it to plan|is not on the board|unassigned/i, 'jobcheck-registration'],
];
const RULES = [
  // stopped on purpose first: such a job often also carries a killed/no-exit-code marker
  [/stopped by owner|stopped by superagent|owner requests|owner clarified|stopped on purpose/i, 'owner-stop'],
  [/codex-code-mode-host|codex-code-mode|exec-server|could not start (?:the )?codex|codex (?:binary|cli|helper|executable)[^.]{0,40}(?:missing|not found|unavailable)/i, 'codex-unavailable'],
  [/\b(?:rate.?limit|usage limit|quota|circuit.?break|limit reached|aggregate budget reached|budget reached before|too many requests)\b/i, 'provider-limit'],
  [/timed out|\btimeout\b/i, 'timeout'],
  [/nested[- ]?(?:codex|subscription|launch|guard)|independent (?:test|test-author|audit|verification|review)[^.]{0,70}(?:refus|denied|cannot|could not|blocked|prevent|pending)|audit[ -]?log[^.]{0,50}(?:denied|unwritable|read-only|cannot)|host (?:parent )?pid|host superagent dispatch|guest ssh|ssh (?:credentials|files)|isolated pid namespace|codex launch refused/i, 'nested-launch-refused'],
  [/refused by a (?:launch )?guard|guard refusal/i, 'guard-refused'],
  [/repo(?:sitory)? write lock/i, 'repo-lock'],
  [/needs?.input|needs_input|^blocked:|[^a-z]blocked:/i, 'blocked-needs-owner'],
  [/killed|stopped without an exit code|process ended without an exit code/i, 'killed'],
  [/no report|noreport/i, 'noreport'],
  [/no file written for|\bsilent\b/i, 'silent'],
];

// "exit code 78", "rc=75", "rc 124": the same words the alert texts already use.
export function rcFromText(text) {
  const s = String(text || '');
  const m = s.match(/\bexit code (-?\d+)\b/i) || s.match(/\brc\s*[=: ]\s*(-?\d+)\b/i) || s.match(/\brc=(-?\d+)\b/i);
  return m ? m[1] : null;
}

// One alert text can carry several jobs (failalert joins them with " | "). Classify each job segment and keep the
// dominant cause, so a 6-job alert is not filed under whichever cause happened to appear first.
export function segmentCauses({ from, kind, hay, rc = null }) {
  const parts = hay.split(' | ').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [pick({ from, kind, rc: rc ?? rcFromText(hay), hay })];
  return parts.map((part) => pick({ from, kind, rc: rcFromText(part), hay: part }));
}

export function classify(alert = {}) {
  const text = String(alert.text || '');
  const endReason = String(alert.endReason || '');
  const hay = endReason ? `${text}\n${endReason}` : text;
  const rc = alert.rc == null || alert.rc === '' ? rcFromText(hay) : String(alert.rc);
  const from = String(alert.from || '');
  const kind = String(alert.kind || '');
  const forced = alert.cause && Object.hasOwn(CAUSES, alert.cause) ? alert.cause : null;
  const causes = forced ? [forced] : segmentCauses({ from, kind, hay, rc });
  const counts = new Map();
  for (const c of causes) counts.set(c, (counts.get(c) || 0) + 1);
  let cause = causes[0];
  for (const c of causes) if (counts.get(c) > counts.get(cause)) cause = c;
  return { cause, causes, label: CAUSES[cause].label, urgent: CAUSES[cause].urgent, rc };
}

function pick({ from, kind, rc, hay }) {
  if (from === 'jobcheck') {
    for (const [re, cause] of JOBCHECK_RULES) if (re.test(hay)) return cause;
    return 'jobcheck-problem';
  }
  // Callers' own markers before the generic rules (agent-headless writes "NEEDS INPUT (blocked)").
  if (kind === 'needs-input' || kind === 'blocked') {
    for (const [re, cause] of RULES) if ((cause === 'nested-launch-refused' || cause === 'provider-limit' || cause === 'owner-stop' || cause === 'codex-unavailable' || cause === 'timeout') && re.test(hay)) return cause;
    return 'blocked-needs-owner';
  }
  for (const [re, cause] of RULES) if (re.test(hay)) return cause;
  if (rc === '75' || rc === '76') return 'provider-limit';
  if (rc === '64' || rc === '65') return 'guard-refused';
  if (rc === '79') return 'repo-lock';
  if (rc === '124') return 'timeout';
  if (rc === '78') return 'nested-launch-refused'; // a headless wrapper that stopped for input
  if (rc && rc !== '0') return 'real-failure';
  if (from === 'agent-headless') return 'blocked-needs-owner';
  return 'unknown';
}

// The digest key. One home for the shape: `from|plan|kind|cause` (BUILD rule 2).
export function alertKey({ from, plan, kind, cause }) {
  return `${from || 'unknown'}|${plan || 'SuperAgent'}|${kind || 'alert'}|${cause || 'unknown'}`;
}

// A jobs-track record -> the same classification (F31's ledger and the digest agree).
// `stderr` is optional: the tail of the job's stderr.log/last.txt, only used when the record has no endReason.
export function classifyJob(job = {}) {
  const text = [job.endReason, job.why, job.stderr].filter(Boolean).join('\n');
  return classify({ from: job.from || 'job-failalert', kind: job.kind || 'failed', rc: job.rc, endReason: job.endReason, text });
}

export const causeList = () => Object.entries(CAUSES).map(([cause, v]) => ({ cause, ...v }));
