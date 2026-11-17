import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, hash, id, validateSettings, validateChoice, verifyContract } from './contracts.mjs';

export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.pending-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonical(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
export class CycleStore {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.file = path.join(this.root, 'state.json');
    this.lockDir = path.join(this.root, 'write-lock');
  }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { schemaVersion: 1, revision: 0, settings: { schemaVersion: 1, policyVersion: 1, revision: 0, global: { preset: 'T2', advanced: {} }, plans: {} }, requests: [], runs: {}, history: [] };
    }
    let envelope;
    try { envelope = JSON.parse(raw); if (!envelope.state || envelope.checksum !== hash(envelope.state) || envelope.state.schemaVersion !== 1) throw new Error(); }
    catch { throw new Error('corrupt or incompatible cycle store; reconciliation required'); }
    validateSettings(envelope.state.settings);
    for (const run of Object.values(envelope.state.runs)) verifyContract(run.contract);
    return envelope.state;
  }
  transaction(fn) {
    try { fs.mkdirSync(this.lockDir); } catch (e) { if (e.code === 'EEXIST') throw new Error('cycle store busy; stale lock requires explicit recovery'); throw e; }
    try {
      fs.writeFileSync(path.join(this.lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      const state = this.read(), result = fn(state);
      if (result && typeof result.then === 'function') throw new Error('async store transaction forbidden');
      state.revision++;
      atomicWrite(this.file, { checksum: hash(state), state });
      return structuredClone(result ?? state);
    } finally {
      const archive = path.join(this.root, '_archive'); fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(this.lockDir, path.join(archive, `lock-${crypto.randomUUID()}`));
    }
  }
  recoverLock() {
    const owner = JSON.parse(fs.readFileSync(path.join(this.lockDir, 'owner.json'), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('unknown lock owner; manual reconciliation required');
    try { process.kill(owner.pid, 0); throw new Error('lock owner still alive'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const archive = path.join(this.root, '_archive'); fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(this.lockDir, path.join(archive, `recovered-lock-${crypto.randomUUID()}`));
    return this.read();
  }
  request({ scope = 'global', choice, expectedRevision, by = 'owner' }, now = Date.now()) {
    if (scope !== 'global') id(scope, 'plan'); validateChoice(choice);
    if (by !== 'owner') throw new Error('settings requester must be owner');
    return this.transaction(s => {
      if (s.settings.revision !== expectedRevision) throw new Error('settings revision conflict');
      const r = { id: crypto.randomUUID(), scope, choice, expectedRevision, requestedBy: by, at: now, status: 'pending' };
      s.requests.push(r); return r;
    });
  }
  apply(requestId, now = Date.now()) {
    return this.transaction(s => {
      const r = s.requests.find(x => x.id === requestId);
      if (!r || r.status !== 'pending') throw new Error('no pending setting');
      if (r.expectedRevision !== s.settings.revision) { r.status = 'refused'; r.reason = 'stale settings revision'; }
      else {
        const next = structuredClone(s.settings);
        if (r.scope === 'global') next.global = { ...next.global, ...r.choice }; else next.plans[r.scope] = r.choice;
        next.revision++; validateSettings(next); s.settings = next; r.status = 'applied';
      }
      r.appliedAt = now; r.appliedBy = 'cycle-consumer'; s.history.push({ type: 'settings', ...r }); return r;
    });
  }
  create(run) { return this.transaction(s => { id(run.contract.runId); if (Object.hasOwn(s.runs, run.contract.runId)) throw new Error('run already exists'); s.runs[run.contract.runId] = run; return run; }); }
  run(runId) { id(runId); const r = this.read().runs[runId]; if (!r) throw new Error('unknown run'); return r; }
  update(runId, expectedRevision, fn) {
    id(runId);
    return this.transaction(s => {
      const r = s.runs[runId]; if (!r || r.revision !== expectedRevision) throw new Error('run revision conflict');
      fn(r); verifyContract(r.contract); r.revision++;
      return r;
    });
  }
}
