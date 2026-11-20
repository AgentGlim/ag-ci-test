// Receipt format shared with the plans harness. All authority lives outside worker output.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN } from './paths.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = /^[0-9a-f]{40}$/;

function currentMode(run, plan) {
  let config = {};
  try { config = read(path.join(run, 'feature-ci.json')); }
  catch (error) { if (error?.code !== 'ENOENT') return null; }
  const profile = config.projects?.[plan] ?? {};
  const visibility = profile.visibility ?? 'private';
  const mode = profile.ci ?? (visibility === 'private' ? 'off' : 'per-feature');
  if (!['private', 'public', 'shared'].includes(visibility) ||
      !['off', 'release', 'per-feature'].includes(mode) ||
      ![1, 2, 3].includes(profile.maxHeld ?? 2)) return null;
  return mode;
}

export function featureCiVerdict(job, run = RUN) {
  const missing = job?.ciManaged ? '82' : null;
  if (typeof job?.outdir !== 'string' || !job.outdir) return missing;
  let out = path.resolve(job.outdir.replace(/^~(?=[/\\])/, os.homedir()));
  try { out = fs.realpathSync(out); } catch {}
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
        (job.project && contract.plan !== job.project) ||
        (job.feature && contract.feature !== job.feature)) return '82';
    if (contract.mode === 'review') return 'review';
    if (contract.mode === 'off' || contract.mode === 'release') {
      const current = currentMode(run, contract.plan);
      return current === 'off' || current === 'release' ? null : '82';
    }
    if (contract.mode !== 'per-feature') return '82';
    const terminal = read(path.join(dir, 'terminal.json'));
    if (terminal.state === 'failed' && Number.isSafeInteger(terminal.rc) && terminal.rc !== 0) {
      return String(terminal.rc);
    }
    if (terminal.state !== 'complete' || terminal.rc !== 0 || !sha.test(terminal.commit)) return '82';
    if (job.commit && job.commit !== terminal.commit) return '82';
    const receipt = read(path.join(dir, 'ci', 'PASS.json'));
    return receipt.version === 1 && receipt.run === id && receipt.commit === terminal.commit &&
      receipt.platform === 'linux' && receipt.verdict === 'PASS' ? '0' : '82';
  } catch {
    return '82';
  }
}

// Legacy queue rows predate receipts and can still have status done on disk.
export function gateFeatureRows(items, plan, run = RUN) {
  if (!/^\d\d-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(plan)) return items;
  const mode = currentMode(run, plan);
  if (mode === 'off' || mode === 'release') return items;
  return items.map(item => {
    const legacyFeature = item.kind === 'feature' || /^_build\/features\//.test(item.brief ?? '');
    if (!legacyFeature || item.status !== 'done') return item;
    const number = /^F?(\d+)(?:[-_].*)?$/i.exec(String(item.id));
    if (number) {
      const feature = `F${Number(number[1])}`;
      try {
        const proof = read(path.join(run, 'feature-ci-state', 'features', plan, feature, 'completion.json'));
        if (sha.test(proof.commit) &&
            featureCiVerdict({ project: plan, feature, outdir: proof.out, commit: proof.commit }, run) === '0') return item;
      } catch {}
    }
    return { ...item, status: 'blocked', statusHint: 'Waiting for a matching feature CI receipt' };
  });
}
