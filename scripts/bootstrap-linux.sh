#!/usr/bin/env bash
set -Eeuo pipefail

# Optional GoTutor Linux bootstrap.
#
# This is useful on a fresh machine when the repository has not been cloned.
#
# Usage:
#   ./scripts/bootstrap-linux.sh https://github.com/YOURUSER/GoTutor.git
#
# Optional destination:
#   ./scripts/bootstrap-linux.sh https://github.com/YOURUSER/GoTutor.git ~/GoTutor
#
# Once cloned, it immediately runs scripts/setup-linux.sh.

REPO_URL="${1:-${GOTUTOR_REPO_URL:-}}"
DEST="${2:-${GOTUTOR_DIR:-GoTutor}}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: $0 <git-repository-url> [destination-directory]" >&2
  echo >&2
  echo "Example:" >&2
  echo "  $0 https://github.com/example/GoTutor.git ~/GoTutor" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required for the bootstrap clone step." >&2
  echo "Install git, then rerun this script." >&2
  exit 1
fi

if [[ -e "$DEST" ]]; then
  echo "Destination already exists: $DEST" >&2
  exit 1
fi

git clone "$REPO_URL" "$DEST"
cd "$DEST"

chmod +x scripts/setup-linux.sh
exec ./scripts/setup-linux.sh
