#!/usr/bin/env bash
# Reproduces the `nightly` job in .github/workflows/compat-harness.yml locally:
# build workspace packages, start the compat-harness dev server, run the CLI
# against it to regenerate package-matrix.json, tear the server down, then
# regenerate the compat app's derived packages.json from the fresh matrix.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS_DIR="$ROOT_DIR/apps/compat-harness"
LOG_FILE="$(mktemp -t compat-harness-dev-log)"
PORT=5173

cleanup() {
  if [[ -n "${HARNESS_PID:-}" ]] && kill -0 "$HARNESS_PID" 2>/dev/null; then
    kill "$HARNESS_PID" 2>/dev/null || true
    wait "$HARNESS_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "==> Building workspace packages"
(cd "$ROOT_DIR" && pnpm build)

echo "==> Ensuring Playwright Chromium is installed"
(cd "$ROOT_DIR" && pnpm exec playwright-core install chromium)

echo "==> Starting compat-harness dev server on :$PORT"
(cd "$HARNESS_DIR" && pnpm exec vite --port "$PORT" --host) >"$LOG_FILE" 2>&1 &
HARNESS_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -s "http://localhost:$PORT" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "Harness dev server failed to start" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "Harness dev server did not become ready in time" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
echo "Harness dev server is ready"

echo "==> Running package matrix"
node "$HARNESS_DIR/bin/cli.js" --json --url "http://localhost:$PORT" \
  --output "$ROOT_DIR/apps/site/landing/public/results/package-matrix.json"

echo "==> Stopping compat-harness dev server"
kill "$HARNESS_PID" 2>/dev/null || true
wait "$HARNESS_PID" 2>/dev/null || true
unset HARNESS_PID

echo "==> Regenerating compat app data from fresh matrix"
(cd "$ROOT_DIR" && pnpm --filter @browser-containers/site-compat run sync-data)

echo "==> Done"
