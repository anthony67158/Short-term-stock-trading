"""CPU inference runtime for V2.1 intraday dual-head predictions."""

import hashlib
import math
import os
import re

import numpy as np

from intraday_shadow_runtime import _market_context, _round_price
from intraday_v21_features import V21_FEATURE_NAMES, intraday_v21_features
from train_intraday_tcn import _model_input
from train_intraday_v21 import (
    ARCHITECTURE,
    LABEL_DEFINITIONS,
    _build_dual_head_transformer,
)


CLASS_NAMES = ("STOP_LOSS", "TIMEOUT", "TAKE_PROFIT")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


def _probability_vector(value):
    probabilities = np.asarray(value, dtype=float)
    if probabilities.shape != (3,) or not np.isfinite(probabilities).all():
        raise ValueError("概率向量必须含三个有限数值")
    if np.any(probabilities < 0) or not math.isclose(
        float(probabilities.sum()),
        1.0,
        rel_tol=1e-5,
        abs_tol=1e-5,
    ):
        raise ValueError("概率向量必须非负且和为 1")
    return probabilities


def _head_outlook(values, definition):
    confidence = float(np.max(values))
    ordered = np.sort(values)
    margin = float(ordered[-1] - ordered[-2])
    expected_return = (
        float(values[2]) * float(definition["takeProfitPct"])
        - float(values[0]) * float(definition["stopLossPct"])
    )
    entropy = -sum(
        float(value) * math.log(float(value))
        for value in values
        if value > 0
    ) / math.log(3)
    return {
        "direction": (
            "bullish" if expected_return > 0.08
            else "bearish" if expected_return < -0.08
            else "neutral"
        ),
        "confidencePct": round(confidence * 100, 2),
        "probabilityMarginPct": round(margin * 100, 2),
        "probabilityEdgePct": round(float(values[2] - values[0]) * 100, 2),
        "expectedBarrierReturnPct": round(expected_return, 3),
        "normalizedEntropy": round(entropy, 4),
        "uncertaintyLevel": (
            "low" if entropy <= 0.55
            else "medium" if entropy <= 0.80
            else "high"
        ),
    }


def _format_head(name, probabilities):
    values = _probability_vector(probabilities)
    definition = LABEL_DEFINITIONS[name]
    return {
        "horizon": "未来30分钟" if name == "next30m" else "截至今日收盘",
        "probabilities": {
            "stopLoss": float(values[0]),
            "timeout": float(values[1]),
            "takeProfit": float(values[2]),
        },
        "predictedClass": CLASS_NAMES[int(values.argmax())],
        "outlook": _head_outlook(values, definition),
        "targetDefinition": definition,
    }


def _price_references(panel):
    closes = np.asarray(panel["close"], dtype=float)
    highs = np.asarray(panel["high"], dtype=float)
    lows = np.asarray(panel["low"], dtype=float)
    anchor = float(closes[-1])
    recent = min(20, len(closes))
    return {
        "anchorType": "intradayAsOfClose",
        "anchorPrice": _round_price(anchor),
        "supportPrice": _round_price(float(np.min(lows[-recent:]))),
        "resistancePrice": _round_price(float(np.max(highs[-recent:]))),
        "provisional": True,
        "note": "基于截至信号时点的真实5分钟行情，仅服务当前盘中窗口",
    }


def format_v21_prediction(*, request, probabilities, model_metadata):
    if not isinstance(request, dict) or not isinstance(probabilities, dict):
        raise ValueError("V2.1 推理参数无效")
    heads = {
        name: _format_head(name, probabilities.get(name))
        for name in ("next30m", "sessionClose")
    }
    response = {
        "ok": True,
        "shadowOnly": False,
        "modelVersion": "v2.1-intraday",
        "requestId": request.get("request_id"),
        "code": request["code"],
        "asOf": request["as_of"],
        "session": request["session"],
        "heads": heads,
        "model": {
            "runId": model_metadata["run_id"],
            "architecture": model_metadata["architecture"],
            "sha256": model_metadata["sha256"],
        },
        "note": "V2.1盘中双头概率，必须结合止损与仓位纪律使用",
    }
    panel = request.get("panel")
    if panel:
        response["marketContext"] = _market_context(panel)
        response["priceReferences"] = _price_references(panel)
    return response


class IntradayV21Runtime:
    def __init__(self, *, model_path, run_id, expected_sha256):
        if not isinstance(model_path, str) or not model_path:
            raise ValueError("V2.1 模型路径不能为空")
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("V2.1 run_id 不能为空")
        expected_sha256 = str(expected_sha256 or "").lower()
        if not SHA256_RE.fullmatch(expected_sha256):
            raise ValueError("V2.1 模型 SHA-256 无效")
        self.model_path = model_path
        self.run_id = run_id
        self.expected_sha256 = expected_sha256
        self._model = None
        self._mean = None
        self._std = None
        self._sequence_length = None

    def _verify_hash(self):
        digest = hashlib.sha256()
        with open(self.model_path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != self.expected_sha256:
            raise RuntimeError("V2.1 模型校验值不匹配")

    def _load(self):
        if self._model is not None:
            return
        if not os.path.isfile(self.model_path):
            raise RuntimeError("V2.1 模型文件不存在")
        self._verify_hash()
        import torch

        checkpoint = torch.load(
            self.model_path,
            map_location="cpu",
            weights_only=False,
        )
        feature_names = [
            str(value)
            for value in checkpoint.get("feature_names", [])
        ]
        sequence_length = checkpoint.get("sequence_length")
        mean = np.asarray(
            checkpoint.get("normalizer_mean"),
            dtype=np.float32,
        )
        std = np.asarray(
            checkpoint.get("normalizer_std"),
            dtype=np.float32,
        )
        if (
            checkpoint.get("architecture") != ARCHITECTURE
            or checkpoint.get("model_version") != "v2.1-intraday"
            or checkpoint.get("label_definitions") != LABEL_DEFINITIONS
            or feature_names != list(V21_FEATURE_NAMES)
            or not isinstance(sequence_length, int)
            or sequence_length < 2
            or mean.shape != (len(V21_FEATURE_NAMES),)
            or std.shape != (len(V21_FEATURE_NAMES),)
            or not np.isfinite(mean).all()
            or not np.isfinite(std).all()
            or np.any(std <= 0)
        ):
            raise RuntimeError("V2.1 模型元数据不兼容")
        model = _build_dual_head_transformer(
            len(V21_FEATURE_NAMES),
            sequence_length,
        ).to("cpu")
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        self._model = model
        self._mean = mean
        self._std = std
        self._sequence_length = sequence_length

    def predict(self, request):
        self._load()
        features = intraday_v21_features(request["panel"])
        if len(features) < self._sequence_length:
            raise ValueError("V2.1 分钟序列不足模型窗口")
        sequence = features[-self._sequence_length :]
        normalized = ((sequence - self._mean) / self._std).astype(np.float32)
        import torch

        with torch.no_grad():
            tensor = _model_input(
                normalized[np.newaxis, ...],
                "transformer",
            )
            logits_next, logits_close = self._model(tensor)
            probabilities = {
                "next30m": torch.softmax(logits_next, dim=1).numpy()[0],
                "sessionClose": torch.softmax(
                    logits_close,
                    dim=1,
                ).numpy()[0],
            }
        return format_v21_prediction(
            request=request,
            probabilities=probabilities,
            model_metadata={
                "run_id": self.run_id,
                "architecture": ARCHITECTURE,
                "sha256": self.expected_sha256,
            },
        )
