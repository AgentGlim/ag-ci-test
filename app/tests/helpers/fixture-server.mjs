import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './server-ready.mjs';

// Deliberately pass an allowlisted environment: never inherit private homes, data or plans overrides.
export function fixtureServer(prefix = 'ag-ui-', extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const data = path.join(home, 'data');
  const write = (rel, text) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('env', ''); write('harness.json', '{}');
  write('data/setup.json', JSON.stringify({ setupComplete: true }));
  write('data/setup-complete', '');
  let child;
  return {
    home, data, write,
    async start(readyOptions = {}) {
      child = spawn(process.execPath, ['app/server.mjs', '0'], {
        cwd: path.resolve(import.meta.dirname, '../../..'),
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
          AGENTGLIM_DATA: data, AGENTGLIM_ENV_FILE: path.join(home, 'env'),
          AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
          AGENTGLIM_DEV: '1', ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let port;
      try { port = await waitForServerReady(child, 0, readyOptions); }
      catch (error) {
        // Callers may only register this fixture for cleanup after start returns.
        // A readiness failure must not leave a child holding the browser job open.
        await this.stop();
        throw error;
      }
      // Keep draining output after readiness so a long browser run cannot block on a full pipe.
      child.stdout.resume(); child.stderr.resume();
      return `http://127.0.0.1:${port}`;
    },
    async stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
    },
    async close() {
      await this.stop();
      const archive = path.join(os.tmpdir(), '_archive');
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(home, path.join(archive, path.basename(home)));
    },
  };
}
