import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

// One proc-root switch for every process read (R9.1). AGENTGLIM_PROC points tests and
// fixture runs at a recorded tree; a platform without procfs has no root at all.
// This default is the only proc-path literal in the app: every reader below goes through it.
export function procRoot() {
  if (process.env.AGENTGLIM_PROC) return process.env.AGENTGLIM_PROC;
  return process.platform === 'linux' ? '/proc' : null;
}

// Readers never throw and never reject: no root, a missing pid or a denied file reads as
// empty/null, so a machine without /proc shows an empty process list instead of a crash.
export function readProcText(relative, root = procRoot()) {
  if (!root) return null;
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return null; }
}

export function listPids(root = procRoot()) {
  if (!root) return [];
  try { return fs.readdirSync(root).filter((name) => /^\d+$/.test(name)); } catch { return []; }
}

// Fields 3+ of /proc/<pid>/stat, named. `comm` keeps spaces and parentheses.
export function readStat(pid, root = procRoot()) {
  const raw = readProcText(path.join(String(pid), 'stat'), root);
  if (!raw) return null;
  const open = raw.indexOf('('), close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  return { pid: Number(pid), comm: raw.slice(open + 1, close), state: rest[0], ppid: Number(rest[1]),
    pgid: Number(rest[2]), tty: Number(rest[4]), starttime: Number(rest[19]), raw };
}

// Monitor every accessible PID in one PowerShell process. Use .NET's full
// FILETIME as text to match jobs-track without rounding start times.
// The stop path uses its own fresh, executable-aware identity check.
const WINDOWS_PROCESS_STATS = `
$ErrorActionPreference = 'Stop'
foreach ($process in [System.Diagnostics.Process]::GetProcesses()) {
  try {
    if (!$process.HasExited) {
      $start = $process.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)
      [Console]::WriteLine(('{0} {1}' -f $process.Id, $start))
    }
  } catch {
    # The process exited or its start time is inaccessible.
  } finally {
    $process.Dispose()
  }
}
`;

export function createWindowsProcessStats({ run = execFile } = {}) {
  let snapshot = new Map(), pending;
  return {
    read(pid) { return snapshot.get(pid) ?? null; },
    refresh() {
      if (pending) return pending;
      pending = new Promise((resolve) => {
        const done = (error, output = '') => {
          const stats = new Map();
          if (!error) {
            for (const line of output.split(/\r?\n/)) {
              const match = /^([1-9]\d*) ([1-9]\d*)$/.exec(line);
              if (!match) continue;
              const pid = Number(match[1]);
              if (Number.isSafeInteger(pid)) stats.set(pid, { pid, state: 'S', starttime: match[2] });
            }
          }
          resolve(stats);
        };
        try {
          run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_STATS],
            { encoding: 'utf8', timeout: 5000, windowsHide: true }, done);
        } catch (error) { done(error); }
      }).then((stats) => {
        snapshot = stats;
        pending = null;
      });
      return pending;
    },
  };
}
const windowsProcessStats = createWindowsProcessStats();
export const refreshWindowsProcessStats = () => windowsProcessStats.refresh();

// A fixture root always wins; an absent fixture pid must never consult the real host.
export function readProcessStat(pid, root = procRoot(), {
  platform = process.platform, run = execFileSync, windows = windowsProcessStats,
} = {}) {
  if (root) return readStat(pid, root);
  const key = Number(pid);
  if (!Number.isInteger(key) || key <= 0) return null;
  if (platform === 'win32') return windows.read(key);
  if (platform === 'darwin') {
    try {
      const fields = run('ps', ['-p', String(pid), '-o', 'stat=,ppid=,pgid=,lstart='], {
        encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' },
      }).trim().split(/\s+/);
      if (fields.length !== 8) return null;
      return { pid: Number(pid), state: fields[0][0], ppid: Number(fields[1]), pgid: Number(fields[2]), starttime: fields.slice(3).join(' ') };
    } catch { return null; }
  }
  return null;
}

export function readCmdline(pid, root = procRoot()) {
  const raw = readProcText(path.join(String(pid), 'cmdline'), root);
  if (raw == null) return [];
  const args = raw.split('\0');
  if (args.at(-1) === '') args.pop();
  return args;
}

export function readCwd(pid, root = procRoot()) {
  if (!root) return null;
  try { return fs.readlinkSync(path.join(root, String(pid), 'cwd')); } catch { return null; }
}

export function readEnviron(pid, root = procRoot()) {
  const raw = readProcText(path.join(String(pid), 'environ'), root);
  return raw == null ? [] : raw.split('\0').filter(Boolean);
}

// Resolved targets of the open file descriptors (a held transcript or socket link).
export function readFdLinks(pid, root = procRoot()) {
  if (!root) return [];
  const dir = path.join(root, String(pid), 'fd');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) { try { out.push(fs.readlinkSync(path.join(dir, name))); } catch { /* fd closed mid-scan */ } }
  return out;
}

// Liveness through the OS, not procfs: works on Linux, macOS and Windows in Node.
export function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch { return false; }
}

// ps and CIM expose command text, not argv. Recover quoted arguments without
// executing the text. Windows backslashes only escape quotes, not path letters.
function splitArgs(text, windows = false) {
  const args = [];
  let value = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (windows && c === '\\') {
      let end = i;
      while (text[end] === '\\') end++;
      const count = end - i;
      if (text[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quote = quote ? '' : '"';
        i = end;
      } else { value += '\\'.repeat(count); i = end - 1; }
      started = true;
    } else if (!windows && c === '\\' && quote !== "'" && i + 1 < text.length) {
      value += text[++i]; started = true;
    } else if (c === '"' || (!windows && c === "'")) {
      if (!quote) quote = c;
      else if (quote === c) quote = '';
      else value += c;
      started = true;
    } else if (/\s/.test(c) && !quote) {
      if (started) args.push(value);
      value = ''; started = false;
    } else { value += c; started = true; }
  }
  if (started) args.push(value);
  return args;
}

export function parsePs(text) {
  try {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      rows.push({ pid: +m[1], ppid: +m[2], comm: m[5],
        args: splitArgs(m[6] || ''), cwd: null,
        tty: /^(?:\?\??|-)$/.test(m[4]) ? 0 : m[4], state: m[3] });
    }
    return rows;
  } catch { return []; }
}

export function parseCim(json) {
  try {
    const parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(row => row && Number.isInteger(row.ProcessId) && row.ProcessId >= 0
      && Number.isInteger(row.ParentProcessId) && row.ParentProcessId >= 0
      && typeof row.Name === 'string').map(row => ({
      pid: row.ProcessId, ppid: row.ParentProcessId, comm: row.Name,
      args: typeof row.CommandLine === 'string' ? splitArgs(row.CommandLine, true) : [],
      cwd: null, tty: 0, state: '', // CIM does not supply a Unix process state or tty.
    }));
  } catch { return []; }
}

// CIM can take seconds even on a healthy Windows machine. Never block the
// HTTP event loop on PowerShell; share one in-flight query and a short-lived
// snapshot across dashboard, driver and watcher readers.
export function createWindowsProcessLister({ run = execFile, now = Date.now, ttl = 5000 } = {}) {
  let rows = [], pending = false, expires = 0;
  return () => {
    if (!pending && now() >= expires) {
      pending = true;
      const done = (error, output) => {
        rows = error ? [] : parseCim(output);
        expires = now() + ttl;
        pending = false;
      };
      try {
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json'],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, done);
      } catch (error) { done(error); }
    }
    return rows;
  };
}
const windowsProcesses = createWindowsProcessLister();

// Rows from a proc tree (the live one on Linux, a recorded fixture through AGENTGLIM_PROC
// on any platform). Empty when there is no proc root.
export function listFromProcTree(root = procRoot()) {
  const rows = [];
  for (const pid of listPids(root)) {
    const stat = readStat(pid, root);
    if (!stat) continue; // the process exited during the scan
    rows.push({ pid: stat.pid, ppid: stat.ppid, comm: stat.comm, args: readCmdline(pid, root),
      cwd: readCwd(pid, root), tty: stat.tty, state: stat.state });
  }
  return rows;
}

let procCache = { at: 0, rows: null };
export function listProcesses() {
  const fixture = process.env.AGENTGLIM_PROC;
  try {
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    // A fixture tree wins on every platform, so the proc-parsing tests read the same bytes everywhere.
    if (process.platform === 'darwin' && !fixture) {
      return parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,tty=,comm=,args='], options));
    }
    if (process.platform === 'win32' && !fixture) {
      return windowsProcesses();
    }
    if (fixture) return listFromProcTree();
    // CPU fix 2026-11-13: one /proc walk serves every caller within 2 s (scan, driver checks, watchers)
    if (!procCache.rows || Date.now() - procCache.at > 2000) procCache = { at: Date.now(), rows: listFromProcTree() };
    return procCache.rows;
  } catch { return []; }
}

// Keep Linux's available-memory accounting; other platforms (and no proc root) may omit it.
export function readMemoryInfo() {
  const raw = readProcText('meminfo');
  if (!raw) throw new Error('Memory info unavailable');
  return Object.fromEntries(raw.split('\n').map(line => line.split(/:\s+/)).filter(parts => parts[1]).map(([key, value]) => [key, parseInt(value) * 1024]));
}
