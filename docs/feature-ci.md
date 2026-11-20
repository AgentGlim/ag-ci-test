# Per-feature CI

A plans harness that enables per-feature CI runs its approved Linux check command on an isolated snapshot of the feature commit. The harness records the checked SHA, elapsed time and log, then writes `ci/PASS.json` in host-owned state after the review accepts that same commit. AgentGlim reads the receipt before counting the build as complete.

Public and shared project profiles default to per-feature CI. Private project profiles default to off. A project can set `ci` to `per-feature`, `release` or `off` in the harness configuration. Checked features use a dedicated candidate checkout and the existing build and review loop. The test log accompanies the next review after a check fails. The default limit is two held reviews.

The AgentGlim check command inspects the tracked files for privacy and leaks, checks source syntax and runs the app test suite. Run it against a clean Linux checkout with `FEATURE_CI_COMMIT="$(git rev-parse HEAD)" bash dev/feature-ci.sh`. The plans harness uses a host-installed copy of this driver. Per-feature runs use no GitHub Actions minutes. The release workflows cover macOS.
