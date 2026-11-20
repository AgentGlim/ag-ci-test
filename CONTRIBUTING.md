# Contributing

## Branches, pull requests and releases

- `main` is the production branch: use pull requests, not direct pushes. Maintainers must configure and verify
  required status checks in GitHub; this document does not establish branch protection.
- Work on a branch (`fix/...`, `feat/...`), push it and open a pull request into `main`.
- CI (`.github/workflows/ci.yml`) must pass before merge: the privacy and leak scan, the Node/Python matrix and fresh
  install/update checks on Linux and macOS, and one Linux Chromium smoke lane. Windows weekly CI reports its own
  results. Keep all Windows checks out of the required status checks in GitHub.
- Releases are annotated tags on `main`: `git tag -a vX.Y.Z -m "AgentGlim vX.Y.Z" && git push origin vX.Y.Z`.
  Tag builds re-run the complete CI suite for that commit. Installers stay in a draft until Linux, macOS and the
  Linux native-window smoke pass; an already-public release is never overwritten by a rerun. See desktop/README.md
  for the manual, main-only Rust cache pilot. Existing local release and approval gates still apply.

## Privacy check before every commit

Enable the repo's hooks once per clone:

```sh
git config core.hooksPath .githooks
```

`.githooks/pre-commit` runs `node dev/privacy-check.mjs` and then `dev/leak-scan.mjs` on exactly the staged files,
matching key values from your local `.env` without printing them. A finding stops the commit. CI runs the same checks
on every pull request, so skipping the hook with `--no-verify` only moves the failure to the pull request.

## Checks and development

Run `npm test` and `npm run privacy-check` before committing. CI-only tools live in `dev/ci/`, with exact versions
and a lockfile; they are not application runtime dependencies or desktop-bundled resources. Install them with
`npm ci --prefix dev/ci --ignore-scripts --no-audit --no-fund`, then run `node --test dev/ci/tests/*.test.mjs` for the
workflow contracts and publisher's fail-closed fixture tests. The browser workflow installs Chromium once and runs
`skills-editor-xss`, `send-to-agent` and `inbox-resend` on isolated fixtures. It does not launch real agents. The privacy checker scans tracked and publishable
untracked files for credentials, private names, home-folder paths and copied private goals. Set private names in
`~/.config/agentglim/private-names.txt`; never commit that file. `node dev/leak-scan.mjs FOLDER` scans an export.
These are contributor checks, not user onboarding steps.

Use `AGENTGLIM_DEV=1 node app/server.mjs 18992` for development. Use a scratch HOME, an empty `AGENTGLIM_ENV_FILE`
and isolated data when testing a clean install. Dev mode disables pricing/reset jobs, usage polling and process actions.
Back up existing files before edits. Keep archived copies and private screenshots outside release staging.

The desktop staging script includes generic add-ons and bundled project skills but never machine skills, profiles,
.env files, logs or runtime data. Node can be shipped as a platform-specific licensed sidecar in a future installer;
currently it must be installed separately. Chromium, Python, harness CLIs, local models and Tailscale stay optional.
