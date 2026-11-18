import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { archiveDirectory } from './helpers/archive-directory.mjs';
import { freshFetch } from './helpers/fresh-fetch.mjs';

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO']) {
  test(`archive keeps evidence and bounds retries for ${code}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-archive-retry-'));
    fs.writeFileSync(path.join(dir, 'evidence'), 'kept');
    let calls = 0;
    const rename = async (src, dst) => {
      calls++;
      if (code === 'EIO' || calls < 3) throw Object.assign(new Error(code), { code });
      await fs.promises.rename(src, dst);
    };
    if (code === 'EIO') {
      await assert.rejects(archiveDirectory(dir, { rename, pause: async () => {} }), { code });
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(path.join(dir, 'evidence'), 'utf8'), 'kept');
      await archiveDirectory(dir);
    } else {
      const dest = await archiveDirectory(dir, { rename, pause: async () => {} });
      assert.equal(calls, 3);
      assert.equal(fs.readFileSync(path.join(dest, 'evidence'), 'utf8'), 'kept');
    }
  });
}
test('permanent Windows lock fails after the retry budget and preserves the source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-archive-locked-'));
  let calls = 0;
  await assert.rejects(archiveDirectory(dir, { attempts: 3, pause: async () => {}, rename: async () => {
    calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  } }), { code: 'EBUSY' });
  assert.equal(calls, 3); assert.ok(fs.existsSync(dir));
  await archiveDirectory(dir);
});

test('HTTP journey opens new connections across a blocking CLI and never retries POST', async (t) => {
  const sockets = new Set(), hits = [];
  const server = http.createServer((req, res) => {
    sockets.add(req.socket); hits.push(req.method);
    assert.equal(req.headers.connection, 'close');
    res.end('ok');
  });
  server.keepAliveTimeout = 10;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await freshFetch(url)).text(), 'ok');
  assert.equal(spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']).status, 0);
  assert.equal(await (await freshFetch(url, { method: 'POST', headers: { origin: url }, body: '{}' })).text(), 'ok');
  assert.deepEqual(hits, ['GET', 'POST']); assert.equal(sockets.size, 2);
});
