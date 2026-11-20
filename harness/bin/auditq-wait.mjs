#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { builtLines, loopEvents } from './loop-events.mjs';
import { files, readJson, readQueueItem, readSeen, rememberWake, triage } from './auditq-triage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROTATE_BYTES = 20 * 1024 * 1024;
const QUEUES = [['STATUS', 'status_ask'], ['CHAT', 'chat_inbox'], ['CHECK', 'owner_check'], ['WATCHDOG', 'watchdog_queue']];
const exists = (file) => fs.existsSync(file);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const clean = (value) => String(value ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
const short = (value, max) => {
  const chars = Array.from(clean(value));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
};

async function settings() {
  const configUrl = new URL('../config.mjs', import.meta.url);
  if (!exists(configUrl)) return {};
  const { harnessConfig } = await import(configUrl.href);
  return harnessConfig();
}

function touch(file) {
  const now = new Date();
  try { fs.utimesSync(file, now, now); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { fs.writeFileSync(file, '', { flag: 'wx' }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
  }
}

function pendingAudits(run, plans, now) {
  const queue = path.join(run, 'audit_queue');
  const pending = [];
  for (const file of files(queue, '.req')) {
    const full = path.join(queue, file), name = file.slice(0, -4), base = path.join(queue, name);
    const plan = name.split('__')[0];
    if ([`${full}.taken`, `${full}.decline`, `${base}.taken`, `${base}.decline`, `${base}.refused`].some(exists)) continue;
    if (exists(path.join(plans, plan, 'HOLD'))) {
      try {
        fs.writeFileSync(`${base}.decline`, `declined by watcher ${new Date(now).toISOString()}: plan on HOLD (owner pause)\n`, { flag: 'wx' });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      continue;
    }
    let request;
    try { request = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const record = Object.fromEntries([...request.matchAll(/^([\w-]+)=(.*)$/gm)].map(([, key, value]) => [key, value.trim()]));
    pending.push({ kind: 'PENDING', file: name, full, record: { ...record, plan } });
  }
  return pending.sort((a, b) => Number(b.record.role === 'verify') - Number(a.record.role === 'verify'));
}

function scan(run, plans, options) {
  touch(path.join(run, 'audit_queue', '.alive'));
  touch(path.join(run, 'heartbeats', 'auditq-wait'));
  const items = QUEUES.flatMap(([kind, queue]) => {
    const dir = path.join(run, queue);
    return files(dir, '.json').map((file) => readQueueItem(dir, file, kind));
  });
  // Mode changes retain the existing path via watchdog pending findings or the Codex bridge.
  return [...triage(run, items, options), ...pendingAudits(run, plans, options.now)];
}

function itemId(item) {
  const { record } = item;
  const explicit = [record?.featureId, record?.feature, record?.phaseId, record?.id, item.file];
  const found = explicit.map((value) => /\b[FP]\d{1,5}\b/i.exec(String(value ?? '').replaceAll('_', ' '))?.[0]).find(Boolean);
  if (found) return found.toUpperCase();
  const planNumber = /^(\d{2})-[\w-]+$/.exec(record?.plan)?.[1];
  return planNumber ? `P${Number(planNumber)}` : null;
}

function namesFor(run, ids) {
  const tool = path.join(run, 'bin', 'idname.sh');
  if (!ids.length || !exists(tool)) return new Map();
  const lookup = spawnSync('bash', [tool, ...ids], { encoding: 'utf8', timeout: 5000 });
  return new Map((lookup.stdout || '').split('\n').flatMap((line) => {
    const match = /^([FP]\d+)\s+(.+)$/.exec(line);
    return match && ids.includes(match[1]) && match[2] !== '?' ? [[match[1], short(line, 90)]] : [];
  }));
}

function reasonFor({ kind, record }) {
  if (kind === 'PENDING') {
    const { cloud, role, model, effort, reason } = record;
    return [cloud === 'only' && 'CLOUD ONLY', role === 'verify' ? 'verify first' : role, model, effort, reason].filter(Boolean).join(' · ') || 'audit request';
  }
  const details = record?.reason ?? record?.why ?? record?.text;
  if (details) return details;
  if (record?.choice) return `owner selected ${record.choice}`;
  if (record?.action) return record.action;
  return { STATUS: 'owner requested Status refresh', CHAT: 'inbox message', CHECK: 'owner requested verification', WATCHDOG: 'watchdog finding' }[kind];
}

function wakeLines(run, items) {
  const itemIds = items.map(itemId);
  const names = namesFor(run, [...new Set(itemIds.filter(Boolean))]);
  return items.map((item, index) => {
    const id = itemIds[index];
    const plan = item.record?.plan;
    const planMatch = /^(\d{2})-([\w-]+)$/.exec(plan);
    const planName = planMatch && id === `P${Number(planMatch[1])}` ? planMatch[2].replaceAll('-', ' ') : null;
    const label = names.get(id) || (planName ? `${id} ${planName}` : id) || '-';
    return `${item.kind}: ${clean(item.file)} | plan ${short(plan || '-', 100)} | ${label} | ${short(reasonFor(item), 120)}`;
  });
}

function toolHints(run, kinds, rotation, unseen) {
  const node = (tool) => `node ${quote(path.join(run, 'bin', tool))}`;
  const done = quote(path.join(run, 'watchdog_queue', 'done'));
  const note = path.join(run, 'superagent-listener.md');
  const hints = [
    ['STATUS', `${node('status-write.mjs')} --done ... --running ... --blocked ... --next ... --optimize ...`],
    ['CHAT', `${node('chat-write.mjs')} --reply "..." --to <ms> [--ask Q --option A --option B --qid ID]`],
    ['CHECK', `${node('owner-check.mjs')} list, then confirm <id> "evidence" or reopen <id> "reason"`],
    ['WATCHDOG', `Read watchdog_queue/<file>, handle it, then move it to ${done}.`],
    ['PENDING', 'Read audit_queue/<name>.req, check the Claude 5h window, take verify first, and leave CLOUD ONLY to cloud automation.'],
  ].filter(([kind]) => kinds.has(kind)).map(([kind, hint]) => `  ${kind} ${hint}`);
  if (unseen) hints.push(`  UNSEEN ${node('done-ack.mjs')} list; ack <id> --quote "<owner's words>"`);
  if (rotation) hints.push(`  ROTATE Write ${quote(path.join(run, 'superagent-handoff.md'))} and tell the owner to start a fresh SuperAgent session.`);
  if (exists(note)) hints.push(`  Listener notes ${quote(note)}`);
  return ['TOOLS:', ...hints].join('\n');
}

function currentClaudeSession(env) {
  if (env.AGENTGLIM_CLAUDE_SESSION_LOG) return env.AGENTGLIM_CLAUDE_SESSION_LOG;
  const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
  let id = env.CLAUDE_SESSION_ID, cwd = process.cwd();
  // Use the calling Claude process, never the newest transcript in the project.
  if (!id && process.platform === 'linux') {
    for (let pid = process.ppid, depth = 0; pid > 1 && depth < 32; depth++) {
      const session = readJson(path.join(home, 'sessions', `${pid}.json`));
      try {
        const proc = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = proc.slice(proc.lastIndexOf(')') + 2).split(' ');
        if (session?.sessionId && Number(session.pid) === pid &&
            (session.procStart == null || String(session.procStart) === fields[19])) {
          id = session.sessionId;
          cwd = session.cwd || cwd;
          break;
        }
        pid = Number(fields[1]);
      } catch { break; }
    }
  }
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id || '')) return null;
  const projects = path.join(home, 'projects');
  const file = `${id}.jsonl`;
  const expected = path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'), file);
  if (exists(expected)) return expected;
  try {
    const candidates = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projects, entry.name, file)).filter(exists);
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; }
}

function claimRotation(run, log, now) {
  if (!log) return false;
  let stat, resolved;
  try { resolved = fs.realpathSync(log); stat = fs.statSync(resolved); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.size < ROTATE_BYTES) return false;
  const key = createHash('sha256').update(resolved).digest('hex');
  const directory = path.join(run, 'flags', 'quiet-listener-rotate');
  fs.mkdirSync(directory, { recursive: true });
  try { fs.writeFileSync(path.join(directory, key), `${new Date(now).toISOString()}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  return true;
}

function seconds(value, fallback) {
  const number = Number(value);
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim());
  return numeric && Number.isFinite(number) && number >= 0 && number <= 3600 ? number : fallback;
}

export async function main(env = process.env, out = console.log, timing = {}, args = []) {
  if (args.some((arg) => arg !== '--loop')) { out('usage: auditq-wait [--loop]'); return 2; }
  const continuous = args.includes('--loop'), seenEvents = new Set(), seenItems = new Map();
  const { wait = sleep, elapsed = () => performance.now(), time = Date.now, warn = console.error } = timing;
  const cfg = await settings();
  const beside = path.dirname(path.dirname(path.resolve(process.argv[1] || HERE)));
  const run = env.AGENTGLIM_RUN || (exists(path.join(beside, 'audit_queue')) ? beside : cfg.run || beside);
  const plans = env.AGENTGLIM_PLANS || path.dirname(run);
  if (!exists(path.join(run, 'audit_queue'))) { out(`auditq-wait: no audit_queue folder under '${run}' (set AGENTGLIM_RUN)`); return 2; }
  const runConfig = readJson(path.join(run, 'config.json'));
  const settle = seconds(cfg.listener?.settleSec ?? runConfig?.listener?.settleSec, 60) * 1000;
  const poll = seconds(env.AGENTGLIM_WAIT_POLL, 15) * 1000;
  const rounds = Number(env.AGENTGLIM_WAIT_ROUNDS || 200);
  const data = env.AGENTGLIM_DATA || cfg.roots?.data || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.agentglim');
  const jobsDirs = env.JOBS_TRACK_DIR ? [env.JOBS_TRACK_DIR] : [path.join(data, 'tracked-jobs'), path.join(plans, '_agentglim', 'data', 'tracked-jobs')];
  const sessionLog = currentClaudeSession(env);
  fs.mkdirSync(path.join(run, 'heartbeats'), { recursive: true });
  let deadline = null;
  for (let i = 0; continuous || i < rounds || deadline !== null; i++) {
    const now = time();
    let items = scan(run, plans, { now, jobsDirs, warn });
    if (continuous) {
      const revisions = new Map();
      for (const item of items) {
        try { revisions.set(item.full, fs.readFileSync(item.full, 'utf8')); } catch { /* handled concurrently */ }
      }
      for (const key of seenItems.keys()) if (!revisions.has(key)) seenItems.delete(key);
      items = items.filter((item) => revisions.has(item.full) && seenItems.get(item.full) !== revisions.get(item.full));
      for (const item of items) item.revision = revisions.get(item.full);
    }
    const events = loopEvents(run).filter((event) => !seenEvents.has(event.id));
    if ((items.length || events.some((event) => event.wake)) && deadline === null) deadline = elapsed() + settle;
    if (deadline !== null && elapsed() < deadline) {
      await wait(Math.min(poll || 100, 15000, Math.max(0, deadline - elapsed())));
      continue;
    }
    deadline = null;
    let rotate = false;
    try { rotate = claimRotation(run, sessionLog, now); }
    catch (error) { warn(`auditq-wait: rotation state: ${error.code || error.message}`); }
    if (items.length || rotate || events.some((event) => event.wake)) {
      for (const line of builtLines(events, run)) out(line);
      for (const event of events) seenEvents.add(event.id);
      for (const item of items) if (continuous) seenItems.set(item.full, item.revision);
      for (const line of wakeLines(run, items)) out(line);
      if (rotate) out('ROTATE: Claude session log reached 20 MiB.');
      const dir = path.join(data, 'done-ack');
      const count = files(dir, '.json').filter((name) => name !== 'state.json' && !exists(path.join(dir, `${name.slice(0, -5)}.ack`))).length;
      const unseen = Math.abs(count - (readSeen(run).unseen ?? 0)) >= 10;
      if (unseen) out(`UNSEEN: ${count} finished jobs awaiting acknowledgement.`);
      out(toolHints(run, new Set(items.map((item) => item.kind)), rotate, unseen));
      try { rememberWake(run, items, count, now); }
      catch (error) { warn(`auditq-wait: wake state: ${error.code || error.message}`); }
      if (!continuous) return 0;
    }
    await wait(poll);
  }
  out('NONE (re-arm)');
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.env, console.log, {}, process.argv.slice(2));
