// F31 and alert digest share the exact cause taxonomy and key implementation.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { RUN } from './paths.mjs';
const source = process.env.F31_FAILURE_CAUSE_MODULE || path.join(RUN, 'bin/failure-cause.mjs');
let shared;
try { shared = await import(pathToFileURL(source).href); } catch (e) { shared = { unavailable: e.code || e.message }; }
const { classify, classifyJob, alertKey, CAUSES } = shared;
export const failureLedgerAvailability = () => ({ available: !!classifyJob, ...(shared.unavailable ? { reason: shared.unavailable } : {}) });
export { classify, classifyJob, alertKey, CAUSES };
export function failureLedger(attempts = []) {
  if (!classifyJob) return []; // optional harness absent: no invented fallback cause rules
  return attempts.filter(j => j && (['failed','stopped','error'].includes(j.status) || j.rc != null && String(j.rc) !== '0')).map(job => {
    const classification = classifyJob(job);
    const from = job.alertFrom || job.from || 'failalert', plan = job.project || job.plan || 'SuperAgent', kind = job.alertKind || 'failed';
    return { id: job.id ?? null, attempt: { id: job.id, status: job.status, rc: job.rc, started: job.started, ended: job.ended, outdir: job.outdir, pid: job.pid, pidStart: job.pidStart, harness: job.harness, model: job.model }, from, plan, kind, ...classification,
      key: alertKey({ from, plan, kind, cause: classification.cause }),
      timeoutSeconds: job.timeoutSeconds ?? job.timeout ?? null };
  });
}
