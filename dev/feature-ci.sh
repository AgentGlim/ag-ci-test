#!/usr/bin/env bash
# Run the Linux feature checks against the commit supplied by the host harness.
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then
  echo "Feature CI requires Linux." >&2
  exit 2
fi
if [ "$(git rev-parse HEAD)" != "${FEATURE_CI_COMMIT:?An exact feature commit is required}" ]; then
  echo "Feature CI checkout does not match the supplied commit." >&2
  exit 2
fi

node dev/privacy-check.mjs --tracked-only --quiet
tracked=$(mktemp "${TMPDIR:-/tmp}/feature-ci-tracked.XXXXXX")
git ls-files > "$tracked"
node dev/leak-scan.mjs . --public "$tracked" --env /dev/null --quiet
for file in app/*.mjs dev/*.mjs harness/*.mjs harness/bin/*.mjs tools/*.mjs; do
  node --check "$file"
done
for file in harness/bin/*.sh; do bash -n "$file"; done
PYTHONWARNINGS=error::DeprecationWarning node --test --test-timeout=180000 app/tests/*.test.mjs
