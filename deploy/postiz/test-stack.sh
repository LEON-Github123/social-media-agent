#!/usr/bin/env bash
# An isolated, disposable stack smoke test. Never reads .env.postiz or real keys.
set -euo pipefail

postiz_test_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
postiz_test_root="$(CDPATH= cd -- "${postiz_test_dir}/../.." && pwd)"
for executable in docker git python3; do
  command -v "$executable" >/dev/null || { echo "Missing dependency: $executable" >&2; exit 1; }
done
docker_test() {
  env -i PATH="$PATH" HOME="$HOME" docker "$@"
}
docker_test info >/dev/null
postiz_test_temp="$(mktemp -d)"
postiz_test_project="postiz-stack-ci-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
postiz_test_artifacts="${POSTIZ_STACK_ARTIFACT_DIR:-${postiz_test_temp}/artifacts}"
mkdir -p "$postiz_test_artifacts" "$postiz_test_temp/content"
chmod 755 "$postiz_test_temp/content"
cp "$postiz_test_root/config/postiz/brand.example.json" "$postiz_test_temp/content/brand.json"
printf '[]\n' > "$postiz_test_temp/content/sources.json"
chmod 644 "$postiz_test_temp/content/"*.json
printf 'services:\n  content-worker:\n    image: %s:ci\n' "$postiz_test_project" > "$postiz_test_temp/ci.override.yaml"

# Discard inherited application variables: Compose shell variables otherwise take
# precedence over --env-file and could accidentally use a developer's real keys.
compose_test() {
  env -i PATH="$PATH" HOME="$HOME" \
    POSTIZ_ENV_FILE="$postiz_test_temp/test.env" \
    POSTIZ_PROJECT_NAME="$postiz_test_project" \
    bash "$postiz_test_dir/compose.sh" --profile worker \
    -f "$postiz_test_temp/ci.override.yaml" "$@"
}

sanitize() {
  python3 - "$postiz_test_temp/test.env" "$1" "$2" <<'PY'
import pathlib, re, sys
env_path, source, target = map(pathlib.Path, sys.argv[1:])
text = source.read_text(errors="replace") if source.exists() else "No diagnostics available.\n"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and value and re.search(r"KEY|TOKEN|SECRET|PASSWORD", key, re.I):
            text = text.replace(value, "[redacted]")
text = re.sub(r"(?i)(postgres(?:ql)?|redis)://[^\s\"']+", r"\1://[redacted]", text)
text = re.sub(r"(?i)(authorization\s*[:=]\s*)[^\r\n]+", r"\1[redacted]", text)
target.write_text(text)
PY
}

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -f "$postiz_test_temp/test.env" ]]; then
    if (( result != 0 )); then
      compose_test ps --all > "$postiz_test_temp/status.raw" 2>&1
      compose_test logs --no-color --tail 200 > "$postiz_test_temp/services.raw" 2>&1
      for diagnostic in status services lifecycle namespace; do
        sanitize "$postiz_test_temp/$diagnostic.raw" "$postiz_test_artifacts/$diagnostic.log"
      done
      # Never upload an env file, merged config, database, or full docker inspect.
      echo "Stack test failed; sanitized diagnostics: $postiz_test_artifacts" >&2
      cat "$postiz_test_artifacts/status.log"
      cat "$postiz_test_artifacts/lifecycle.log"
    fi
    compose_test down --volumes --remove-orphans --timeout 30 > "$postiz_test_temp/cleanup.raw" 2>&1
    local cleanup_result=$?
    if (( cleanup_result != 0 )); then
      sanitize "$postiz_test_temp/cleanup.raw" "$postiz_test_artifacts/cleanup.log"
      cat "$postiz_test_artifacts/cleanup.log" >&2
      result=1
    fi
    docker_test image rm "$postiz_test_project:ci" >/dev/null 2>&1
  fi
  # Keep explicitly requested sanitized artifacts; remove raw logs and secrets.
  if [[ -z "${POSTIZ_STACK_ARTIFACT_DIR:-}" && "$result" != 0 ]]; then
    local saved_diagnostics
    saved_diagnostics="$(mktemp -d -t postiz-stack-diagnostics.XXXXXX)"
    cp "$postiz_test_artifacts/"*.log "$saved_diagnostics/" 2>/dev/null
    echo "Sanitized diagnostics retained at $saved_diagnostics" >&2
  fi
  rm -rf -- "$postiz_test_temp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$postiz_test_temp" <<'PY'
import os, pathlib, secrets, socket, sys
directory = pathlib.Path(sys.argv[1])
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
values = {
    "POSTIZ_PUBLIC_URL": f"http://127.0.0.1:{port}",
    "POSTIZ_HTTP_PORT": str(port),
    **{name: secrets.token_hex(32) for name in (
        "POSTIZ_JWT_SECRET", "POSTIZ_DB_PASSWORD", "POSTIZ_REDIS_PASSWORD", "TEMPORAL_DB_PASSWORD")},
    "CONTENT_CONFIG_DIR": str(directory / "content"),
    "CONTENT_SOURCES_FILE": "/app/content/sources.json",
    # Any accidental model request fails locally instead of reaching a provider.
    "CONTENT_MODEL_BASE_URL": "http://127.0.0.1:9/v1",
    "CONTENT_AUTO_SUBMIT": "false",
    "CONTENT_ALLOW_SCHEDULING": "false",
    "CONTENT_DAILY_GENERATION_LIMIT": "1",
    "CONTENT_POLL_INTERVAL_MS": "1000",
}
path = directory / "test.env"
path.write_text("".join(f"{name}={value}\n" for name, value in values.items()))
path.chmod(0o600)
if os.environ.get("GITHUB_ACTIONS") == "true":
    for name, value in values.items():
        if any(word in name for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            print(f"::add-mask::{value}")
PY

echo 'Checking the complete pinned upstream tree and merged deployment configuration.'
bash "$postiz_test_dir/bootstrap.sh"
compose_test config --quiet
compose_test config --format json > "$postiz_test_temp/compose.json"
python3 - "$postiz_test_temp/compose.json" <<'PY'
import json, pathlib, sys
config = json.loads(pathlib.Path(sys.argv[1]).read_text())
services = config["services"]
required = {"postiz", "postiz-postgres", "postiz-redis", "temporal-postgresql", "temporal-elasticsearch", "temporal", "content-worker"}
assert required <= services.keys(), "Missing required service"
assert services["postiz"]["image"] == "ghcr.io/gitroomhq/postiz-app:v2.24.0@sha256:01b24a4fc1055f6833122c99614805bea702fdc0ee30c9b5d09330b521fa1efa"
assert services["temporal"]["image"] == "temporalio/auto-setup:1.28.1"
assert services["temporal"]["environment"]["DYNAMIC_CONFIG_FILE_PATH"] == "config/production-sql.yaml"
for name in required:
    assert not services[name].get("container_name"), f"Unscoped container name: {name}"
    if name != "postiz":
        assert not services[name].get("ports"), f"Unexpected public port: {name}"
for port in services["postiz"]["ports"]:
    assert port["host_ip"] == "127.0.0.1" and port["target"] == 5000
for mount in services["temporal"]["volumes"]:
    assert mount["read_only"] and pathlib.Path(mount["source"]).exists()
assert services["content-worker"]["user"] == "1000:1000"
assert services["content-worker"]["read_only"] is True
assert services["content-worker"]["environment"]["POSTIZ_BASE_URL"] == "http://postiz:5000/api/public/v1"
assert services["content-worker"]["environment"]["CONTENT_AUTO_SUBMIT"] == "false"
assert services["content-worker"]["environment"]["CONTENT_ALLOW_SCHEDULING"] == "false"
assert str(services["content-worker"]["environment"]["CONTENT_DAILY_GENERATION_LIMIT"]) == "1"
assert not services["postiz"]["environment"].get("X_API_KEY")
assert not services["postiz"]["environment"].get("X_API_SECRET")
assert not services["content-worker"]["environment"].get("POSTIZ_API_KEY")
assert not services["content-worker"]["environment"].get("POSTIZ_INTEGRATION_ID")
assert not services["content-worker"]["environment"].get("CONTENT_MODEL_API_KEY")
assert not services["content-worker"]["environment"].get("GETXAPI_TOKEN")
assert not services["content-worker"]["environment"].get("FIRECRAWL_API_KEY")
print("Merged config passed: pinned image, full Temporal config, private dependencies, isolated credentials.")
PY

echo 'Building the worker and starting all required application services (health deadline: 10 minutes).'
compose_test build content-worker > "$postiz_test_temp/lifecycle.raw" 2>&1
compose_test up --detach --wait --wait-timeout 600 postiz content-worker >> "$postiz_test_temp/lifecycle.raw" 2>&1
compose_test ps

echo 'Checking frontend, real backend authentication, Temporal namespace, and the idle worker.'
compose_test exec -T postiz node --input-type=module - <<'JS'
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
const base = 'http://localhost:5000';
const deadline = Date.now() + 120000;
let ready = false;
let last = 'no HTTP response';
while (Date.now() < deadline) {
  try {
    // / redirects to login; use the actual login page so a proxy-generated
    // redirect cannot move this internal probe to the public host/port.
    const frontend = await fetch(`${base}/auth`, { signal: AbortSignal.timeout(5000) });
    await frontend.body?.cancel();
    const api = await fetch(`${base}/api/public/v1/integrations`, { signal: AbortSignal.timeout(5000) });
    await api.body?.cancel();
    // v2.24.0 starts these three applications through PM2. Its frontend-only
    // healthcheck cannot detect a stopped backend/orchestrator process.
    // Parse in memory: PM2's full JSON contains environment variables and must
    // never be printed or added to diagnostic artifacts.
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
    const names = ['frontend', 'backend', 'orchestrator'];
    const online = names.every((name) => processes.some((app) => app.name === name && app.pm2_env?.status === 'online'));
    last = `frontend=${frontend.status}, API=${api.status}, application processes online=${online}`;
    if (frontend.status === 200 && [401, 403].includes(api.status) && online) {
      ready = true;
      break;
    }
  } catch (error) {
    last = error.name;
  }
  await delay(3000);
}
if (!ready) throw new Error(`Frontend/backend did not become ready within 120 seconds (${last})`);
console.log('Postiz frontend/backend/orchestrator are online; the frontend is reachable and the real Public API rejects unauthenticated requests.');
JS
postiz_namespace_deadline=$((SECONDS + 120))
until compose_test exec -T temporal temporal operator namespace describe --address temporal:7233 --namespace default > "$postiz_test_temp/namespace.raw" 2>&1; do
  if (( SECONDS >= postiz_namespace_deadline )); then
    echo 'The Temporal default namespace did not become ready within 120 seconds.' >&2
    exit 1
  fi
  sleep 3
done
compose_test exec -T content-worker node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
assert.equal(process.getuid(), 1000);
assert.ok(existsSync('/data/content.sqlite'));
const response = await fetch(`${process.env.POSTIZ_BASE_URL}/integrations`, { signal: AbortSignal.timeout(10000) });
assert.ok([401, 403].includes(response.status), `Internal Postiz API returned ${response.status}`);
console.log('Non-root worker can read SQLite and reach the real Postiz API through the private network.');
JS
postiz_worker_id="$(compose_test ps --quiet content-worker)"
test -n "$postiz_worker_id"
sleep 5
test "$(docker_test inspect --format '{{.State.Running}} {{.RestartCount}}' "$postiz_worker_id")" = 'true 0'
compose_test exec -T content-worker node dist-postiz/src/postiz/cli.js show --state queued > "$postiz_test_temp/queue.json"
python3 - "$postiz_test_temp/queue.json" <<'PY'
import json, pathlib, sys
assert json.loads(pathlib.Path(sys.argv[1]).read_text()) == [], "Test queue was not empty"
PY
echo 'Full stack smoke test passed. No real model, social credentials, or X publishing were used.'
