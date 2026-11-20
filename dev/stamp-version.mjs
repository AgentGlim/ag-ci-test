#!/usr/bin/env node
// stamp-version.mjs: write the release tag into an export's app/version.json.
//   node dev/stamp-version.mjs v0.2.9 <export-dir>
// The private repo's own app/version.json stays "dev"; dev/release.sh calls this after syncing the export,
// so the running app can compare itself with the newest public release. Nothing is committed here.
import fs from 'node:fs';
import path from 'node:path';

const [version, target] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('stamp-version: give a version like v1.2.3');
  process.exit(2);
}
if (!target) {
  console.error('stamp-version: give the export folder');
  process.exit(2);
}
const appDir = path.join(target, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');
console.log(`stamped ${version} in ${path.join(appDir, 'version.json')}`);
