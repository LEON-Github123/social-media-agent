#!/usr/bin/env bash
# Always apply the local override; never run the upstream example by itself.
set -euo pipefail

postiz_deploy_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
postiz_repo_root="$(CDPATH= cd -- "${postiz_deploy_dir}/../.." && pwd)"
postiz_env_file="${POSTIZ_ENV_FILE:-${postiz_repo_root}/.env.postiz}"

command -v docker >/dev/null || { echo 'Docker with Compose v2.24.4+ is required.' >&2; exit 1; }
postiz_compose_version="$(docker compose version --short)"
postiz_compose_version="${postiz_compose_version#v}"
if [[ ! "$postiz_compose_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
  (( BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 24) ||
     (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] == 24 && BASH_REMATCH[3] < 4) )); then
  echo 'Docker Compose v2.24.4+ is required for safe port replacement with !override.' >&2
  exit 1
fi
[[ -f "$postiz_env_file" ]] || {
  echo "Missing environment file. Copy .env.postiz.example to $postiz_env_file and configure it first." >&2
  exit 1
}
[[ -f "$postiz_deploy_dir/upstream/docker-compose.yaml" ]] || {
  echo 'Run bash deploy/postiz/bootstrap.sh before invoking Compose.' >&2
  exit 1
}
# Verifies the pinned commit and tracked files, without fetching or replacing them.
bash "$postiz_deploy_dir/bootstrap.sh" >/dev/null

export POSTIZ_UPSTREAM_DIR="${postiz_deploy_dir}/upstream"
export POSTIZ_DEPLOY_DIR="$postiz_deploy_dir"
exec docker compose \
  --project-name "${POSTIZ_PROJECT_NAME:-sma-postiz}" \
  --project-directory "$postiz_repo_root" \
  --env-file "$postiz_env_file" \
  -f "$POSTIZ_UPSTREAM_DIR/docker-compose.yaml" \
  -f "$postiz_deploy_dir/compose.override.yaml" \
  "$@"
