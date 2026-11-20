// Receipt format shared with the plans harness. All authority lives outside worker output.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN } from './paths.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = /^[0-9a-f]{40}$/;

export function featureCiVerdict(job, run = RUN) {
  const missing = job?.ciManaged ? '82' : null;
  if (typeof job?.outdir !== 'string' || !job.outdir) return missing;
  const out = path.resolve(job.outdir.replace(/^~(?=[/\\])/, os.homedir()));
  const id = createHash('sha256').update(out).digest('hex');
  const dir = path.join(run, 'feature-ci-state', 'runs', id);
  let contract;
  try {
    contract = read(path.join(dir, 'contract.json'));
  } catch (error) {
    return error?.code === 'ENOENT' && !fs.existsSync(dir) ? missing : '82';
  }
  try {
    if (contract.version !== 1 || contract.out !== out ||
        (job.project && contract.plan !== job.project)) return '82';
    if (contract.mode === 'review') return 'review';
    if (contract.mode === 'off' || contract.mode === 'release') {
      let config = {};
      try { config = read(path.join(run, 'feature-ci.json')); }
      catch (error) { if (error?.code !== 'ENOENT') return '82'; }
      const profile = config.projects?.[contract.plan] ?? {};
      const visibility = profile.visibility ?? 'private';
      if (!['private', 'public', 'shared'].includes(visibility)) return '82';
      const current = profile.ci ?? (visibility === 'private' ? 'off' : 'per-feature');
      const maxHeld = profile.maxHeld ?? 2;
      return ['off', 'release'].includes(current) && [1, 2, 3].includes(maxHeld) ? null : '82';
    }
    if (contract.mode !== 'per-feature') return '82';
    const terminal = read(path.join(dir, 'terminal.json'));
    if (terminal.state === 'failed' && Number.isSafeInteger(terminal.rc) && terminal.rc !== 0) {
      return String(terminal.rc);
    }
    if (terminal.state !== 'complete' || terminal.rc !== 0 || !sha.test(terminal.commit)) return '82';
    const receipt = read(path.join(dir, 'ci', 'PASS.json'));
    return receipt.version === 1 && receipt.run === id && receipt.commit === terminal.commit &&
      receipt.platform === 'linux' && receipt.verdict === 'PASS' ? '0' : '82';
  } catch {
    return '82';
  }
}
