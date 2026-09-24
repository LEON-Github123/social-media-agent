#!/usr/bin/env bash
# Fetch the complete official Compose tree, including its Temporal dynamicconfig.
set -euo pipefail

postiz_deploy_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
postiz_upstream_dir="${postiz_deploy_dir}/upstream"
postiz_upstream_repo="https://github.com/gitroomhq/postiz-docker-compose.git"
postiz_upstream_commit="dd4969e5e694cd009619a0d53cff14c21104580b"

verify_checkout() {
  local checkout="$1"
  [[ "$(git -C "$checkout" rev-parse HEAD)" == "$postiz_upstream_commit" ]] || {
    echo 'Unexpected upstream commit. Preserve this directory and re-run bootstrap in a clean checkout.' >&2
    return 1
  }
  git -C "$checkout" diff --quiet HEAD -- || {
    echo 'Upstream tracked files were changed. Bootstrap does not overwrite local changes.' >&2
    return 1
  }
  for required_file in docker-compose.yaml dynamicconfig/development-sql.yaml dynamicconfig/development-cass.yaml LICENSE; do
    [[ -f "$checkout/$required_file" ]] || {
      echo "Incomplete upstream tree: missing $required_file" >&2
      return 1
    }
  done
}

if [[ -e "$postiz_upstream_dir" ]]; then
  [[ -d "$postiz_upstream_dir/.git" ]] || {
    echo 'The upstream destination exists but is not a Git checkout; refusing to replace it.' >&2
    exit 1
  }
  verify_checkout "$postiz_upstream_dir"
  echo "Official Postiz Compose already pinned at $postiz_upstream_commit."
  exit 0
fi

postiz_bootstrap_dir="$(mktemp -d "${postiz_deploy_dir}/.bootstrap.XXXXXX")"
trap 'rm -rf -- "$postiz_bootstrap_dir"' EXIT
git init --quiet "$postiz_bootstrap_dir"
git -C "$postiz_bootstrap_dir" remote add origin "$postiz_upstream_repo"
git -C "$postiz_bootstrap_dir" fetch --depth 1 origin "$postiz_upstream_commit"
git -C "$postiz_bootstrap_dir" checkout --quiet --detach FETCH_HEAD
verify_checkout "$postiz_bootstrap_dir"
mv -T -- "$postiz_bootstrap_dir" "$postiz_upstream_dir"
trap - EXIT
echo "Installed complete official Postiz Compose tree at $postiz_upstream_commit."
