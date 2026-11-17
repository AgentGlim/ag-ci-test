import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createBuildIntake } from '../build-intake/index.mjs';
import { makeChat } from '../control/watcher/chat.mjs';
import { handleBuildRequest } from '../../harness/bin/build-intake.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bic-'));
  t.after(() => { fs.mkdirSync(path.join(os.tmpdir(), '_archive'), { recursive: true }); fs.renameSync(root, path.join(os.tmpdir(), '_archive', path.basename(root))); });
  const data = path.join(root, 'data'), run = path.join(root, 'run');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, AGENTGLIM_DATA: data, AGENTGLIM_RUN: run,
    AGENTGLIM_CONFIG: path.join(root, 'config.json'), AGENTGLIM_ENV_FILE: path.join(root, 'env') };
  const api = createBuildIntake({ dataDir: data, runDir: run }); api.initializeDefaults();
  return { root, data, run, env, api };
}
test('setup saves a recommendation defaults version once; later setup saves cannot silently edit it', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const {saveSetup}=await import('./app/setup.mjs'); saveSetup({}); saveSetup({});"], { cwd: repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.api.defaults().version, 1);
});
test('chat boundary replaces invented launch prose with all generated cards, without 8000-char truncation', async (t) => {
  const f = fixture(t), r = await f.api.begin({ requestKey: 'chat-one', context: { session: 'SuperAgent', entry: 'chat' }, source: { repository: '/repo', featureDirectory: '/repo/feature', specPath: '/repo/BUILD.md', sourceRevision: 'abc' }, recommendations: { identity: { name: 'Demo', type: 'task', parent: '01-demo' } } });
  const script = path.join(repo, 'harness/bin/chat-write.mjs');
  let p = spawnSync(process.execPath, [script, '--reply', 'invented running summary', '--build-id', r.id, '--session', 'SuperAgent', '--entry', 'chat'], { env: f.env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const entries = fs.readFileSync(path.join(f.data, 'control', 'watcher-in.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 1); assert.equal(entries[0].reply, f.api.summary(r.id).cards); assert.ok(entries[0].reply.length > 8000);
  assert.ok(!entries[0].reply.includes('invented running summary'));
  p = spawnSync(process.execPath, [script, '--reply', 'ordinary', '--build-id', r.id, '--session', 'other', '--entry', 'chat'], { env: f.env, encoding: 'utf8' });
  assert.equal(p.status, 2);
  p = spawnSync(process.execPath, [script, '--reply', 'ordinary'], { env: f.env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(makeChat({ dataDir: path.join(f.data, 'control'), runDir: f.run }).thread().at(-1).text, 'ordinary');
});
test('ten-launch request appears once in SuperAgent chat and survives reload without another delivery', (t) => {
  const f = fixture(t), dir = path.join(f.data, 'build-intake');
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ schemaVersion: 1, id: 'ten-launch-review', at: '2026-01-01T00:00:00Z', question: 'Unlock recommended mode in a future version?', groups: ['identity', 'priority', 'tier', 'roles', 'deadline', 'tests', 'dependencies'] }));
  const chat = () => makeChat({ dataDir: path.join(f.data, 'control'), runDir: f.run });
  assert.equal(chat().thread().length, 1); assert.match(chat().thread()[0].ask.question, /recommended mode/);
  assert.equal(chat().thread()[0].ask.qid, 'ten-launch-review'); assert.ok(chat().mtime() > 0);
  chat().post({ text: 'Keep ask mode', replyTo: 'ten-launch-review', choice: 'Keep ask mode' });
  assert.equal(chat().thread().filter(x => x.kind === 'in').length, 1);
  assert.equal(chat().thread().find(x => x.kind === 'in').ask.answered, true);
});
test('tool exposes grouped chat protocol, refuses unknown operations and never offers recommended launch mode', async (t) => {
  const f = fixture(t);
  assert.equal((await handleBuildRequest({ op: 'defaults' }, f.api)).version, 1);
  await assert.rejects(handleBuildRequest({ op: 'unlock-and-launch' }, f.api), /Unknown/);
  await assert.rejects(handleBuildRequest({ op: 'defaults', arbitrary: true }, f.api), /Unknown/);
});

test('refused launch tool response includes canonical failed-gate cards and zero started jobs', async (t) => {
  const f = fixture(t), record = await f.api.begin({ requestKey: 'refusal', context: { session: 'SuperAgent', entry: 'chat' }, source: { repository: '/repo', featureDirectory: '/repo', specPath: '/repo/BUILD.md', sourceRevision: 'abc' }, recommendations: { identity: { name: 'Demo', type: 'feature', parent: '01-demo' } } });
  const r = await handleBuildRequest({ op: 'launch', id: record.id }, f.api);
  assert.equal(r.refused, true); assert.match(r.cards, /Owner answers required/); assert.deepEqual(r.record.receipts, []);
  assert.equal(r.json.fields['runtime.jobs'].effective.length, 0);
});
