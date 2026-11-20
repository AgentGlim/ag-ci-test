#!/usr/bin/env bash
# Copy to the kit root as install.sh. Supply apply.sh, rollback.sh, and a postcheck declaration.
set -euo pipefail
kit=$(cd -- "$(dirname -- "$0")" && pwd -P)
runner=${KIT_POSTCHECK_RUNNER:-"$HOME/dev/projects/plans/_run/bin/kit-postcheck.sh"}
if [[ ${1:-} == --check ]]; then
  shift
  exec "$runner" --pre "$kit" "$@"
fi
exec "$runner" --install "$kit" "$@"
