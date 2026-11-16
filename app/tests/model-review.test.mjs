// model review redesign (2026-11-14): evidence first, alias table, auto-approve, cheap model only for unresolved, migration archives
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
process.env.AGENTGLIM_DATA = `${tmp}/data`;
fs.mkdirSync(process.env.AGENTGLIM_DATA, { recursive: true });
const mr = await import('../model-review.mjs');
const price = (m) => (m === 'claude-opus-5-5' || m === 'deepseek-v4.1-flash' ? { input: 1, output: 2 } : null);
const job = (files) => { const d = fs.mkdtempSync(path.join(tmp, 'job-')); for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(`${d}/${f}`), { recursive: true }); fs.writeFileSync(`${d}/${f}`, t); } return d; };

test('canonical ids collapse spellings and kind aliases', () => {
  assert.equal(mr.canonicalModel('opus48'), 'claude-opus-4-8');
  assert.equal(mr.canonicalModel('anthropic/claude-opus-4.8'), 'claude-opus-4-8');
  assert.equal(mr.canonicalModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(mr.canonicalModel('opencode-go/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(mr.canonicalModel('?'), null);
});

test('evidence: model ids from Claude stream-json, Codex events, Pi sessions and launcher notes', () => {
  const d = job({ 'stream.jsonl': '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{}}}\n',
    'session/a.jsonl': '{"type":"message","message":{"role":"assistant","provider":"opencode-go","model":"deepseek-v4.1-flash"}}\n',
    meta: '2026-11-14 01:00:00 start kind=opus48\n' });
  const ev = mr.evidenceFromDir(d).map((e) => e.model).sort();
  assert.deepEqual(ev, ['claude-opus-4-8', 'deepseek-v4.1-flash']);
  assert.deepEqual(mr.evidenceFromDir(job({ meta: 'start kind=opus48\nend kind=opus48 rc=75\n' })), []);
});

test('opus48 with no logs resolves through its pinned kind, never to ElevenLabs', () => {
  const r = mr.resolve({ kind: 'opus48', model: null, priceOf: price, llm: { model: 'eleven-v3', provider: 'elevenlabs' } });
  assert.equal(r.canonical, 'claude-opus-4-8');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.status, 'owner'); // unpriced and not approved yet
  assert.match(r.summary, /no price/);
});

test('auto-approve when provider matches the harness and a price exists', () => {
  assert.equal(mr.resolve({ kind: 'opus', model: 'claude-opus-5-5', priceOf: price }).status, 'auto');
  assert.equal(mr.resolve({ kind: 'pi:opencode-go/deepseek-v4.1-flash', model: 'deepseek-v4.1-flash', priceOf: price }).status, 'auto');
  // a Claude model on the Codex harness is not auto-approved
  assert.equal(mr.resolve({ kind: 'codex', model: 'claude-opus-5-5', priceOf: price }).status, 'owner');
});

test('one alias approval covers every name of the model', () => {
  mr.approveAlias('claude-opus-4-8', { provider: 'anthropic', class: 'subscription', source: 'owner' }, ['opus48']);
  for (const [kind, model] of [['opus48', null], ['premium', 'claude-opus-4-8'], ['opus', 'anthropic/claude-opus-4.8']])
    assert.equal(mr.resolve({ kind, model, priceOf: price }).status, 'approved', `${kind}|${model}`);
});

test('unresolved: no model id anywhere goes to the cheap model; its answer is cached', async () => {
  const r = mr.resolve({ kind: 'mystery', model: null, priceOf: price });
  assert.equal(r.canonical, null); assert.equal(r.status, 'owner');
  let calls = 0;
  const fetcher = async (url, o) => { calls++; assert.match(JSON.parse(o.body).model, /deepseek-v4.1-flash/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"model":"gpt-6.1-sol","provider":"codex","evidence":"premium model: gpt-6.1-sol"}' } }] }) }; };
  const a = await mr.askCheapModel('mystery|?', { kind: 'mystery', notes: ['premium model: gpt-6.1-sol'] }, { apiKey: 'k', fetcher });
  assert.equal(a.model, 'gpt-6.1-sol');
  await mr.askCheapModel('mystery|?', { kind: 'mystery' }, { apiKey: 'k', fetcher });
  assert.equal(calls, 1);
  assert.equal(mr.llmCached('mystery|?').provider, 'codex');
  assert.equal(await mr.askCheapModel('other|?', { kind: 'other' }, {}), null); // no key: no call
});

test('migration seeds aliases, archives duplicates and the ElevenLabs guess, deletes nothing', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'mig-'));
  fs.writeFileSync(`${data}/classes.json`, JSON.stringify({
    'opus48|claude-opus-4-8': { provider: 'anthropic', class: 'subscription', source: 'rule', approvedAt: '2026-11-14T00:17:20Z' },
    'opus48|?': { provider: 'anthropic', class: 'subscription', source: 'review', approvedAt: '2026-11-14T08:53:40Z' },
    'luna|gpt-6.1-sol': { provider: 'codex', class: 'subscription' },
  }));
  fs.writeFileSync(`${data}/jev-cache.json`, JSON.stringify({ 'opus48|?': { provider: 'elevenlabs', providerP: 0.68 } }));
  fs.writeFileSync(`${data}/model-rejects.json`, JSON.stringify({ 'opus48|?': { count: 1, note: null }, 'luna|gpt-6.1-sol': { count: 1, note: 'keep: owner note' } }));
  const r = mr.migrate({ data, stamp: 'test' });
  const al = JSON.parse(fs.readFileSync(`${data}/model-aliases.json`));
  assert.deepEqual(al['claude-opus-4-8'].names, ['claude-opus-4-8', 'opus48']);
  assert.ok(!JSON.parse(fs.readFileSync(`${data}/classes.json`))['opus48|?']);
  assert.ok(!JSON.parse(fs.readFileSync(`${data}/jev-cache.json`))['opus48|?']);
  assert.ok(JSON.parse(fs.readFileSync(`${data}/model-rejects.json`))['luna|gpt-6.1-sol']);
  const arch = JSON.parse(fs.readFileSync(`${r.dir}/archived-items.json`));
  assert.ok(arch.classes['opus48|?'] && arch.jev['opus48|?'] && arch.rejects['opus48|?']);
  assert.ok(fs.existsSync(`${r.dir}/classes.json.before`));
});
