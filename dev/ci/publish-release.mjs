// The workflow calls this only after exact-tag CI and every desktop matrix cell pass.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INSTALLER_TYPES = [/\.deb$/i, /\.AppImage$/i, /\.dmg$/i];

const WINDOWS_INSTALLERS = /(?:\.exe|\.msi)$/i;

export function validateRelease({ release, tag, sha, currentSha }) {
  assert.match(tag, /^v[0-9][A-Za-z0-9._-]*$/, 'Expected a version tag');
  assert.match(sha, /^[0-9a-f]{40}$/i, 'Expected the workflow commit SHA');
  assert.equal(currentSha, sha, 'The release tag moved after verification; refusing to publish');
  assert.equal(release.tag_name, tag, 'The draft belongs to a different tag');
  assert.equal(release.draft, true, 'Refusing to change an already-published release');
  const assets = release.assets ?? [];
  assert.ok(!assets.some(asset => WINDOWS_INSTALLERS.test(asset.name)),
    'The draft contains a Windows installer. Remove it before publishing.');
  for (const extension of INSTALLER_TYPES) {
    assert.ok(assets.some(asset => extension.test(asset.name) && asset.state === 'uploaded' && asset.size > 0),
      `Missing a complete installer matching ${extension}`);
  }
}

const runGh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function context(env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Publishing is only allowed after a tag push');
  assert.equal(env.GITHUB_REF_TYPE, 'tag', 'Publishing requires a tag ref');
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Expected a repository');
  const tag = env.GITHUB_REF_NAME;
  assert.match(tag ?? '', /^v[0-9][A-Za-z0-9._-]*$/, 'Expected a version tag');
  assert.equal(env.GITHUB_REF, `refs/tags/${tag}`, 'The workflow ref and tag differ');
  assert.ok(env.GH_TOKEN || env.GITHUB_TOKEN, 'A release-scoped GitHub token is required');
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/i, 'Expected the workflow commit SHA');
  return { repo: env.GITHUB_REPOSITORY, tag, sha: env.GITHUB_SHA };
}

// The tag endpoint only returns published releases. List all authenticated pages so
// a draft beyond the first page is still found; API failures must never mean "absent".
function releaseForTag(repo, tag, gh) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  assert.ok(Array.isArray(pages) && pages.every(Array.isArray), 'Expected paginated release arrays');
  const matches = pages.flat().filter(release => release.tag_name === tag);
  assert.ok(matches.length <= 1, 'Multiple releases have the requested tag');
  return matches[0];
}

export function checkDraft(env = process.env, gh = runGh) {
  const { repo, tag, sha } = context(env);
  const encoded = encodeURIComponent(tag);
  const current = JSON.parse(gh(['api', `repos/${repo}/commits/${encoded}`]));
  assert.equal(current.sha, sha, 'The release tag moved before the build');
  const release = releaseForTag(repo, tag, gh);
  if (!release) return; // the build action may create the initial draft
  assert.equal(release.tag_name, tag, 'The draft belongs to a different tag');
  assert.equal(release.draft, true, 'Refusing uploads to an already-published release');
}

export function publish(env = process.env, gh = runGh) {
  const { repo, tag, sha } = context(env);
  const encoded = encodeURIComponent(tag);
  const current = JSON.parse(gh(['api', `repos/${repo}/commits/${encoded}`]));
  const release = releaseForTag(repo, tag, gh);
  assert.ok(release, 'No release found for the verified tag');
  validateRelease({ release, tag, sha, currentSha: current.sha });
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Expected a release ID');
  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${release.id}`, '--field', 'draft=false']);
  console.log(`Published verified installers for ${tag}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check-draft'), 'Unknown publisher arguments');
  if (process.argv[2] === '--check-draft') checkDraft();
  else publish();
}
