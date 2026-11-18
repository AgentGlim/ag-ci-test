import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

// Windows scanners can briefly retain a handle after the last synchronous read.
// Retry only sharing/permission failures, keeping the source intact on exhaustion.
export async function archiveDirectory(dir, { rename = fs.rename, pause = setTimeout, attempts = 21 } = {}) {
  const root = path.join(path.dirname(dir), '_archive');
  await fs.mkdir(root, { recursive: true });
  const dest = path.join(root, `${path.basename(dir)}-${Date.now()}-${process.pid}`);
  for (let i = 0; ; i++) {
    try { await rename(dir, dest); return dest; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || i + 1 >= attempts) throw error;
      await pause(250);
    }
  }
}
