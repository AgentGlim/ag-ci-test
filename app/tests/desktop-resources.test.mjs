import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { killTree } from '../cli-spawn.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { archiveDirectory } from './helpers/archive-directory.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('desktop staged resources boot the real dashboard with its runtime dependencies', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-desktop-resources-'));
  const checkout = path.join(scratch, 'checkout'), home = path.join(scratch, 'home');
  fs.mkdirSync(path.join(checkout, 'desktop'), { recursive: true });
  fs.mkdirSync(home);
  let server;
  t.after(async () => { await killTree(server, { graceMs: 1000 }); await archiveDirectory(scratch); });
  const keep = file => !path.relative(ROOT, file).split(path.sep).some(name =>
    ['tests', 'node_modules', '_archive', 'target', 'resources', '__pycache__'].includes(name) || /\.bak(?:-|\.|$)/.test(name));
  for (const folder of ['app', 'assets', 'harness', 'schemas', 'examples', 'skills', 'tools']) {
    fs.cpSync(path.join(ROOT, folder), path.join(checkout, folder), { recursive: true, filter: keep });
  }
  for (const name of ['package.json', 'SETUP.md', 'integrations.example.json', '.env.example', 'LICENSE', 'desktop/prepare.mjs', 'docs/dependencies.html']) {
    const target = path.join(checkout, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
  const prepared = spawnSync(process.execPath, ['desktop/prepare.mjs'], { cwd: checkout, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  fs.writeFileSync(path.join(home, 'env'), '');
  fs.writeFileSync(path.join(home, 'harness.json'), '{}');
  const resources = path.join(checkout, 'desktop/resources');
  server = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: resources, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'),
    AGENTGLIM_WORK: path.join(home, 'work'), AGENTGLIM_PLANS: path.join(home, 'plans'),
    AGENTGLIM_RUN: path.join(home, 'plans/_run'), AGENTGLIM_PROJECTS: path.join(home, 'projects'),
    AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_DEV: '1', AGENTGLIM_NO_UPDATE_CHECK: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await waitForServerReady(server);
  server.stdout.resume(); server.stderr.resume();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>AgentGlim<\/title>/);
});
