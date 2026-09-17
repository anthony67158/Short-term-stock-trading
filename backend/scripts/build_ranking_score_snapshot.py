"""离线排序打分：用封存的 ranking-model-bundle 对最新交易日全市场候选打分，
产出 code->rankScore 排序快照 JSON，供线上 /api/stock_pick 召回排序消费。

模型分真实来自训练好的 LightGBM LambdaRank bundle（时间外费后回测已验证），
特征复用训练同源的 load_ranking_training_data（口径一致，无重造/无未来函数）。

用法:
  uv run python scripts/build_ranking_score_snapshot.py \
      --ranking-root ~/stock-datasets/ranking \
      --model-root ~/stock-datasets/models \
      --output ~/stock-datasets/models/ranking-score-snapshot.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from platform_app.modules.experiments.ranking_model_bundle import RankingModelBundle
from platform_app.modules.experiments.ranking_model_trainer import (
    load_ranking_training_data,
)


def _instrument_to_code(raw: bytes) -> str | None:
    # instrument_id 形如 SH.600000 / SZ.000001 -> 600000
    text = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
    parts = text.split(".")
    if len(parts) != 2:
        return None
    code = parts[1]
    return code if code.isdigit() and len(code) == 6 else None


def build_snapshot(ranking_root: Path, model_root: Path) -> dict:
    bundle = RankingModelBundle(model_root, require_ready=False)
    data, ranking_manifest = load_ranking_training_data(ranking_root)
    if data.x.shape[1] != len(bundle.feature_names):
        raise SystemExit("FEATURE_CONTRACT_MISMATCH")

    latest_date = int(np.max(data.dates))
    mask = data.dates == latest_date
    features = data.x[mask]
    instruments = data.instruments[mask]
    predictions = bundle.predict_matrix(features)
    rank_scores = predictions["rankScore"]
    expected_returns = predictions["expectedGrossReturn"]

    # 组内百分位（跨全市场同日），线上按 0~1 相对分消费。
    order = np.argsort(rank_scores)
    percentile = np.empty_like(rank_scores, dtype=np.float64)
    percentile[order] = np.linspace(0, 1, len(rank_scores)) if len(rank_scores) > 1 else 0.5

    scores = {}
    for index in range(len(instruments)):
        code = _instrument_to_code(instruments[index])
        if not code:
            continue
        scores[code] = {
            "rankScore": round(float(rank_scores[index]), 6),
            "rankPercentile": round(float(percentile[index]), 6),
            "expectedGrossReturn": round(float(expected_returns[index]), 6),
        }

    metrics = (bundle.manifest.get("metrics") or {}).get("backtest") or {}
    return {
        "schemaVersion": "ranking-score-snapshot.v1",
        "bundleId": bundle.manifest.get("bundleId"),
        "modelFamily": bundle.manifest.get("modelFamily"),
        "modelVersion": bundle.manifest.get("bundleId"),
        "rankingDatasetId": ranking_manifest.get("datasetId"),
        "decisionDate": str(latest_date),
        "releaseStatus": bundle.manifest.get("releaseStatus"),
        "backtest": {
            "meanDailyRankIc": metrics.get("meanDailyRankIc"),
            "top10MeanGrossReturn": metrics.get("top10MeanGrossReturn"),
            "top10MeanReturnAt10BpsStress": metrics.get("top10MeanReturnAt10BpsStress"),
            "marketMeanGrossReturn": metrics.get("marketMeanGrossReturn"),
            "top10PositiveRate": metrics.get("top10PositiveRate"),
        },
        "count": len(scores),
        "scores": scores,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ranking-root", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    snapshot = build_snapshot(
        args.ranking_root.expanduser().resolve(),
        args.model_root.expanduser().resolve(),
    )
    payload = json.dumps(snapshot, ensure_ascii=False, indent=2)
    args.output.expanduser().write_text(payload)
    digest = hashlib.sha256(payload.encode()).hexdigest()
    print(json.dumps({
        "output": str(args.output.expanduser().resolve()),
        "decisionDate": snapshot["decisionDate"],
        "count": snapshot["count"],
        "backtest": snapshot["backtest"],
        "sha256": digest,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
