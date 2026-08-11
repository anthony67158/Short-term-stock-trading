"""CPU inference runtime for the isolated intraday shadow service."""

import hashlib
import math
import os
import re

import numpy as np

from build_intraday_dataset import FEATURE_NAMES, minute_features
from train_intraday_tcn import _build_model, _model_input


CLASS_NAMES = ("STOP_LOSS", "TIMEOUT", "TAKE_PROFIT")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
TAKE_PROFIT_PCT = 1.0
STOP_LOSS_PCT = 0.6


def _probability_vector(probabilities):
    values = np.asarray(probabilities, dtype=float)
    if values.shape != (3,) or not np.isfinite(values).all():
        raise ValueError("概率向量必须含三个有限数值")
    if np.any(values < 0) or not math.isclose(
        float(values.sum()),
        1.0,
        rel_tol=1e-5,
        abs_tol=1e-5,
    ):
        raise ValueError("概率向量必须为非负且和为 1")
    return values


def _prediction_outlook(values):
    ordered = np.sort(values)
    confidence = float(ordered[-1])
    margin = float(ordered[-1] - ordered[-2])
    entropy = -sum(
        float(value) * math.log(float(value))
        for value in values
        if value > 0
    ) / math.log(len(values))
    expected_return = (
        float(values[2]) * TAKE_PROFIT_PCT
        - float(values[0]) * STOP_LOSS_PCT
    )
    edge = float(values[2] - values[0])
    adverse = float(values[0])
    odds = float(values[2] / adverse) if adverse > 1e-8 else None
    direction = (
        "bullish"
        if expected_return > 0.15
        else "bearish"
        if expected_return < -0.15
        else "neutral"
    )
    risk_level = (
        "high"
        if values[0] >= 0.45
        else "medium"
        if values[0] >= 0.20
        else "low"
    )
    signal_strength = (
        "strong"
        if confidence >= 0.60 and margin >= 0.25
        else "medium"
        if confidence >= 0.45 and margin >= 0.10
        else "weak"
    )
    return {
        "direction": direction,
        "confidencePct": round(confidence * 100, 2),
        "probabilityMarginPct": round(margin * 100, 2),
        "probabilityEdgePct": round(edge * 100, 2),
        "favorableToAdverseOdds": (
            round(odds, 3) if odds is not None else None
        ),
        "normalizedEntropy": round(entropy, 4),
        "uncertaintyLevel": (
            "low" if entropy <= 0.55
            else "medium" if entropy <= 0.80
            else "high"
        ),
        "convictionScore": round(
            max(0.0, min(1.0, confidence * (1.0 - entropy) + margin))
            * 100
        ),
        "expectedBarrierReturnPct": round(expected_return, 3),
        "directionScore": round(
            (float(values[2]) - float(values[0]) + 1.0) * 50
        ),
        "riskLevel": risk_level,
        "signalStrength": signal_strength,
    }


def _round_price(value):
    if not math.isfinite(float(value)):
        return None
    return round(float(value), 3 if float(value) < 10 else 2)


def _market_context(panel):
    closes = np.asarray(panel["close"], dtype=float)
    opens = np.asarray(panel["open"], dtype=float)
    highs = np.asarray(panel["high"], dtype=float)
    lows = np.asarray(panel["low"], dtype=float)
    volumes = np.asarray(panel["vol"], dtype=float)
    times = np.asarray(panel["trade_time"]).astype(str)
    signal_date = times[-1][:10]
    session_indices = np.flatnonzero(
        np.asarray([value[:10] == signal_date for value in times])
    )
    session_start = int(session_indices[0]) if len(session_indices) else 0
    session_close = closes[session_start:]
    session_open = opens[session_start:]
    session_high = highs[session_start:]
    session_low = lows[session_start:]
    session_vol = volumes[session_start:]
    returns = np.diff(np.log(session_close))
    range_pct = (session_high - session_low) / session_close * 100
    recent = min(20, len(session_close))
    support = float(np.min(session_low[-recent:]))
    resistance = float(np.max(session_high[-recent:]))
    day_low = float(np.min(session_low))
    day_high = float(np.max(session_high))
    last_close = float(session_close[-1])
    first_open = float(session_open[0])
    span = day_high - day_low
    vol_baseline = float(np.mean(session_vol[-20:-1])) if len(
        session_vol
    ) > 1 else float(session_vol[-1])
    volume_ratio = (
        float(session_vol[-1] / vol_baseline)
        if vol_baseline > 0 else 1.0
    )
    momentum_reference = session_close[-7] if len(session_close) >= 7 else first_open
    ma5 = float(np.mean(session_close[-5:]))
    ma20 = float(np.mean(session_close[-20:]))
    trend_alignment = (
        "bullish" if last_close >= ma5 >= ma20
        else "bearish" if last_close <= ma5 <= ma20
        else "mixed"
    )
    return {
        "barsCount": int(len(closes)),
        "sessionBars": int(len(session_close)),
        "sessionReturnPct": round(
            (last_close / first_open - 1.0) * 100,
            3,
        ),
        "momentum30mPct": round(
            (last_close / float(momentum_reference) - 1.0) * 100,
            3,
        ),
        "realizedVolPct": round(
            float(np.std(returns) * math.sqrt(max(1, len(returns))) * 100),
            3,
        ),
        "averageRangePct": round(float(np.mean(range_pct)), 3),
        "volumeRatio20": round(volume_ratio, 3),
        "closeLocationPct": round(
            (last_close - day_low) / span * 100 if span > 0 else 50.0,
            2,
        ),
        "drawdownFromHighPct": round(
            (last_close / day_high - 1.0) * 100,
            3,
        ),
        "reboundFromLowPct": round(
            (last_close / day_low - 1.0) * 100,
            3,
        ),
        "supportPrice": _round_price(support),
        "resistancePrice": _round_price(resistance),
        "trendAlignment": trend_alignment,
    }


def _price_references(panel, market_context):
    anchor = float(np.asarray(panel["close"], dtype=float)[-1])
    support = market_context["supportPrice"]
    resistance = market_context["resistancePrice"]
    return {
        "anchorType": "signalClose",
        "anchorPrice": _round_price(anchor),
        "supportPrice": support,
        "resistancePrice": resistance,
        "referenceBuyZoneLow": _round_price(min(float(support), anchor)),
        "referenceBuyZoneHigh": _round_price(max(float(support), anchor)),
        "indicativeTakeProfitPrice": _round_price(
            anchor * (1.0 + TAKE_PROFIT_PCT / 100.0)
        ),
        "indicativeStopLossPrice": _round_price(
            anchor * (1.0 - STOP_LOSS_PCT / 100.0)
        ),
        "provisional": True,
        "note": (
            "基于信号日收盘与5分钟支撑压力的参考锚点，"
            "实际入场须按下一交易日首根5分钟开盘修正"
        ),
    }


def format_shadow_prediction(*, request, probabilities, model_metadata):
    """Return a deliberately non-actionable response for shadow recording."""
    values = _probability_vector(probabilities)
    if not isinstance(request, dict) or not isinstance(model_metadata, dict):
        raise ValueError("影子预测参数无效")
    panel = request.get("panel")
    market_context = _market_context(panel) if panel else None
    predicted_index = int(values.argmax())
    response = {
        "ok": True,
        "shadowOnly": True,
        "requestId": request.get("request_id"),
        "code": request["code"],
        "asOf": request["as_of"],
        "model": {
            "runId": model_metadata["run_id"],
            "architecture": model_metadata["architecture"],
            "sha256": model_metadata["sha256"],
        },
        "probabilities": {
            "stopLoss": float(values[0]),
            "timeout": float(values[1]),
            "takeProfit": float(values[2]),
        },
        "outlook": _prediction_outlook(values),
        "targetDefinition": {
            "entry": "nextTradingDayFirst5mOpen",
            "horizon": "nextTradingDay",
            "takeProfitPct": TAKE_PROFIT_PCT,
            "stopLossPct": STOP_LOSS_PCT,
            "sameBarPolicy": "stopLossFirst",
        },
        "predictedClass": CLASS_NAMES[predicted_index],
        "note": "实验影子预测，不构成交易动作或生产建议",
    }
    if market_context:
        response["marketContext"] = market_context
        response["priceReferences"] = _price_references(
            panel,
            market_context,
        )
    return response


class IntradayShadowRuntime:
    """Load a hash-pinned PyTorch candidate and serve CPU predictions."""

    def __init__(self, *, model_path, run_id, expected_sha256):
        if not isinstance(model_path, str) or not model_path:
            raise ValueError("模型路径不能为空")
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("run_id 不能为空")
        expected_sha256 = str(expected_sha256 or "").lower()
        if not SHA256_RE.fullmatch(expected_sha256):
            raise ValueError("模型 SHA-256 无效")
        self.model_path = model_path
        self.run_id = run_id
        self.expected_sha256 = expected_sha256
        self._model = None
        self._architecture = None
        self._feature_names = None
        self._mean = None
        self._std = None
        self._sequence_length = None

    def _verify_hash(self):
        digest = hashlib.sha256()
        with open(self.model_path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != self.expected_sha256:
            raise RuntimeError("候选模型校验值不匹配")

    def _load(self):
        if self._model is not None:
            return
        if not os.path.isfile(self.model_path):
            raise RuntimeError("候选模型文件不存在")
        self._verify_hash()
        import torch

        checkpoint = torch.load(
            self.model_path,
            map_location="cpu",
            weights_only=False,
        )
        if not isinstance(checkpoint, dict):
            raise RuntimeError("候选模型检查点格式无效")
        architecture = checkpoint.get("architecture")
        feature_names = [str(value) for value in checkpoint.get("feature_names", [])]
        sequence_length = checkpoint.get("sequence_length")
        mean = np.asarray(checkpoint.get("normalizer_mean"), dtype=np.float32)
        std = np.asarray(checkpoint.get("normalizer_std"), dtype=np.float32)
        if (
            architecture not in ("tcn", "gru", "transformer")
            or feature_names != list(FEATURE_NAMES)
            or not isinstance(sequence_length, int)
            or sequence_length < 2
            or mean.shape != (len(FEATURE_NAMES),)
            or std.shape != (len(FEATURE_NAMES),)
            or not np.isfinite(mean).all()
            or not np.isfinite(std).all()
            or np.any(std <= 0)
        ):
            raise RuntimeError("候选模型元数据不兼容")
        model = _build_model(
            architecture,
            len(FEATURE_NAMES),
            sequence_length,
        ).to("cpu")
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        self._model = model
        self._architecture = architecture
        self._feature_names = feature_names
        self._mean = mean
        self._std = std
        self._sequence_length = sequence_length

    def predict(self, request):
        self._load()
        features = minute_features(request["panel"])
        if len(features) < self._sequence_length:
            raise ValueError("分钟序列不足模型窗口")
        sequence = features[-self._sequence_length :]
        normalized = ((sequence - self._mean) / self._std).astype(np.float32)
        import torch

        with torch.no_grad():
            tensor = _model_input(
                normalized[np.newaxis, ...],
                self._architecture,
            )
            probabilities = torch.softmax(self._model(tensor), dim=1).numpy()[0]
        return format_shadow_prediction(
            request=request,
            probabilities=probabilities,
            model_metadata={
                "run_id": self.run_id,
                "architecture": self._architecture,
                "sha256": self.expected_sha256,
            },
        )
