// Immutable, fsynced records; hard-link publication is an atomic compare-and-set across processes.
// Interrupted temporary files are evidence, never interpreted as committed records or deleted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const SCHEMA = 1;
export const canonical = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
export const clone = (v) => structuredClone(v);
export function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function publish(file, value) {
  const dir = path.dirname(file), pending = path.join(dir, '_pending'), archive = path.join(dir, '_archive');
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 }); fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const temp = path.join(pending, `${crypto.randomUUID()}.json`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonical(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let won = false;
  try { fs.linkSync(temp, file); syncDir(dir); won = true; }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { fs.renameSync(temp, path.join(archive, path.basename(temp))); syncDir(archive); }
  return won;
}
export const sequenceFile = (dir, n) => path.join(dir, `${String(n).padStart(8, '0')}.json`);
export function latest(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^\d{8}\.json$/.test(f)).sort(); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const file = files.at(-1);
  if (!file) return null;
  const value = read(path.join(dir, file));
  if (value?.schemaVersion !== SCHEMA) throw new Error('Unsupported build-intake schema; history preserved');
  return value;
}
export function append(dir, value, previous = 0) {
  return publish(sequenceFile(dir, previous + 1), { ...value, schemaVersion: SCHEMA, sequence: previous + 1 });
}
export function assertKeys(obj, allowed, name) {
  if (!obj || Object.getPrototypeOf(obj) !== Object.prototype) throw new Error(`${name} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`Unknown ${name} field: ${k}`);
}
export function owner(request) {
  assertKeys(request || {}, ['by', 'evidence', 'unlock'], 'owner request');
  if (request.by !== 'owner' || typeof request.evidence !== 'string' || !request.evidence.trim()) throw new Error('Explicit owner request and answer evidence required');
  safeInput(request);
  if (request.evidence.length > 4000) throw new Error('Owner answer evidence exceeds 4000 characters');
  return clone(request);
}
export function safeInput(v) {
  // Reject credentials rather than store/redact them into authoritative configuration.
  const s = canonical(v);
  if (typeof s !== 'string') throw new Error('Intake values must be explicit JSON');
  if (s.length > 65536) throw new Error('Intake exceeds 64 KiB');
  if (/\b(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|-----BEGIN .*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{12,}/i.test(s)) throw new Error('Secret-shaped input refused; use safe aliases');
}
