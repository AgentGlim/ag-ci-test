// Revisit cached active outdirs even if the bounded directory walk no longer finds them.
// This updates their terminal rc before a stale active icon can persist indefinitely.
export function scanDirs(discovered, cached, live, queued) {
  const dirs = new Set(discovered);
  for (const [dir, job] of cached) if (job.active) dirs.add(dir);
  for (const dir of live) dirs.add(dir);
  for (const dir of queued) dirs.add(dir);
  return dirs;
}
