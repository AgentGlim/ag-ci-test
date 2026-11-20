# Checks for harness install kits

On Linux, copy `kit-install.sh` into a new kit as executable `install.sh`. Use
`KIT_POSTCHECK_RUNNER` if the runner is installed outside `plans/_run/bin`.
The runner requires Bash, Bubblewrap, GNU coreutils, and Python 3.11+.

Ship these files with each reviewed kit:

- `POSTCHECK.json` lists all path targets under `files` and any additional source
  files used by the checks under `inputs`. Prefix paths with `plans/`, `app/`
  (the AgentGlim checkout), or `home/` (the owner's home). List regular files or
  links individually, including every target that starts absent. List changed
  symlink referents separately. Set `"launch": true` for launch-related changes
  outside the automatic path match.
- `tests/POSTCHECK` contains one shell command per line, with blank lines and
  whole-line comments allowed. Alternatively put the same commands in a fenced
  `bash`, `sh`, or `shell` block under a `Post-install tests` heading in
  `RESULT.md`. A longer check belongs in a script invoked by one line.
- Executable `apply.sh` publishes the reviewed files after preflight. Executable
  `rollback.sh` restores the originals. Both receive `POSTCHECK_RECEIPT`,
  `POSTCHECK_ROOT`, `POSTCHECK_APP`, `POSTCHECK_HOME_ROOT`, and `POSTCHECK_KIT`.
  File-only kits can use the runner's `--restore-files "$POSTCHECK_KIT"` in the
  rollback hook. When invoked by the owner directly, the rollback entrypoint
  should call the runner as `--rollback <kit>` with the same root options.
  Hooks run with writable host paths in a private PID namespace. The namespace
  supervisor enforces the deadline, kills remaining descendants (including
  detached sessions), and reaps them before rollback or completion. This also
  applies when a hook succeeds or exits unsuccessfully. Hooks must finish their
  work synchronously; persistent background processes cannot outlive a hook.

Example declaration:

```json
{
  "files": ["plans/_run/bin/example.sh"],
  "inputs": ["plans/_run/bin/example-helper.sh"]
}
```

Run `./install.sh --check` to verify the current files, then `./install.sh` to
check, apply, and check the installed files. The latter holds a plans-directory
lock until the result is recorded or the rollback is verified. A second run
validates the recorded installed hashes and keeps the original rollback point.
Use a new kit directory for a new reviewed revision. Use `--plans-root`,
`--app-root` and `--home-root` to target scratch fixtures. A precheck failure
leaves application to a later install attempt after the cause is fixed.

Commands run from the plans root with `POSTCHECK_ROOT`, `POSTCHECK_APP`,
`POSTCHECK_HOME_ROOT`, `POSTCHECK_KIT`, `POSTCHECK_WORK` and `POSTCHECK_PHASE`
(`pre` or `post`). Use those paths for the source under test. Use the same test
entrypoint for both phases. If a newly introduced feature cannot exist on the
baseline, assert its prerequisite or current behavior in preflight and assert
the new behavior after install. Keep outputs in `POSTCHECK_WORK`. The runner
uses the same source paths in both phases, mounting copies of declared inputs
and targets over their source paths for preflight. Checks see a read-only host
filesystem with an isolated work directory, HOME, PID namespace and network.
Review all commands before running a kit.

For launch-related targets, the runner also exercises the installed
`agent.sh` guard-only path, `worker-launch --dry-run`, and a listener Status
wake that must refresh both heartbeat markers in an isolated queue. Changes to
provider hooks, other listener implementations, or service state should also
declare focused checks for the affected behavior. Tests must use dry runs or
fixtures, with no live queue writes or provider calls.

The default deadline is 600 seconds per check phase or hook. `--timeout N`
changes it. A failing or timed-out live check calls `rollback.sh`, verifies the
restore against the recorded SHA-256 hashes and metadata (including absent
targets), writes `POSTCHECK-FAIL.md` and attempts one owner notification per
failed install. Each attempt retains a receipt and log under the kit's
`_archive`. An interrupted install with an active receipt requires rollback
before another attempt. Roll back overlapping installs in reverse order.
Ctrl-C during a hook waits for its deadline and descendant cleanup before
reporting interruption. Cleanup retains the install lock until all descendants
are reaped; it never declares restoration while a hook writer remains alive.
