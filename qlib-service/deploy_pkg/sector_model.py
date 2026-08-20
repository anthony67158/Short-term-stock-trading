"""Independent dual-head sector LightGBM loader with OSS hot refresh."""
import json
import os
import re
import time

import numpy as np

from sector_contract import FEATURE_NAMES
from model_lib import _oss_bucket


SECTOR_PREFIX = os.environ.get("SECTOR_MODEL_PREFIX", "sectormodel/")
NEXT_KEY = SECTOR_PREFIX + "next_lgb.txt"
WEEK_KEY = SECTOR_PREFIX + "week_lgb.txt"
META_KEY = SECTOR_PREFIX + "meta.json"
LOCAL_NEXT = "/tmp/sector_next_lgb.txt"
LOCAL_WEEK = "/tmp/sector_week_lgb.txt"
LOCAL_META = "/tmp/sector_meta.json"
HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLED_NEXT = os.path.join(HERE, "sector_next_lgb.txt")
BUNDLED_WEEK = os.path.join(HERE, "sector_week_lgb.txt")
BUNDLED_META = os.path.join(HERE, "sector_meta.json")
MODEL_TTL_SECONDS = 3600

_MODELS = None
_META = None
_LOADED_AT = 0.0


def feature_vector(factors, feature_names=None):
    names = feature_names or FEATURE_NAMES
    vector = []
    for name in names:
        try:
            value = float((factors or {}).get(name, 0.0))
        except (TypeError, ValueError):
            value = 0.0
        vector.append(value if np.isfinite(value) else 0.0)
    return vector


def _download_models():
    bucket = _oss_bucket()
    if bucket is None:
        return False
    targets = [
        (NEXT_KEY, LOCAL_NEXT),
        (WEEK_KEY, LOCAL_WEEK),
        (META_KEY, LOCAL_META),
    ]
    temporary = []
    try:
        for key, path in targets:
            temp = path + ".part"
            temporary.append(temp)
            with open(temp, "wb") as handle:
                handle.write(bucket.get_object(key).read())
        import lightgbm as lgb
        lgb.Booster(model_file=LOCAL_NEXT + ".part")
        lgb.Booster(model_file=LOCAL_WEEK + ".part")
        with open(LOCAL_META + ".part", encoding="utf-8") as handle:
            json.load(handle)
        for _, path in targets:
            os.replace(path + ".part", path)
        return True
    except Exception:
        for path in temporary:
            try:
                os.remove(path)
            except OSError:
                pass
        return False


def get_sector_models(force=False):
    global _MODELS, _META, _LOADED_AT
    now = time.time()
    if (
        not force
        and _MODELS is not None
        and now - _LOADED_AT < MODEL_TTL_SECONDS
    ):
        return _MODELS, _META
    try:
        import lightgbm as lgb
    except Exception:
        return (None, None), None
    _download_models()
    candidates = [
        (LOCAL_NEXT, LOCAL_WEEK, LOCAL_META),
        (BUNDLED_NEXT, BUNDLED_WEEK, BUNDLED_META),
    ]
    for next_path, week_path, meta_path in candidates:
        if not (os.path.exists(next_path) and os.path.exists(week_path)):
            continue
        try:
            models = (
                lgb.Booster(model_file=next_path),
                lgb.Booster(model_file=week_path),
            )
            meta = {}
            if os.path.exists(meta_path):
                with open(meta_path, encoding="utf-8") as handle:
                    meta = json.load(handle)
            _MODELS = models
            _META = meta
            _LOADED_AT = now
            return _MODELS, _META
        except Exception:
            continue
    return (None, None), None


def predict_sector_items(items, models=None, meta=None):
    if not isinstance(items, list) or not items:
        return []
    if models is None:
        models, loaded_meta = get_sector_models()
        meta = meta or loaded_meta
    if not models or models[0] is None or models[1] is None:
        raise RuntimeError("sector model unavailable")
    feature_names = (meta or {}).get("feat_names") or FEATURE_NAMES
    rows = []
    codes = []
    for item in items[:80]:
        code = str((item or {}).get("code") or "")
        if not re.fullmatch(r"BK\d{4}", code):
            raise ValueError("invalid sector code")
        factors = (item or {}).get("factors")
        if not isinstance(factors, dict):
            raise ValueError("invalid sector factors")
        codes.append(code)
        rows.append(feature_vector(factors, feature_names))
    matrix = np.asarray(rows, dtype=np.float32)
    next_values = np.clip(models[0].predict(matrix), 0.0, 1.0)
    week_values = np.clip(models[1].predict(matrix), 0.0, 1.0)
    drawdown = (meta or {}).get("week_drawdown_estimate")
    version = str((meta or {}).get("modelVersion") or "")
    return [{
        "code": code,
        "nextProbability": round(float(next_values[index]), 6),
        "weekProbability": round(float(week_values[index]), 6),
        "drawdownEstimate": (
            round(float(drawdown), 2)
            if drawdown is not None
            else None
        ),
        "modelVersion": version,
    } for index, code in enumerate(codes)]
