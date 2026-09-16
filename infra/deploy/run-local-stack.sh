#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${ROOT}/.runtime/local-production"
PORT="${PLATFORM_PORT:-8000}"

mkdir -p "${RUNTIME_DIR}"
cd "${ROOT}"

pnpm build
(
  cd backend
  uv run alembic upgrade head
  uv run platform-ops preflight
)

export PLATFORM_ORIGIN="${PLATFORM_ORIGIN:-http://127.0.0.1:${PORT}}"
export PLATFORM_WEB_DIST_ROOT="${ROOT}/apps/web/dist"
export PLATFORM_DEPLOYMENT_REVISION="$(
  git -C "${ROOT}" rev-parse --short=12 HEAD
)"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "${ROOT}/backend"
uv run python -m platform_app.modules.research.worker \
  >"${RUNTIME_DIR}/research-worker.log" 2>&1 &
pids+=("$!")
uv run python -m platform_app.modules.decisions.worker \
  >"${RUNTIME_DIR}/decision-worker.log" 2>&1 &
pids+=("$!")
uv run python -m platform_app.modules.review.worker \
  >"${RUNTIME_DIR}/review-worker.log" 2>&1 &
pids+=("$!")
uv run python -m platform_app.modules.portfolio.worker \
  >"${RUNTIME_DIR}/portfolio-worker.log" 2>&1 &
pids+=("$!")
uv run uvicorn platform_app.entrypoints.api:app \
  --host 127.0.0.1 \
  --port "${PORT}" \
  >"${RUNTIME_DIR}/api.log" 2>&1 &
api_pid="$!"
pids+=("${api_pid}")

printf 'Stock platform running at %s\n' "${PLATFORM_ORIGIN}"
wait "${api_pid}"
