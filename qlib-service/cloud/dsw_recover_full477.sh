#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
cd "$ROOT"

mkdir -p full477
exec > >(tee -a full477/recovery_master.log) 2>&1
trap 'unset TUSHARE_TOKEN' EXIT

echo "[recovery] start $(date -Iseconds)"
if [[ -z "${TUSHARE_TOKEN:-}" ]]; then
  read -rsp "Tushare Token: " TUSHARE_TOKEN
  echo
  export TUSHARE_TOKEN
fi

# Stop the incomplete pipeline before it trains on the 367-stock partial cache.
pkill -TERM -f '[b]ash full477/run.sh' 2>/dev/null || true
pkill -TERM -f '[b]uild_dataset_ts.py.*panel_full477' 2>/dev/null || true
pkill -TERM -f '[t]rain_lgb.py.*full477' 2>/dev/null || true
sleep 3

rm -f full477/dataset_base.npz full477/dataset_ext.npz
rm -f full477/lgb_score.txt full477/meta.json full477/evaluation.json

# The uploaded baseline package predates the shared 429 cooldown fix. Keep this
# recovery pass deliberately below the provider limit and use one worker.
sed -i \
  -e 's/TushareClient(max_per_min=135)/TushareClient(max_per_min=45)/' \
  -e 's/TushareClient()/TushareClient(max_per_min=45)/' \
  tushare_panel.py

COOLDOWN_SECONDS="${RECOVERY_COOLDOWN_SECONDS:-305}"
if [[ ! "$COOLDOWN_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "[recovery] invalid RECOVERY_COOLDOWN_SECONDS: $COOLDOWN_SECONDS"
  exit 2
fi
echo "[recovery] waiting $COOLDOWN_SECONDS seconds for provider cooldown"
sleep "$COOLDOWN_SECONDS"

echo "[recovery] refetch missing panel files"
.venv/bin/python tushare_panel.py \
  --pool 477 \
  --start 20220101 \
  --end 20260729 \
  --out panel_full477 \
  --workers 1 | tee full477/refetch.log

echo "[recovery] validate panel cache"
.venv/bin/python - <<'PY'
from pathlib import Path
import json
import numpy as np

root = Path("panel_full477")
expected = json.load(open(root / "_pool.json", encoding="utf-8"))
expected_codes = {str(code) for code, _name in expected}
files = sorted(root.glob("*.npz"))
actual_codes = {path.stem.replace("_", ".") for path in files}
bad = []
for path in files:
    try:
        with np.load(path) as data:
            for key in ("dates", "o", "h", "l", "c", "v"):
                if key not in data.files or len(data[key]) < 120:
                    raise ValueError(key)
    except Exception as error:  # noqa: BLE001
        bad.append((path.name, str(error)))

missing = sorted(expected_codes - actual_codes)
extra = sorted(actual_codes - expected_codes)
print("PANEL_COUNT", len(files))
print("PANEL_BAD", len(bad))
print("PANEL_MISSING", len(missing))
print("PANEL_EXTRA", len(extra))
if bad:
    print("PANEL_BAD_SAMPLE", bad[:5])
if missing:
    print("PANEL_MISSING_SAMPLE", missing[:10])
assert len(expected_codes) == 477
assert len(files) == 477 and not bad and not missing and not extra
print("PANEL_VALIDATION_OK")
PY

echo "[recovery] build aligned datasets"
.venv/bin/python build_dataset_ts.py \
  --panel panel_full477 \
  --horizon 5 \
  --min-hist 60 \
  --out-base full477/dataset_base.npz \
  --out-ext full477/dataset_ext.npz

echo "[recovery] train 36-factor baseline"
.venv/bin/python train_lgb.py \
  --data full477/dataset_base.npz \
  --out-model full477/lgb_score.txt \
  --out-meta full477/meta.json

echo "[recovery] evaluate holdout and generate audit summary"
.venv/bin/python - <<'PY' | tee full477/summary.txt
import hashlib
import json
import numpy as np
from sklearn.metrics import roc_auc_score
from train_lgb import cv_auc_and_iters, fit_final

data = np.load("full477/dataset_base.npz", allow_pickle=True)
X = data["X"].astype(np.float32)
y = data["y"].astype(int)
dates = data["dates"].astype(str)
codes = data["codes"].astype(str)
meta = json.load(open("full477/meta.json", encoding="utf-8"))

order = np.argsort(dates, kind="stable")
sorted_dates = dates[order]
cut = max(1, min(int(len(order) * 0.85), len(order) - 1))
cut_date = sorted_dates[cut]
train_idx = order[sorted_dates < cut_date]
holdout_idx = order[sorted_dates >= cut_date]
_, n_est = cv_auc_and_iters(
    X[train_idx], y[train_idx], dates[train_idx],
    n_splits=4, verbose=False,
)
holdout_model = fit_final(X[train_idx], y[train_idx], n_est)
holdout_auc = float(
    roc_auc_score(y[holdout_idx], holdout_model.predict(X[holdout_idx]))
)

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

evaluation = {
    "samples": int(len(y)),
    "features": int(X.shape[1]),
    "stocks": int(len(set(codes))),
    "positive_rate": float(y.mean()),
    "cv_auc": float(meta["cv_auc"]),
    "holdout_auc": holdout_auc,
    "holdout_cut_date": str(cut_date),
    "holdout_samples": int(len(holdout_idx)),
    "model_sha256": sha256("full477/lgb_score.txt"),
    "dataset_sha256": sha256("full477/dataset_base.npz"),
}
json.dump(
    evaluation,
    open("full477/evaluation.json", "w", encoding="utf-8"),
    ensure_ascii=False,
    indent=2,
)
for key, value in evaluation.items():
    print(f"{key}={value}")
print("FULL477_BASELINE_OK")
PY

RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
OSS_OUT="/mnt/data/runs/$RUN_ID"
echo "[recovery] persist artifacts to $OSS_OUT"
if mkdir -p "$OSS_OUT"; then
  cp full477/lgb_score.txt "$OSS_OUT/"
  cp full477/meta.json "$OSS_OUT/"
  cp full477/evaluation.json "$OSS_OUT/"
  cp full477/summary.txt "$OSS_OUT/"
  cp full477/recovery_master.log "$OSS_OUT/"
  cp full477/dataset_base.npz "$OSS_OUT/"
  tar -czf full477/panel_full477.tar.gz panel_full477
  cp full477/panel_full477.tar.gz "$OSS_OUT/"
  echo "$RUN_ID" | tee full477/run_id.txt "$OSS_OUT/run_id.txt"
  echo "[recovery] artifacts persisted"
else
  echo "[recovery] OSS persist failed; local artifacts remain available"
fi

echo "[recovery] complete $(date -Iseconds)"
