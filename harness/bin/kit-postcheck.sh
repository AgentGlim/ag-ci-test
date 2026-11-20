#!/usr/bin/env bash
set -euo pipefail
script=$(realpath -e -- "${BASH_SOURCE[0]}")
exec python3 -B "${script%.sh}.py" "$@"
