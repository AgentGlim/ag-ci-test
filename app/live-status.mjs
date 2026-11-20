import { gateFeatureRows } from './feature-ci-verdict.mjs';

// Stored progress is not process liveness. Only tracked running jobs can back a running chip.
const words = (s) => String(s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function mentions(job, item) {
  const text = ` ${words(`${job.label || ''} ${job.note || ''}`).join(' ')} `;
  const title = words(item.title || item.label || item.name).join(' ');
  if (title && text.includes(` ${title} `)) return true;
  // folder: the old folder-style id a job label may still use (a feature id is now an F-number)
  const ids = [item.folder, item.id].filter((v) => v != null).map((v) => String(v).toLowerCase());
  if (!ids.length) return false;
  const jobWords = words(`${job.label || ''} ${job.note || ''}`);
  return ids.some((id) => {
    const tokens = words(id);
    if (tokens.length > 1) return text.includes(` ${tokens.join(' ')} `);
    return jobWords.some((w) => w === id || (/^\d+$/.test(id) && /^\d+$/.test(w) && Number(w) === Number(id)));
  });
}

// Prefer the sub-items named by each job. A job naming none of them backs the whole plan.
// Call with the complete sibling list so an explicitly named job cannot light up unrelated items.
export function liveStatus(items, plan, jobs = []) {
  const live = jobs.filter((j) => j.project === plan && isLiveJob(j));
  const matches = live.map((j) => items.filter((it) => mentions(j, it)));
  return gateFeatureRows(items, plan).map((it) => {
    if (it.status !== 'running' || matches.some((m) => !m.length || m.includes(it))) return { ...it };
    return { ...it, status: 'in progress', statusHint: `idle since ${it.updated || it.finished || 'unknown date'}` };
  });
}

export const isLiveJob = j => j.status === 'running' && (!j.activity || j.activity === 'running');
