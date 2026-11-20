#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOUR = 3600e3;
const ALERT_SENDERS = new Set(['alert-digest', 'agent-headless', 'failalert', 'jobcheck', 'watchdog']);
const TEST_PATH = /(?:\/(?:_?scratch)(?:\/|$)|\/tmp\/probe(?:\/|$))/;
const INBOX_ID = /^\d{10,16}$/;

export function readJson(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

export function files(dir, suffix) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name).sort();
  } catch { return []; }
}

export function writeJson(file, value) {
  const next = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(next, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(next, file);
}

const seenFile = (run) => path.join(run, 'triage-seen.json');
export const readSeen = (run) => readJson(seenFile(run)) || {};
const recent = (at, now, window) => Number.isFinite(at) && at <= now && now - at < window;
const jobId = (job) => typeof job === 'object' ? (job?.jobId ?? job?.id ?? job?.job) : job;
const validId = (id) => (typeof id === 'string' && !!id.trim()) || Number.isSafeInteger(id);
function jobIds(record) {
  const jobs = record.jobs ?? record.jobIds ?? [record.jobId ?? record.job];
  if (!Array.isArray(jobs) || !jobs.every((job) => validId(jobId(job)))) return null;
  return new Set(jobs.map((job) => String(jobId(job))));
}

function testPlan(plan) {
  return typeof plan === 'string' && plan.split(',').every((value) => /-test$/i.test(value.trim()));
}

function testPath(value) {
  return typeof value === 'string' && TEST_PATH.test(`/${value.replaceAll('\\', '/')}`);
}

const hasProbePath = (job) => [job?.outdir, job?.path, job?.jobPath, job?.job, job?.cwd].some(testPath);

function isProbe(job, jobsDirs) {
  if (testPath(job) || hasProbePath(job) || testPlan(job?.plan ?? job?.project)) return true;
  const id = jobId(job);
  if (!validId(id)) return false;
  const name = String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
  return jobsDirs.some((dir) => {
    const tracked = readJson(path.join(dir, `${name}.json`));
    return tracked?.id != null && String(tracked.id) === String(id) &&
      (testPath(tracked.outdir) || testPlan(tracked.project ?? tracked.plan));
  });
}

// A producer's displayed job list may be capped. Legacy/unknown completeness stays actionable.
const completeDigest = (record) => record?.from !== 'alert-digest' || record.jobsComplete === true;

function testAlert(record, jobsDirs) {
  if (!completeDigest(record)) return false;
  if (testPlan(record.plan ?? record.project) || hasProbePath(record)) return true;
  if (Array.isArray(record.jobs) && record.jobs.length) return record.jobs.every((job) => isProbe(job, jobsDirs));
  // The legacy inbox writer kept the outdir only in agent-headless's structured dedupeKey.
  const legacyPath = record.from === 'agent-headless' && typeof record.dedupeKey === 'string'
    ? record.dedupeKey.slice(record.dedupeKey.indexOf(':') + 1) : null;
  const orphanCwd = record.kind === 'orphan' && typeof record.text === 'string'
    ? /, cwd (.*?):\s/.exec(record.text)?.[1] : null;
  return isProbe(record, jobsDirs) || testPath(legacyPath) || testPath(orphanCwd);
}

export function orphanIdentity(file, record) {
  if (record?.kind !== 'orphan') return null;
  // watchdog.mjs names these orphan_<pid>_<process start>.json and places the PID in its text.
  const name = /^orphan[_-](\d+)(?:[_-](\d+))?\.json$/i.exec(file);
  const textPid = /\bpid\s+(\d+)\b/i.exec(String(record.text || ''))?.[1];
  const pid = Number(record.pid ?? name?.[1] ?? textPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const start = record.procStart ?? record.start ?? name?.[2];
  return { pid, start: start == null ? null : String(start) };
}

function answerFor(chat, ms) {
  if (!INBOX_ID.test(String(ms))) return null;
  const name = `${ms}.json`;
  let file = path.join(chat, `${name}.answered`);
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(chat, name))) return null;
    // Older digests were closed by moving the whole record to done/.
    file = path.join(chat, 'done', name);
  }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const record = readJson(file);
    const stamp = record?.answeredAt;
    const at = typeof stamp === 'string' ? Date.parse(stamp) : stamp;
    return { record, at: Number.isFinite(at) ? at : stat.mtimeMs };
  } catch { return null; }
}

function answeredFailure(item, chat) {
  const match = /^FAILED_(\d{10,16})\.json$/.exec(item.file);
  if (!match) return false;
  const refs = item.record.digests;
  if (refs == null || (Array.isArray(refs) && refs.length === 0)) return !!answerFor(chat, match[1]);
  if (!Array.isArray(refs)) return false;
  const answers = refs.map((ms) => answerFor(chat, ms));
  if (!answers.every(Boolean)) return false;
  // A producer can include jobs merged into a different, open digest in the same failure batch.
  const jobs = jobIds(item.record);
  if (!jobs && (item.record.jobs != null || item.record.jobIds != null)) return false;
  if (!jobs?.size) return true;
  const answered = new Set();
  for (const answer of answers) {
    for (const id of (completeDigest(answer.record) && jobIds(answer.record || {})) || []) answered.add(id);
  }
  return [...jobs].every((id) => answered.has(id));
}

function recentAnswers(chat, now) {
  const answers = new Map();
  const ids = new Set([
    ...files(chat, '.json.answered').map((file) => file.slice(0, -'.json.answered'.length)),
    ...files(path.join(chat, 'done'), '.json').map((file) => file.slice(0, -'.json'.length)),
  ]);
  for (const id of ids) {
    const answer = answerFor(chat, id);
    if (!answer || !recent(answer.at, now, 2 * HOUR)) continue;
    const { record } = answer;
    const jobs = record && jobIds(record);
    if (record?.from !== 'alert-digest' || !record.digestKey || record.triageRule || !completeDigest(record) || !jobs) continue;
    const old = answers.get(record.digestKey);
    if (!old || old.at < answer.at) answers.set(record.digestKey, { at: answer.at, jobs });
  }
  return answers;
}

function relayed(item, seen, now, archived) {
  const orphan = orphanIdentity(item.file, item.record);
  if (!orphan) return false;
  const matches = (old) => old && recent(old.at, now, 24 * HOUR) &&
    (!orphan.start || !old.start || orphan.start === old.start);
  const previous = seen.orphans?.[orphan.pid];
  if (matches(previous) && previous.file !== item.file) return true;
  return (archived().get(orphan.pid) || []).some(matches);
}

function archivedOrphans(dir, now) {
  const done = new Map();
  for (const file of files(dir, '.json')) {
    if (!/^orphan[_-]/i.test(file)) continue;
    const full = path.join(dir, file);
    try {
      const stat = fs.statSync(full);
      if (!recent(stat.mtimeMs, now, 24 * HOUR)) continue;
      const record = readJson(full), identity = orphanIdentity(file, record);
      const at = typeof record?.at === 'number' ? record.at : Date.parse(record?.at);
      if (!identity || !recent(at, now, 24 * HOUR)) continue;
      const prior = done.get(identity.pid) || [];
      prior.push({ ...identity, at });
      done.set(identity.pid, prior);
    } catch { /* archived alert can move independently */ }
  }
  return done;
}

function archive(item, run, rule, now) {
  const directory = path.dirname(item.full);
  const done = path.join(directory, 'done');
  fs.mkdirSync(done, { recursive: true });
  // Relayed orphans can be inferred from the owner's archive. Auto-filed repeats never renew that window.
  const name = rule === 'orphan-repeat' ? `triaged-${item.file}` : item.file;
  const dest = path.join(done, fs.existsSync(path.join(done, name)) ? `${randomUUID()}-${name}` : name);
  const log = fs.openSync(path.join(run, 'triage.log'), 'a', 0o600);
  try {
    // Digest writers publish by rename. A revised item belongs to the next scan.
    const current = fs.lstatSync(item.full);
    if (!item.stat || current.ino !== item.stat.ino || current.mtimeMs !== item.stat.mtimeMs ||
        current.size !== item.stat.size) return false;
    const at = new Date(now).toISOString();
    if (item.kind === 'CHAT' && item.record?.from === 'alert-digest') {
      // Publish closure before removing pending evidence; the producer must not infer a human answer.
      writeJson(`${item.full}.triaged`, { digestKey: item.record.digestKey, triageRule: rule, answeredAt: at });
      // A merge completed before intent publication must stay pending. A merge
      // published after this check sees the intent and emits a replacement wake.
      const claimed = fs.lstatSync(item.full);
      if (claimed.ino !== current.ino || claimed.mtimeMs !== current.mtimeMs ||
          claimed.size !== current.size) return false;
    }
    fs.renameSync(item.full, dest);
    fs.writeSync(log, `${JSON.stringify({ at, file: path.relative(run, item.full), rule })}\n`);
    if (item.kind === 'CHAT' && INBOX_ID.test(path.basename(item.file, '.json'))) {
      try {
        const answer = { ...item.record, answeredAt: at, triageRule: rule, reply: 'Automatically filed by the quiet listener.' };
        fs.writeFileSync(`${item.full}.answered`, `${JSON.stringify(answer)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return true;
  } finally { fs.closeSync(log); }
}

export function readQueueItem(dir, file, kind) {
  const full = path.join(dir, file);
  let stat;
  try { stat = fs.lstatSync(full); } catch { /* file was handled since enumeration */ }
  return { file, full, kind, stat, record: stat?.isFile() ? readJson(full) : null };
}

export function triage(run, items, { now = Date.now(), jobsDirs = [], warn = console.error } = {}) {
  const chat = path.join(run, 'chat_inbox'), done = path.join(run, 'watchdog_queue', 'done');
  const seen = items.some((item) => item.record?.kind === 'orphan') ? readSeen(run) : {};
  let answers, archived;
  const getAnswers = () => answers ??= recentAnswers(chat, now);
  const getArchived = () => archived ??= archivedOrphans(done, now);
  const pending = [];
  // Chat first so a watchdog counterpart can see a marker written in the same scan.
  for (const item of items) {
    const { record, kind } = item;
    let rule;
    if (record && (kind === 'WATCHDOG' || (kind === 'CHAT' && ALERT_SENDERS.has(record.from)))) {
      if (kind === 'WATCHDOG' && answeredFailure(item, chat)) rule = 'answered-chat';
      else if (testAlert(record, jobsDirs)) rule = 'test-probe';
      else if (kind === 'WATCHDOG' && relayed(item, seen, now, getArchived)) rule = 'orphan-repeat';
      else if (kind === 'CHAT' && record.from === 'alert-digest' && record.digestKey) {
        const answer = getAnswers().get(record.digestKey), jobs = jobIds(record);
        if (completeDigest(record) && answer && jobs && [...jobs].every((id) => answer.jobs.has(id))) rule = 'digest-repeat';
      }
    }
    if (rule) {
      try { if (archive(item, run, rule, now)) continue; }
      catch (error) { if (error.code !== 'ENOENT') warn(`auditq-triage: ${item.file}: ${error.code || error.message}`); }
    }
    if (item.stat?.isFile() && fs.existsSync(item.full)) pending.push(item);
  }
  return pending;
}

export function rememberWake(run, items, count, now) {
  const seen = readSeen(run);
  const orphans = Object.fromEntries(Object.entries(seen.orphans || {}).filter(([, old]) => recent(old?.at, now, 24 * HOUR)));
  for (const item of items) {
    if (item.kind !== 'WATCHDOG') continue;
    const identity = orphanIdentity(item.file, item.record);
    if (identity && orphans[identity.pid]?.file !== item.file) {
      orphans[identity.pid] = { at: now, file: item.file, start: identity.start };
    }
  }
  writeJson(seenFile(run), { orphans, unseen: count });
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv[2] || process.env.AGENTGLIM_RUN;
  if (!run || !fs.existsSync(path.join(run, 'audit_queue'))) {
    console.error('usage: auditq-triage.mjs <run-directory>');
    process.exitCode = 2;
  } else {
    const items = [['CHAT', 'chat_inbox'], ['WATCHDOG', 'watchdog_queue']].flatMap(([kind, family]) => {
      const dir = path.join(run, family);
      return files(dir, '.json').map((file) => readQueueItem(dir, file, kind));
    });
    for (const item of triage(run, items)) console.log(`${item.kind}: ${item.file}`);
  }
}
