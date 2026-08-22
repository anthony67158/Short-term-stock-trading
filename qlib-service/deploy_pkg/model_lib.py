"""
模型加载 + GARCH 波动率（供 app.py 使用）。
- LightGBM 打分模型从 OSS 拉取（前缀 quantmodel/），缓存到本地 /tmp，进程内内存缓存。
- OSS 不可用 / 模型缺失时，返回 None，让 app.py 回落到纯 numpy 打分（永不崩）。
- GARCH(1,1) 用最近收益率在线拟合出条件波动率，喂给蒙特卡洛（Plan B）。
依赖：lightgbm、arch、oss2（阿里云 Python SDK）。都缺失时全部优雅降级。
"""
import hashlib
import json
import os
import re
import sys
import time
import types
from urllib.parse import urlparse

import numpy as np


def _dense_scipy_modules():
    """Minimal scipy.sparse surface used only for dense LightGBM inference."""
    scipy_module = types.ModuleType("scipy")
    sparse_module = types.ModuleType("scipy.sparse")

    class SparseMatrix:
        pass

    class CsrMatrix(SparseMatrix):
        pass

    class CscMatrix(SparseMatrix):
        pass

    def unsupported_hstack(*_args, **_kwargs):
        raise RuntimeError(
            "scipy sparse operations are unavailable in dense inference runtime"
        )

    sparse_module.spmatrix = SparseMatrix
    sparse_module.csr_matrix = CsrMatrix
    sparse_module.csc_matrix = CscMatrix
    sparse_module.hstack = unsupported_hstack
    sparse_module.vstack = unsupported_hstack
    scipy_module.sparse = sparse_module
    return scipy_module, sparse_module


def _ensure_lightgbm_dense_imports():
    try:
        import scipy.sparse  # noqa: F401
        return False
    except ImportError:
        scipy_module, sparse_module = _dense_scipy_modules()
        sys.modules.setdefault("scipy", scipy_module)
        sys.modules.setdefault("scipy.sparse", sparse_module)
        return True

_MODEL = None          # lightgbm Booster
_META = None           # dict
_LOAD_TS = 0
_TTL = 3600            # 模型缓存 1 小时后允许热更新
OSS_PREFIX = os.environ.get("QUANT_MODEL_PREFIX", "quantmodel/")
MODEL_KEY = OSS_PREFIX + "lgb_score.txt"
META_KEY = OSS_PREFIX + "meta.json"
MANIFEST_KEY = OSS_PREFIX + "manifest.json"
LOCAL_MODEL = "/tmp/lgb_score.txt"
LOCAL_META = "/tmp/meta.json"
LOCAL_RELEASE_ROOT = "/tmp/quantmodel-releases"
# 随部署包一起打进镜像/代码目录的模型（主加载路径，永远可用，无需 OSS）。
# OSS 仅用于「热更新」：训练出新模型后 upload_model.py 推到 OSS，进程 TTL 到期后自动拉取覆盖。
_HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLED_MODEL = os.path.join(_HERE, "lgb_score.txt")
BUNDLED_META = os.path.join(_HERE, "meta.json")
_ACTIVE_MODEL_PATHS = None

# ---------- 高把握买点「信号头」（可信度>=85% 的选择性出价）----------
# 与主打分模型同 36 维特征、同源。独立的 LightGBM 概率模型 + isotonic 校准 + gate 闸门。
# 推理：raw=predict(x); prob=np.interp(raw,cal_x,cal_y); 若 prob>=gate => 高把握买点。
_SIGNAL = None         # lightgbm Booster（信号头）
_SIGNAL_META = None    # dict: gate, cal_x, cal_y, target_pct, horizon, holdout_precision...
_SIGNAL_TS = 0
SIGNAL_MODEL_KEY = OSS_PREFIX + "lgb_signal.txt"
SIGNAL_META_KEY = OSS_PREFIX + "signal_meta.json"
LOCAL_SIGNAL = "/tmp/lgb_signal.txt"
LOCAL_SIGNAL_META = "/tmp/signal_meta.json"
BUNDLED_SIGNAL = os.path.join(_HERE, "lgb_signal.txt")
BUNDLED_SIGNAL_META = os.path.join(_HERE, "signal_meta.json")
_ACTIVE_SIGNAL_PATHS = None

# ---------- 「事件确认高把握」层(P2 结论:正交高精度筛子,离线每日刷新)----------
# 由 build_event_tags.py 每日产出 event_tags.json 上传 OSS。此处像模型一样热加载(TTL),
# /predict 按 code 查表回传 eventTag —— 线上 36 维打分向量【完全不变】,零线上风险。
# 拿不到(OSS无/未配置/首日)时返回空表,eventTag=None,主流程不受任何影响。
_EVENT_TAGS = None     # dict: {"tradeDate":..., "tags":{code6:{...}}, ...}
_EVENT_TS = 0
_EVENT_TTL = 1800      # 事件标记 30 分钟热更新一次(比模型更勤,盘后当天即可生效)
EVENT_TAGS_KEY = OSS_PREFIX + "event_tags.json"
LOCAL_EVENT_TAGS = "/tmp/event_tags.json"
BUNDLED_EVENT_TAGS = os.path.join(_HERE, "event_tags.json")
_ACTIVE_EVENT_TAGS_PATH = None


def _resolve_oss_endpoint():
    endpoint = os.environ.get("OSS_ENDPOINT", "").strip()
    allow_public = os.environ.get(
        "OSS_ALLOW_PUBLIC_NETWORK", ""
    ).strip().lower() == "true"
    if not endpoint:
        region = os.environ.get("OSS_REGION", "oss-cn-hangzhou").strip()
        if not region.startswith("oss-"):
            region = "oss-" + region
        return f"https://{region}-internal.aliyuncs.com"
    host = (urlparse(endpoint).hostname or endpoint).strip("/").lower()
    if host.endswith("-internal.aliyuncs.com") or allow_public:
        return endpoint
    raise RuntimeError("OSS public network is disabled for quant service")


def _oss_bucket():
    try:
        import oss2
    except Exception:
        return None
    ak = os.environ.get("OSS_ACCESS_KEY_ID")
    sk = os.environ.get("OSS_ACCESS_KEY_SECRET")
    bkt = os.environ.get("OSS_BUCKET")
    if not (ak and sk and bkt):
        return None
    endpoint = _resolve_oss_endpoint()
    try:
        auth = oss2.Auth(ak, sk)
        # enable_crc=False：部分环境 crc32c 计算异常会误报 InconsistentError；
        # 我们在 _download_model 里用 lightgbm 加载做完整性校验，等价更强。
        return oss2.Bucket(auth, endpoint, bkt, enable_crc=False)
    except Exception:
        return None


def validate_release_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("unsupported model release manifest")
    run_id = str(manifest.get("run_id") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("invalid model release run_id")
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise ValueError("model release files missing")
    expected_prefix = f"{OSS_PREFIX.rstrip('/')}/runs/{run_id}/"
    for slot in ("model", "meta"):
        item = files.get(slot)
        if not isinstance(item, dict):
            raise ValueError(f"model release {slot} missing")
        key = str(item.get("key") or "")
        checksum = str(item.get("sha256") or "")
        if not key.startswith(expected_prefix):
            raise ValueError(f"model release {slot} key invalid")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError(f"model release {slot} checksum invalid")
    for slot in ("signal_model", "signal_meta", "event_tags"):
        item = files.get(slot)
        if item is None:
            continue
        if not isinstance(item, dict):
            raise ValueError(f"model release {slot} invalid")
        key = str(item.get("key") or "")
        checksum = str(item.get("sha256") or "")
        if not key.startswith(expected_prefix):
            raise ValueError(f"model release {slot} key invalid")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError(f"model release {slot} checksum invalid")
    return manifest


def _file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remote_release_manifest(bucket):
    try:
        raw = bucket.get_object(MANIFEST_KEY).read()
    except Exception as error:
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise
    return validate_release_manifest(json.loads(raw.decode("utf-8")))


def _download_model():
    """OSS → 本地 /tmp。带重试 + 下载后校验模型可加载，避免坏文件拖崩服务。
    成功返回 True。"""
    b = _oss_bucket()
    if not b:
        return False
    import lightgbm as lgb
    tmp_model = LOCAL_MODEL + ".part"
    tmp_meta = LOCAL_META + ".part"

    def _fetch(key, dst):
        # 用 get_object().read() 整体读取后写盘，避免个别环境 get_object_to_file 截断
        data = b.get_object(key).read()
        with open(dst, "wb") as fh:
            fh.write(data)
        return len(data)

    for attempt in range(3):
        try:
            manifest = _remote_release_manifest(b)
            if manifest:
                run_id = manifest["run_id"]
                release_dir = os.path.join(LOCAL_RELEASE_ROOT, run_id)
                os.makedirs(release_dir, exist_ok=True)
                release_model = os.path.join(release_dir, "lgb_score.txt")
                release_meta = os.path.join(release_dir, "meta.json")
                tmp_release_model = release_model + ".part"
                tmp_release_meta = release_meta + ".part"
                model_entry = manifest["files"]["model"]
                meta_entry = manifest["files"]["meta"]
                _fetch(model_entry["key"], tmp_release_model)
                _fetch(meta_entry["key"], tmp_release_meta)
                if _file_sha256(tmp_release_model) != model_entry["sha256"]:
                    raise ValueError("model release checksum mismatch")
                if _file_sha256(tmp_release_meta) != meta_entry["sha256"]:
                    raise ValueError("model metadata checksum mismatch")
                lgb.Booster(model_file=tmp_release_model)
                with open(tmp_release_meta, encoding="utf-8") as handle:
                    json.load(handle)
                os.replace(tmp_release_model, release_model)
                os.replace(tmp_release_meta, release_meta)
                return release_model, release_meta

            _fetch(MODEL_KEY, tmp_model)
            # 校验：能被 lightgbm 正常加载才算有效
            lgb.Booster(model_file=tmp_model)
            os.replace(tmp_model, LOCAL_MODEL)
            try:
                _fetch(META_KEY, tmp_meta)
                json.load(open(tmp_meta))
                os.replace(tmp_meta, LOCAL_META)
            except Exception:
                pass
            return LOCAL_MODEL, LOCAL_META
        except Exception:
            for p in (
                tmp_model,
                tmp_meta,
                locals().get("tmp_release_model"),
                locals().get("tmp_release_meta"),
            ):
                if not p:
                    continue
                try:
                    os.remove(p)
                except OSError:
                    pass
            time.sleep(1.5 * (attempt + 1))
    return False


def get_model():
    """返回 (booster, meta) 或 (None, None)。带进程内缓存 + TTL 热更新。
    加载优先级：
      1) OSS 上的最新模型（热更新，训练出新模型 upload 后自动生效）；
      2) 随部署包打进代码目录的 bundled 模型（主兜底，永远存在，离线可用）。
    两者都失败才返回 (None, None)，由 app.py 回落到规则打分。"""
    global _MODEL, _META, _LOAD_TS, _ACTIVE_MODEL_PATHS
    now = time.time()
    if _MODEL is not None and (now - _LOAD_TS) < _TTL:
        return _MODEL, _META
    _ensure_lightgbm_dense_imports()
    try:
        import lightgbm as lgb
    except Exception:
        return None, None
    # 1) 尝试 OSS 热更新（失败不影响后续 bundled 兜底）
    downloaded = None
    try:
        downloaded = _download_model()
    except Exception:
        pass
    # 选定要加载的文件：优先 OSS 拉下来的，其次 bundled
    model_path, meta_path = None, None
    if isinstance(downloaded, tuple):
        model_path, meta_path = downloaded
    elif (
        _ACTIVE_MODEL_PATHS
        and os.path.exists(_ACTIVE_MODEL_PATHS[0])
    ):
        model_path, meta_path = _ACTIVE_MODEL_PATHS
    elif os.path.exists(LOCAL_MODEL):
        model_path, meta_path = LOCAL_MODEL, LOCAL_META
    elif os.path.exists(BUNDLED_MODEL):
        model_path, meta_path = BUNDLED_MODEL, BUNDLED_META
    if not model_path:
        return None, None
    try:
        _MODEL = lgb.Booster(model_file=model_path)
        if meta_path and os.path.exists(meta_path):
            _META = json.load(open(meta_path))
        else:
            _META = {"feat_names": None}
        _ACTIVE_MODEL_PATHS = (model_path, meta_path)
        _LOAD_TS = now
        return _MODEL, _META
    except Exception:
        # OSS 文件损坏时，再退一步用 bundled 兜底
        if model_path != BUNDLED_MODEL and os.path.exists(BUNDLED_MODEL):
            try:
                _MODEL = lgb.Booster(model_file=BUNDLED_MODEL)
                _META = json.load(open(BUNDLED_META)) if os.path.exists(BUNDLED_META) else {"feat_names": None}
                _LOAD_TS = now
                return _MODEL, _META
            except Exception:
                return None, None
        return None, None


def model_score(feat_vec, feat_names):
    """用 LGB 输出达标概率(0..1) → 映射到 0..100 分。缺模型返回 None。"""
    booster, meta = get_model()
    if booster is None:
        return None
    # 若 meta 指定了特征顺序，按其对齐（当前训练/推理同源，顺序一致）
    x = np.asarray([feat_vec], dtype=np.float32)
    try:
        p = float(booster.predict(x)[0])
    except Exception:
        return None
    return float(np.clip(p * 100.0, 0, 100)), p


def _download_signal():
    """OSS → 本地 /tmp 拉取信号头模型 + 元数据。带下载后可加载校验。成功返回 True。"""
    b = _oss_bucket()
    if not b:
        return False
    import lightgbm as lgb
    tmp_model = LOCAL_SIGNAL + ".part"
    tmp_meta = LOCAL_SIGNAL_META + ".part"
    try:
        manifest = _remote_release_manifest(b)
        if (
            manifest
            and manifest["files"].get("signal_model")
            and manifest["files"].get("signal_meta")
        ):
            run_id = manifest["run_id"]
            release_dir = os.path.join(LOCAL_RELEASE_ROOT, run_id)
            os.makedirs(release_dir, exist_ok=True)
            release_model = os.path.join(release_dir, "lgb_signal.txt")
            release_meta = os.path.join(release_dir, "signal_meta.json")
            tmp_release_model = release_model + ".part"
            tmp_release_meta = release_meta + ".part"
            model_entry = manifest["files"]["signal_model"]
            meta_entry = manifest["files"]["signal_meta"]
            model_data = b.get_object(model_entry["key"]).read()
            meta_data = b.get_object(meta_entry["key"]).read()
            with open(tmp_release_model, "wb") as handle:
                handle.write(model_data)
            with open(tmp_release_meta, "wb") as handle:
                handle.write(meta_data)
            if _file_sha256(tmp_release_model) != model_entry["sha256"]:
                raise ValueError("signal release checksum mismatch")
            if _file_sha256(tmp_release_meta) != meta_entry["sha256"]:
                raise ValueError("signal metadata checksum mismatch")
            lgb.Booster(model_file=tmp_release_model)
            with open(tmp_release_meta, encoding="utf-8") as handle:
                json.load(handle)
            os.replace(tmp_release_model, release_model)
            os.replace(tmp_release_meta, release_meta)
            return release_model, release_meta

        data = b.get_object(SIGNAL_MODEL_KEY).read()
        with open(tmp_model, "wb") as fh:
            fh.write(data)
        lgb.Booster(model_file=tmp_model)          # 完整性校验
        os.replace(tmp_model, LOCAL_SIGNAL)
        try:
            data = b.get_object(SIGNAL_META_KEY).read()
            with open(tmp_meta, "wb") as fh:
                fh.write(data)
            json.load(open(tmp_meta))
            os.replace(tmp_meta, LOCAL_SIGNAL_META)
        except Exception:
            pass
        return LOCAL_SIGNAL, LOCAL_SIGNAL_META
    except Exception:
        for p in (
            tmp_model,
            tmp_meta,
            locals().get("tmp_release_model"),
            locals().get("tmp_release_meta"),
        ):
            if not p:
                continue
            try:
                os.remove(p)
            except OSError:
                pass
        return False


def get_signal_model():
    """返回 (booster, meta) 或 (None, None)。加载优先级：OSS 热更新 > bundled 兜底。
    meta 含 gate / cal_x / cal_y / target_pct / horizon 等，供校准推理与目标价计算。"""
    global _SIGNAL, _SIGNAL_META, _SIGNAL_TS, _ACTIVE_SIGNAL_PATHS
    now = time.time()
    if _SIGNAL is not None and (now - _SIGNAL_TS) < _TTL:
        return _SIGNAL, _SIGNAL_META
    _ensure_lightgbm_dense_imports()
    try:
        import lightgbm as lgb
    except Exception:
        return None, None
    downloaded = None
    try:
        downloaded = _download_signal()
    except Exception:
        pass
    model_path, meta_path = None, None
    if isinstance(downloaded, tuple):
        model_path, meta_path = downloaded
    elif (
        _ACTIVE_SIGNAL_PATHS
        and os.path.exists(_ACTIVE_SIGNAL_PATHS[0])
    ):
        model_path, meta_path = _ACTIVE_SIGNAL_PATHS
    elif os.path.exists(LOCAL_SIGNAL):
        model_path, meta_path = LOCAL_SIGNAL, LOCAL_SIGNAL_META
    elif os.path.exists(BUNDLED_SIGNAL):
        model_path, meta_path = BUNDLED_SIGNAL, BUNDLED_SIGNAL_META
    if not model_path:
        return None, None
    try:
        _SIGNAL = lgb.Booster(model_file=model_path)
        if meta_path and os.path.exists(meta_path):
            _SIGNAL_META = json.load(open(meta_path))
        else:
            _SIGNAL_META = None
        _ACTIVE_SIGNAL_PATHS = (model_path, meta_path)
        _SIGNAL_TS = now
        return _SIGNAL, _SIGNAL_META
    except Exception:
        if model_path != BUNDLED_SIGNAL and os.path.exists(BUNDLED_SIGNAL):
            try:
                _SIGNAL = lgb.Booster(model_file=BUNDLED_SIGNAL)
                _SIGNAL_META = (json.load(open(BUNDLED_SIGNAL_META))
                                if os.path.exists(BUNDLED_SIGNAL_META) else None)
                _SIGNAL_TS = now
                return _SIGNAL, _SIGNAL_META
            except Exception:
                return None, None
        return None, None


def signal_prob(feat_vec):
    """高把握买点校准概率。返回 (prob, meta) 或 (None, None)。
    prob = isotonic(raw)，与训练/holdout 同源；调用方用 prob>=meta['gate'] 判定是否给高把握买点。"""
    booster, meta = get_signal_model()
    if booster is None or not meta:
        return None, None
    x = np.asarray([feat_vec], dtype=np.float32)
    try:
        raw = float(booster.predict(x)[0])
    except Exception:
        return None, None
    cal_x = meta.get("cal_x")
    cal_y = meta.get("cal_y")
    if cal_x and cal_y:
        prob = float(np.interp(raw, np.asarray(cal_x, float), np.asarray(cal_y, float)))
    else:
        prob = raw
    return float(np.clip(prob, 0.0, 1.0)), meta


def _download_event_tags():
    """OSS → 本地 /tmp 拉取 event_tags.json。成功返回 True;失败返回 False(不影响主流程)。"""
    b = _oss_bucket()
    if not b:
        return False
    tmp = LOCAL_EVENT_TAGS + ".part"
    try:
        manifest = _remote_release_manifest(b)
        if manifest and manifest["files"].get("event_tags"):
            run_id = manifest["run_id"]
            release_dir = os.path.join(LOCAL_RELEASE_ROOT, run_id)
            os.makedirs(release_dir, exist_ok=True)
            release_path = os.path.join(release_dir, "event_tags.json")
            tmp_release = release_path + ".part"
            entry = manifest["files"]["event_tags"]
            data = b.get_object(entry["key"]).read()
            with open(tmp_release, "wb") as handle:
                handle.write(data)
            if _file_sha256(tmp_release) != entry["sha256"]:
                raise ValueError("event tags release checksum mismatch")
            with open(tmp_release, encoding="utf-8") as handle:
                json.load(handle)
            os.replace(tmp_release, release_path)
            return release_path

        data = b.get_object(EVENT_TAGS_KEY).read()
        with open(tmp, "wb") as fh:
            fh.write(data)
        json.load(open(tmp))                 # 完整性校验:能被 json 解析才算有效
        os.replace(tmp, LOCAL_EVENT_TAGS)
        return LOCAL_EVENT_TAGS
    except Exception:
        for path in (tmp, locals().get("tmp_release")):
            if not path:
                continue
            try:
                os.remove(path)
            except OSError:
                pass
        return False


def get_event_tags():
    """返回 {"tradeDate":..., "tags":{code6:{...}}, ...} 或 {}(拿不到时的空表)。
    带进程内缓存 + TTL 热更新。加载优先级:OSS 热更新 > bundled(随包) > 空表。"""
    global _EVENT_TAGS, _EVENT_TS, _ACTIVE_EVENT_TAGS_PATH
    now = time.time()
    if _EVENT_TAGS is not None and (now - _EVENT_TS) < _EVENT_TTL:
        return _EVENT_TAGS
    # 每个 TTL 周期尝试拉一次 OSS 最新(盘后当天即生效)
    downloaded = None
    try:
        downloaded = _download_event_tags()
    except Exception:
        pass
    path = None
    if isinstance(downloaded, str):
        path = downloaded
    elif (
        _ACTIVE_EVENT_TAGS_PATH
        and os.path.exists(_ACTIVE_EVENT_TAGS_PATH)
    ):
        path = _ACTIVE_EVENT_TAGS_PATH
    elif os.path.exists(LOCAL_EVENT_TAGS):
        path = LOCAL_EVENT_TAGS
    elif os.path.exists(BUNDLED_EVENT_TAGS):
        path = BUNDLED_EVENT_TAGS
    tags = {}
    if path:
        try:
            tags = json.load(open(path)) or {}
            _ACTIVE_EVENT_TAGS_PATH = path
        except Exception:
            tags = {}
    _EVENT_TAGS = tags
    _EVENT_TS = now
    return _EVENT_TAGS


def event_tag_for(code):
    """按 6 位纯代码查"事件确认高把握"标记。命中返回 tag dict(含 tradeDate/精度参考),否则 None。
    支持传入 '600519' 或 '600519.SH';online 36 维打分向量与本函数完全解耦。"""
    if not code:
        return None
    doc = get_event_tags()
    tags = (doc or {}).get("tags") or {}
    c6 = str(code).split(".")[0]
    t = tags.get(c6)
    if not t:
        return None
    out = dict(t)
    out["tradeDate"] = t.get("tradeDate") or doc.get("tradeDate")
    return out


def garch_sigma(rets_pct, fallback):
    """用最近日收益率(%)拟合 GARCH(1,1)，返回下一日条件波动率(小数，如0.02)。
    失败/样本不足时返回 fallback。"""
    r = np.asarray(rets_pct, float)
    r = r[np.isfinite(r)]
    if len(r) < 60:
        return fallback
    try:
        from arch import arch_model
        am = arch_model(r[-250:], vol="GARCH", p=1, q=1, mean="Constant", dist="normal")
        res = am.fit(disp="off", show_warning=False)
        fc = res.forecast(horizon=1, reindex=False)
        var = float(fc.variance.values[-1, 0])   # 单位: (%)^2
        sig = (var ** 0.5) / 100.0                # → 小数
        if not np.isfinite(sig) or sig <= 0:
            return fallback
        # 合理区间保护，防止极端拟合
        return float(np.clip(sig, 0.003, 0.15))
    except Exception:
        return fallback
