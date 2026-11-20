// Shared by the native and shell listeners.
import fs from 'node:fs';
import path from 'node:path';

export function loopEvents(run) {
  const dir = path.join(run, 'loop_events');
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const events = [];
  for (const entry of names) {
    if (!entry.isFile() || !/^review-loop-[a-f\d]{24}\.json$/.test(entry.name)) continue;
    try {
      const event = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (event.schemaVersion === 1 && event.kind === 'review-loop'
          && event.id + '.json' === entry.name && typeof event.wake === 'boolean') {
        events.push({ ...event, file: entry.name });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`auditq-wait: invalid loop event ${entry.name}`);
    }
  }
  return events.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
}

const line = (value) => String(value ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').slice(0, 1024);

export function builtLines(events, run) {
  if (!events.length) return [];
  return [
    `BUILT: read the listed event files in ${run}/loop_events. Update VERSIONS.md and Status, relay ready install steps, then move handled events into loop_events/done/.`,
    ...events.map((e) => {
      const result = e.step === 'review' ? line(e.result) || 'REVIEW'
        : e.result ? 'RESULT' : line(e.step);
      return `  ${line(e.file)} · ${line(e.job)} · ${result} · ${line(e.action)}${e.text ? ` · ${line(e.text)}` : ''}`;
    }),
  ];
}

const readJson = (file) => {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
};

export function reviewLoopRows(run, plans) {
  const dir = path.join(run, 'loop_events', 'builds');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    if (!/^[a-f\d]{24}\.json$/.test(name)) continue;
    const ref = readJson(path.join(dir, name));
    if (!ref || typeof ref.root !== 'string' || !/^\d{2}-[\w-]+$/.test(ref.plan)) continue;
    let folder;
    try { folder = fs.realpathSync(path.join(plans, ref.plan, '_build')); } catch { continue; }
    const relative = path.relative(folder, ref.root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    // Authoritative state lives in harness storage; the build's loop.json is only a projection.
    const state = readJson(path.join(run, 'loop_state', name));
    if (state?.schemaVersion !== 1 || state.root !== ref.root || state.plan !== ref.plan
        || state.maxRounds !== 1 && state.maxRounds !== 2 && state.maxRounds !== 3
        || !Array.isArray(state.jobs) || !state.jobs.length) continue;
    const ready = state.status === 'ready' && Array.isArray(state.verdicts) && state.verdicts.at(-1)?.verdict === 'ready';
    const step = state.jobs.at(-1);
    let label = ({
      building: 'Building', reviewing: 'Review running', fixing: 'Fix running', launching: 'Launching',
      'max-rounds': 'Waits on: owner decision', 'paused-hold': 'Waits on: plan HOLD',
      paused: 'Waits on: resume', 'launch-failed': 'Blocked', failed: 'Blocked',
    })[state.status] || 'Pending';
    const built = state.jobs.findLast((job) => ['build', 'fix'].includes(job.step));
    let buildFinished = false;
    if (built && typeof built.id === 'string' && /^(?:\.|[a-z0-9-]+)$/.test(built.id)) {
      const dir = path.join(ref.root, built.id);
      const artifact = path.join(dir, 'RESULT.md');
      try {
        buildFinished = fs.readFileSync(path.join(dir, 'rc'), 'utf8').trim() === '0'
          && fs.lstatSync(artifact).isFile() && !!fs.readFileSync(artifact, 'utf8').trim();
      } catch {}
    }
    if (buildFinished && !state.jobs.some((job) => job.step === 'review' && job.round === built.round && job.begun)) {
      label = 'Waits on: review launch';
    }
    rows.push({
      plan: state.plan, item: relative, round: state.round, status: state.status,
      label: ready ? 'Built, waiting for owner' : label, icon: ready ? '📦' : '⏳',
      reason: state.reason || '', step: step?.step || 'build', updatedAt: state.updatedAt,
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}
