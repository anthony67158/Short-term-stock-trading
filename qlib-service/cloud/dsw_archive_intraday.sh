#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_archive_intraday.sh RUN_ID" >&2
  exit 64
fi
RUN_DIR="${ROOT}/minute-runs/${RUN_ID}"
MODEL_DIR="${RUN_DIR}/tcn"
CACHE_DIR="${ROOT}/minute-cache/5min-v1"
ARCHIVE="${RUN_DIR}/raw_5min_v1.tar.gz"
MANIFEST="${RUN_DIR}/sha256_manifest.txt"
TARGET="/mnt/data/runs/${RUN_ID}/intraday"
PYTHON="${ROOT}/.venv/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f "${RUN_DIR}/minute_5m_download.json"
test -f "${MODEL_DIR}/intraday_5m_t1.npz"
test -f "${MODEL_DIR}/tcn.pt"
test -f "${MODEL_DIR}/gru.pt"
test -f "${MODEL_DIR}/transformer.pt"
test -f "${MODEL_DIR}/bakeoff_metrics.json"

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"
"${PYTHON}" cloud/isolation_guard.py --check

test -d "${CACHE_DIR}"
if ! test -f "${ARCHIVE}"; then
  tar -C "${ROOT}" -czf "${ARCHIVE}" minute-cache/5min-v1
fi

FILES=(
  "${RUN_DIR}/minute_5m_download.json"
  "${ARCHIVE}"
  "${MODEL_DIR}/intraday_5m_t1.npz"
  "${MODEL_DIR}/tcn.pt"
  "${MODEL_DIR}/gru.pt"
  "${MODEL_DIR}/transformer.pt"
  "${MODEL_DIR}/tcn_metrics.json"
  "${MODEL_DIR}/gru_metrics.json"
  "${MODEL_DIR}/transformer_metrics.json"
  "${MODEL_DIR}/bakeoff_metrics.json"
  "${MODEL_DIR}/tcn_holdout_predictions.npz"
  "${MODEL_DIR}/gru_holdout_predictions.npz"
  "${MODEL_DIR}/transformer_holdout_predictions.npz"
)

sha256sum "${FILES[@]}" > "${MANIFEST}"
FILES+=("${MANIFEST}")

mkdir -p "${TARGET}"
for file in "${FILES[@]}"; do
  destination="${TARGET}/$(basename "${file}")"
  if test -e "${destination}"; then
    echo "ARCHIVE_TARGET_EXISTS ${destination}" >&2
    exit 2
  fi
  cp "${file}" "${destination}"
done

echo "INTRADAY_ARCHIVE_OK ${TARGET}"
