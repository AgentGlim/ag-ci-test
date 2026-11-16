import test from 'node:test';
import assert from 'node:assert/strict';
import { publish, validateRelease, checkDraft } from '../publish-release.mjs';

const sha = 'a'.repeat(40);
const tag = 'v1.2.3';
const release = () => ({ tag_name: tag, draft: true, assets: ['app.deb', 'app.AppImage', 'app.dmg', 'app-setup.exe', 'app.msi'].map(name => ({ name, state: 'uploaded', size: 100 })) });
const fixture = () => ({ release: release(), tag, sha, currentSha: sha });
const env = () => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF: `refs/tags/${tag}`, GITHUB_REF_NAME: tag, GITHUB_SHA: sha, GITHUB_REPOSITORY: 'example/fixture', GH_TOKEN: 'fixture-token' });

test('preflight accepts a missing release or existing draft, but never a published release', () => {
  for (const scenario of ['missing', 'draft', 'public', 'api-error', 'moved']) {
    const calls = [];
    const run = () => checkDraft(env(), args => {
      calls.push(args);
      if (args[1].includes('/commits/')) return JSON.stringify({ sha: scenario === 'moved' ? 'b'.repeat(40) : sha });
      if (scenario === 'missing') throw Object.assign(Error('not found'), { status: 1, stderr: 'gh: Not Found (HTTP 404)' });
      if (scenario === 'api-error') throw Object.assign(Error('rate limited'), { status: 1, stderr: 'gh: Forbidden (HTTP 403)' });
      return JSON.stringify({ ...release(), draft: scenario !== 'public' });
    });
    if (['missing', 'draft'].includes(scenario)) assert.doesNotThrow(run);
    else assert.throws(run);
    assert.equal(calls.some(args => args[0] === 'release'), false);
  }
});

test('complete draft for the verified tag is accepted', () => {
  assert.doesNotThrow(() => validateRelease(fixture()));
});
for (const extension of ['.deb', '.AppImage', '.dmg', '-setup.exe', '.msi']) {
  test(`missing ${extension} blocks publishing`, () => {
    const f = fixture();
    f.release.assets = f.release.assets.filter(a => !a.name.endsWith(extension));
    assert.throws(() => validateRelease(f), /Missing a complete installer/);
  });
}
test('empty or incomplete uploads block publishing', () => {
  for (const bad of [{ size: 0 }, { state: 'new' }]) {
    const f = fixture(); Object.assign(f.release.assets[0], bad);
    assert.throws(() => validateRelease(f), /Missing a complete installer/);
  }
});
test('a moved tag, wrong draft tag or already-public release blocks publishing', () => {
  for (const change of [f => { f.currentSha = 'b'.repeat(40); }, f => { f.release.tag_name = 'v9.9.9'; }, f => { f.release.draft = false; }]) {
    const f = fixture(); change(f); assert.throws(() => validateRelease(f));
  }
});
test('publisher reads the current tag and draft before its only write', () => {
  const calls = [];
  publish(env(), args => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/commits/') ? { sha } : release());
    return '';
  });
  assert.deepEqual(calls, [
    ['api', `repos/example/fixture/commits/${tag}`],
    ['api', `repos/example/fixture/releases/tags/${tag}`],
    ['release', 'edit', tag, '--repo', 'example/fixture', '--draft=false'],
  ]);
});
test('bad event, ref, credentials or tag never reaches a write', () => {
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF_TYPE: 'branch' }, { GITHUB_REF: 'refs/heads/main' }, { GH_TOKEN: '' }, { GITHUB_REF_NAME: '--bad' }]) {
    const calls = [];
    assert.throws(() => publish({ ...env(), ...patch }, args => { calls.push(args); return '{}'; }));
    assert.equal(calls.some(args => args[0] === 'release'), false);
  }
});
test('verification failures and API errors leave the draft unpublished', () => {
  for (const scenario of ['moved', 'incomplete', 'api-error']) {
    const calls = [];
    assert.throws(() => publish(env(), args => {
      calls.push(args);
      if (scenario === 'api-error') throw Error('fixture API failure');
      if (args[1].includes('/commits/')) return JSON.stringify({ sha: scenario === 'moved' ? 'b'.repeat(40) : sha });
      const r = release(); if (scenario === 'incomplete') r.assets = [];
      return JSON.stringify(r);
    }));
    assert.equal(calls.some(args => args[0] === 'release'), false);
  }
});
