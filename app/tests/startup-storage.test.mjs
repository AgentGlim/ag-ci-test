import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../control/store.mjs';
import { makePairing } from '../control/auth/pairing.mjs';
import { makePushStore } from '../control/push/store.mjs';
import { applySchema } from '../control/schema.mjs';
import os from 'node:os';
import { archiveScratch } from './helpers/weekly-scratch.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';

// In SQLite's WAL format, a frame with a nonzero database-size field ends a
// transaction. Count actual disk commits, independent of the runner's speed.
function commits(file) {
  const wal = fs.readFileSync(file);
  const pageSize = wal.readUInt32BE(8);
  let n = 0;
  for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    if (wal.readUInt32BE(offset + 4)) n++;
  }
  return n;
}

test('fresh control startup commits all schemas once; reopening preserves data and durability', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-schema-'));
  let store = openStore(dir);
  t.after(() => { store.close(); archiveScratch(dir, t.passed ? 'passed' : 'failed', t.name, t.error); });
  makePairing(store.db);
  makePushStore(store.db);
  assert.equal(commits(store.file + '-wal'), 1, 'schema setup must not flush each table separately');
  assert.equal(store.db.prepare("select count(*) as n from sqlite_master where type = 'table' and name != 'sqlite_sequence'").get().n, 14);
  assert.equal(store.db.prepare('pragma journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('pragma synchronous').get().synchronous, 2, 'FULL durability remains enabled');
  store.auditAdd({ ts: 1, action: 'fixture', result: 'ok' });
  store.close();
  store = openStore(dir);
  makePairing(store.db);
  makePushStore(store.db);
  assert.equal(store.auditList()[0].action, 'fixture');
  assert.equal(fs.statSync(store.file + '-wal').size, 0, 'an existing schema needs no write commit');
});

test('schema failure rolls back its tables while preserving a caller transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table existing (v text); begin; insert into existing values (\'kept\')');
    assert.throws(() => applySchema(db, 'create table partial (v text); invalid sql;'));
    assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'partial'").get().n, 0);
    applySchema(db, 'create table complete (v text)');
    db.exec('rollback');
    assert.equal(db.prepare('select count(*) as n from existing').get().n, 0);
    assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'complete'").get().n, 0);
  } finally { db.close(); }
});

test('a fixture server reaches ready and serves its first snapshot without outbound fetches', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-startup-offline-'));
  fs.writeFileSync(path.join(home, 'env'), '');
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { console.error('UNEXPECTED outbound fetch', new Error().stack); throw Error('offline fixture'); };
    process.argv[2] = '0';
    await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});
  `], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
    archiveScratch(home, t.passed ? 'passed' : 'failed', t.name, t.error);
  });
  const port = await waitForServerReady(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).population);
  assert.doesNotMatch(errors, /UNEXPECTED outbound fetch/);
});

test('snapshot configuration defaults match full Setup discovery without repeated API inventory probes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-config-probes-'));
  t.after(() => archiveScratch(home, t.passed ? 'passed' : 'failed', t.name, t.error));
  fs.writeFileSync(path.join(home, 'env'), '');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const { detect, loadSetup } = await import(${JSON.stringify(new URL('../setup.mjs', import.meta.url).href)});
    const full = loadSetup(detect());
    const read = fs.readFileSync;
    let probes = 0;
    fs.readFileSync = function(file, ...args) {
      if (String(file) === process.env.AGENTGLIM_ENV_FILE || String(file).endsWith('.bashrc')) probes++;
      return read.call(this, file, ...args);
    };
    assert.deepEqual(loadSetup(), full);
    console.log(JSON.stringify({ probes }));
  `], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { probes } = JSON.parse(result.stdout);
  assert.ok(probes <= 40, `configuration loading made ${probes} key-file probes; full API inventory belongs on Setup`);
});
