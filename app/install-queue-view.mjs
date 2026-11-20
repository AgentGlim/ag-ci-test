// Read-only projection; the browser can copy owner commands but never execute them.
import fs from 'node:fs';
import path from 'node:path';
export function installQueueRows(run) {
  const file = path.join(run, 'install_queue/state.json');
  try {
    if (!fs.lstatSync(file).isFile()) return [];
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.schemaVersion !== 1 || !Array.isArray(state.entries)) throw new Error('invalid queue state');
    return state.entries.slice(-30).reverse().map(e => ({
      id: String(e.id || ''), name: String(e.name || ''), status: String(e.status || 'unknown'),
      reason: String(e.reason || ''), command: e.status === 'owner' ? String(e.command || '') : '',
    }));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [{ id: 'T15', name: 'Install queue', status: 'unavailable',
      reason: 'Queue status cannot be read; inspect _run/install_queue/state.json.', command: '' }];
  }
}
