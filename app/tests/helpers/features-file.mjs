// features.json at the repo root is the owner's own tracker and is gitignored (line 65 of .gitignore), so a fresh
// clone or worktree has no copy. app/tests/fixtures/features.json is neutral synthetic data with the same shape and
// numbering (F01 to F38 minus the skipped F17): the numbering rules run on it in every checkout. When the owner file
// exists, feature-numbers.test.mjs runs the same rules on it too, so real drift still fails in the owner checkout.
// This helper stays portable: nothing here reads the private plans harness or any owner path outside the repo.
import fs from 'node:fs';

export const realFeaturesFile = new URL('../../../features.json', import.meta.url);
export const fixtureFeaturesFile = new URL('../fixtures/features.json', import.meta.url);
const load = (url) => JSON.parse(fs.readFileSync(url, 'utf8'));

export const hasRealFeatures = () => fs.existsSync(realFeaturesFile);
// The committed fixture, always available (also in a public export, where it is ordinary test data).
export const readFixture = () => load(fixtureFeaturesFile);
// The owner's gitignored tracker, or null in a fresh clone, worktree or public export.
export const readReal = () => (hasRealFeatures() ? load(realFeaturesFile) : null);
