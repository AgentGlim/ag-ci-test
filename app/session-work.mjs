// Session-bound work is independently observed and only feeds the Agents table.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listProcesses, procRoot, readProcText, readProcessStat } from './proc.mjs';

const TEN_MINUTES = 600_000;
const providers = { claude: 'anthropic', codex: 'codex', pi: 'pi', opencode: 'opencode' };
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd']);
const detached = new Set(['agent.sh', 'worker-launch.sh', 'worker-launch.mjs', 'headless.sh', 'headless-take.sh', 'cloud-take.sh', 'jobs-track', 'jobs-track.py']);
const listener = new Set(['auditq-wait.sh', 'auditq-wait.mjs', 'watcher-bridge.py', 'superagent-check.sh']);
const base = (s = '') => path.posix.basename(s.replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase();
const age = (started, now) => Number.isFinite(started) && started > 0 && now - started > TEN_MINUTES;

function sessionHarness(row) {
  const [command, script] = row.args;
  const key = Object.hasOwn(providers, base(command)) ? base(command) :
    (/^(?:node|bun)$/.test(base(command)) && base(script).replace(/\.m?js$/, ''));
  if (!Object.hasOwn(providers, key) || row.args.some((arg) => /^(?:-p|--print|--headless|exec|run)$/.test(arg))) return null;
  return key;
}

function systemCommand(args) {
  const [command, ...rest] = args;
  return [base(command), ...(/^\w*(?:sh|node|python\d*)$/.test(base(command)) ? rest.slice(0, 1).map(base) : [])];
}

let ticksPerSecond;
function processStartReader() {
  const root = procRoot();
  if (root) {
    const bootSeconds = Number(readProcText('stat', root)?.match(/^btime\s+(\d+)$/m)?.[1]);
    if (!bootSeconds) return () => null;
    if (ticksPerSecond === undefined) {
      try { ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 })); }
      catch { ticksPerSecond = null; }
    }
    return (pid) => {
      const stat = readProcessStat(pid, root);
      return stat?.state !== 'Z' && stat?.starttime > 0 && ticksPerSecond > 0
        ? bootSeconds * 1000 + stat.starttime / ticksPerSecond * 1000 : null;
    };
  }

  return (pid) => {
    const stat = readProcessStat(pid, root);
    if (!stat || stat.state === 'Z') return null;
    if (process.platform === 'win32') return Number(BigInt(stat.starttime) / 10_000n - 11_644_473_600_000n);
    return Date.parse(stat.starttime);
  };
}

export function sessionShells({ rows = listProcesses(), started = processStartReader(), now = Date.now(), projectOf = () => null } = {}) {
  const live = rows.filter((row) => row.state !== 'Z' && row.args.length);
  const byPid = new Map(live.map((row) => [row.pid, row]));
  const children = Map.groupBy(live, (row) => row.ppid);
  const hasRole = (row, roles) => systemCommand(row.args).some((name) => roles.has(name));
  return live.flatMap((row) => {
    if (!shells.has(base(row.args[0])) || !row.args.some((arg) => /^-(?:[a-z]*c[a-z]*)$|^\/(?:c|k)$|^-(?:command|encodedcommand)$/i.test(arg))) return [];
    const parent = byPid.get(row.ppid);
    const harness = parent && sessionHarness(parent);
    if (!harness || (children.get(row.pid) || []).some((child) => hasRole(child, listener))) return [];
    if (row.args.some((arg) => /^while true;\s*do touch (?:-- )?["']?(?:[^;"']*\/)?_run\/heartbeats\/auditq-wait["']?;\s*sleep \d+;\s*done\s*&?\s*$/.test(arg))) return [];
    // A shell waiting on an already tracked launcher is just its wrapper.
    if ((children.get(row.pid) || []).some((child) => hasRole(child, detached))) return [];
    const seen = new Set([row.pid, parent.pid]);
    for (let ancestor = byPid.get(parent.ppid); ancestor && !seen.has(ancestor.pid); ancestor = byPid.get(ancestor.ppid)) {
      if (hasRole(ancestor, detached)) return [];
      seen.add(ancestor.pid);
    }
    const time = started(row.pid);
    if (!age(time, now)) return [];
    return [{ project: projectOf(row.cwd || parent.cwd), task: 'Session shell', role: 'shell', harness, started: time }];
  });
}

export function sessionWorkRows(jobs, helpers = [], shells = [], { now = Date.now(), excluded = new Set() } = {}) {
  const known = new Set(jobs.filter((job) => job.harness === 'claude').map((job) => job.agentId).filter(Boolean));
  const subagents = jobs.filter((job) => {
    if (job.kind !== 'subagent' || job.status !== 'running' || job.activity === 'finished' || !age(job.started, now)) return false;
    if (detached.has(base(String(job.launcher || '').split(' ')[0])) || job.req || job.dispatchVerified) return false;
    const explicit = /^(?:claude (?:agent|task) tool|opencode task tool|codex spawn_agent|pi subagent tool)$/i.test(job.launcher || '');
    if (job.harness === 'claude' && !job.agentId && !job.transcriptVerified && !job.pid) return false;
    return explicit || (!job.pid && Boolean(job.agentId || job.sessionPid));
  }).map((job) => ({ ...job, role: 'subagent', task: job.label }));
  const unregistered = helpers.filter((job) => job.parentVerified && !known.has(job.id)).map((job) => ({
    project: 'SuperAgent', harness: 'claude', role: 'subagent', task: job.task, model: job.model, started: job.start, lastActivity: job.end,
  }));
  return [...subagents, ...unregistered, ...shells].filter((job) => age(job.started, now) && !excluded.has(providers[job.harness]))
    .map((job) => ({
      project: job.project || '', role: job.role, task: job.task || 'Session subagent', kind: job.harness,
      provider: providers[job.harness], model: job.model, active: true, diesOnQuit: true,
      started: job.started, lastMsg: job.lastActivity || null, cost: 0, costState: 'not captured',
      calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
}
