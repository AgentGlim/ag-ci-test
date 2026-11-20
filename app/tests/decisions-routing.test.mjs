// Decisions routing rename (owner 2026-11-19: "Jev routing" -> "Decisions routing"; only the router model is named
// "jev" or "gemini-decision"). Old URLs, settings keys and harness edit keys must keep working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { migrateSetup, migrateHarness, routerModel, wireKey, editKey, canonicalApi, LEGACY_PAGES, PAGE, EDIT_KEYS } from '../decisions-routing.mjs';

const APP = path.resolve(import.meta.dirname, '..');
const NODE = path.isAbsolute(process.execPath) ? process.execPath
  : (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.execPath))
    .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || process.execPath;

// Temp folders stay in the OS temp dir (no deletes in this repo's new tests; owner rule).
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-decisions-'));
  fs.mkdirSync(`${tmp}/plans`); fs.mkdirSync(`${tmp}/data`, { recursive: true });
  fs.writeFileSync(`${tmp}/env`, '');
  fs.writeFileSync(`${tmp}/harness.json`, '{}');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: `${tmp}/env`,
    AGENTGLIM_CONFIG: `${tmp}/harness.json`, AGENTGLIM_WORK: tmp, AGENTGLIM_PLANS: `${tmp}/plans`, AGENTGLIM_PROJECTS: tmp, AGENTGLIM_DEV: '1' };
  return { tmp, env };
}
const inApp = (env, code) => execFileSync(NODE, ['--input-type=module', '-e', code], { cwd: APP, env, encoding: 'utf8', stdio: 'pipe' });

test('router model column: jev by default, gemini-decision for Gemini rows', () => {
  assert.equal(routerModel({}), 'jev');
  assert.equal(routerModel({ router: 'jev' }), 'jev');
  assert.equal(routerModel({ router: 'gemini-decision' }), 'gemini-decision');
  assert.equal(routerModel({ source: 'Gemini' }), 'gemini-decision');
  assert.equal(routerModel(null), 'jev');
});

test('setup.json migration: old "jev" block becomes "decisions"; the new key wins', () => {
  assert.deepEqual(migrateSetup({ jev: { on: false } }).decisions, { on: false });
  assert.deepEqual(migrateSetup({ decisions: { on: true }, jev: { on: false } }).jev, { on: true });
  assert.equal(migrateSetup(null), null);
  const h = migrateHarness({ jev: { routes: '/a', keyEnv: 'K' }, decisions: { routes: '/b' } });
  assert.deepEqual(h.decisions, { routes: '/b', keyEnv: 'K' }); assert.equal(h.jev, h.decisions);
});

test('harness edit keys: decisions.* shown, jev.* accepted, jev.* on the wire', () => {
  assert.deepEqual(EDIT_KEYS, ['decisions.close', 'decisions.notifyPicks']);
  assert.equal(wireKey('decisions.close'), 'jev.close'); assert.equal(wireKey('jev.notifyPicks'), 'jev.notifyPicks');
  assert.equal(wireKey('decisions.other'), null); assert.equal(wireKey('mode'), null);
  assert.equal(editKey('jev.close'), 'decisions.close');
  assert.equal(canonicalApi('/api/routing'), '/api/decisions-routing');
  assert.equal(canonicalApi('/api/setup/jev/test'), '/api/setup/decisions/test');
  assert.ok(LEGACY_PAGES.includes('/jev-routing') && LEGACY_PAGES.includes('/routing') && !LEGACY_PAGES.includes(PAGE));
});

test('settings: old harness.json "jev" block and old env var still work; "decisions" is the new key', (t) => {
  const { tmp, env } = fixture(); 
  const a = path.join(tmp, 'a.json').replaceAll('\\', '/'), b = path.join(tmp, 'b.json').replaceAll('\\', '/'); fs.writeFileSync(a, '{}'); fs.writeFileSync(b, '{}');
  const get = (extra, key) => execFileSync(NODE, ['settings.mjs', '--get', key], { cwd: APP, env: { ...env, ...extra }, encoding: 'utf8' }).trim();
  fs.writeFileSync(`${tmp}/harness.json`, JSON.stringify({ jev: { routes: a } }));
  assert.equal(get({}, 'decisions.routes'), a); assert.equal(get({}, 'jev.routes'), a);
  fs.writeFileSync(`${tmp}/harness.json`, JSON.stringify({ decisions: { routes: b }, jev: { routes: a } }));
  assert.equal(get({}, 'decisions.routes'), b, 'the new key wins'); assert.equal(get({}, 'jev.routes'), b);
  assert.equal(get({ AGENTGLIM_JEV_ROUTES: a }, 'decisions.routes'), a, 'old env var');
  assert.equal(get({ AGENTGLIM_DECISIONS_ROUTES: b, AGENTGLIM_JEV_ROUTES: a }, 'jev.routes'), b, 'new env var wins');
  assert.equal(get({}, 'decisions.keyEnv'), 'JEV_API_KEY');
});

test('setup: stored "jev" settings migrate; saves write both keys; an old client sending only "jev" still works', (t) => {
  const { tmp, env } = fixture(); 
  fs.writeFileSync(`${tmp}/data/setup.json`, JSON.stringify({ version: 1, jev: { on: false } }));
  inApp(env, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { loadSetup, saveSetup, SETUP_FILE, decisionsStatus, jevStatus } from './setup.mjs';
    assert.equal(loadSetup().decisions.on, false, 'old stored key read as decisions');
    assert.equal(loadSetup().jev.on, false);
    saveSetup({ decisions: { on: true } });
    let f = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8')); assert.equal(f.decisions.on, true); assert.equal(f.jev.on, true);
    saveSetup({ jev: { on: false } }); // old client
    f = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8')); assert.equal(f.decisions.on, false); assert.equal(f.jev.on, false);
    saveSetup({ budget: { apiDailyUsd: 3 } }); // a save without either key keeps the value
    f = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8')); assert.equal(f.decisions.on, false);
    assert.equal(jevStatus, decisionsStatus); assert.equal(decisionsStatus().routingUrl, '/decisions-routing'); assert.equal(decisionsStatus().router, 'jev');
  `);
});

test('harness-set.mjs accepts decisions.* as an alias of jev.*', (t) => {
  const { tmp, env } = fixture(); 
  const rules = path.join(tmp, 'routes.json');
  fs.writeFileSync(rules, JSON.stringify({ close: 0.05, options: { 'claude-sonnet': {}, 'codex-sol': {} }, notify: { picks: [] } }, null, 2));
  const run = (...a) => execFileSync(NODE, ['../harness/bin/harness-set.mjs', ...a], { cwd: APP, env: { ...env, AGENTGLIM_DECISIONS_ROUTES: rules }, encoding: 'utf8' }).trim();
  assert.equal(run('check', 'decisions.close', '0.1'), 'ok');
  assert.match(run('set', 'decisions.close', '0.1', '--by', 'test'), /applied: jev.close 0.05 -> 0.1/);
  assert.match(run('set', 'jev.notifyPicks', 'codex-sol'), /applied/);
  assert.equal(JSON.parse(fs.readFileSync(rules, 'utf8')).close, 0.1);
});

test('server: new page and API, old URLs redirect or alias, router column in rows', async (t) => {
  const { tmp, env } = fixture();
  fs.writeFileSync(`${tmp}/data/jev-route.ndjson`, [
    { t: '2026-11-19T10:00:00Z', task: 'old row without router', pick: 'claude-sonnet', pPick: 0.7, effort: 'medium', ranked: { 'claude-sonnet': 0.7 } },
    { t: '2026-11-19T10:01:00Z', router: 'gemini-decision', task: 'gemini row', pick: 'codex-sol', pPick: 0.8, effort: 'high', ranked: { 'codex-sol': 0.8 } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const srv = spawn(NODE, ['server.mjs', '0'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (srv.exitCode === null && srv.signalCode === null) { srv.kill(); await once(srv, 'exit'); } });
  const port = await waitForServerReady(srv);
  const base = `http://127.0.0.1:${port}`;
  for (const [from, to] of [['/routing', '/decisions-routing'], ['/routing.html', '/decisions-routing'], ['/jev-routing', '/decisions-routing'], ['/jev-routing?x=1', '/decisions-routing?x=1']]) {
    const r = await fetch(base + from, { redirect: 'manual' });
    assert.equal(r.status, 301, from); assert.equal(r.headers.get('location'), to, from);
  }
  const page = await (await fetch(`${base}/decisions-routing`)).text();
  assert.match(page, /<title>Decisions routing<\/title>/); assert.match(page, /<th>Router<\/th>/); assert.doesNotMatch(page, /Jev routing/);
  for (const api of ['/api/decisions-routing', '/api/routing', '/api/jev-routing']) {
    const j = await (await fetch(base + api)).json();
    assert.equal(j.total, 2, api);
    assert.deepEqual(j.decisions.map((d) => d.router).sort(), ['gemini-decision', 'jev'], api);
    assert.deepEqual(j.routers, { jev: 1, 'gemini-decision': 1 });
  }
  for (const api of ['/api/decisions-routing-feedback', '/api/routing-feedback']) {
    const r = await fetch(base + api, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: '2026-11-19T10:00:00Z', verdict: 'right' }) });
    assert.equal(r.status, 200, `${api} ${await r.text()}`);
  }
  for (const api of ['/api/setup/decisions', '/api/setup/jev']) {
    const r = await fetch(base + api, { headers: { origin: base } });
    assert.equal(r.status, 200, api); const j = await r.json();
    assert.equal(j.routingUrl, '/decisions-routing'); assert.equal(j.router, 'jev');
  }
  const setup = await (await fetch(`${base}/setup`)).text();
  assert.match(setup, /id="decisions-routing"><h2>Decisions routing<\/h2>/); assert.match(setup, /#jev/, 'old #jev anchor is forwarded');
  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /href="\/decisions-routing"[^>]*>Decisions routing</);
  const harness = await (await fetch(`${base}/api/harness`)).json();
  assert.ok(harness.decisionsRouting && harness.jev, 'both keys'); assert.deepEqual(harness.decisionsRouting.edits.keys, ['decisions.close', 'decisions.notifyPicks']);
});

test('no "Jev routing" label is left in the app pages', () => {
  for (const f of ['routing.html', 'setup.html', 'harness.html', 'index.html', 'roles.html', 'walkthrough-steps.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(APP, f), 'utf8'), /Jev routing|Jev rules|Jev settings/, f);
  }
});
