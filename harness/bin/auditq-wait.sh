#!/usr/bin/env bash
# Keep the existing shell entrypoint and run the shared listener.
if [ -z "${AGENTGLIM_RUN:-}" ]; then
  RUN=$(cd "$(dirname "$0")/.." && pwd)
  if [ -d "$RUN/audit_queue" ]; then export AGENTGLIM_RUN=$RUN; fi
fi
SOURCE=$0
while [ -L "$SOURCE" ]; do
  BASE=$(cd "$(dirname "$SOURCE")" && pwd) || exit 2
  SOURCE=$(readlink "$SOURCE") || exit 2
  case "$SOURCE" in /*) ;; *) SOURCE=$BASE/$SOURCE ;; esac
done
exec node "$(dirname "$SOURCE")/auditq-wait.mjs" "$@"
