"""Isolated CPU API for non-actionable intraday shadow predictions."""

import hmac
import os
import threading

from fastapi import Body, FastAPI, Header
from fastapi.responses import JSONResponse

from intraday_shadow_contract import validate_predict_v2_payload
from intraday_shadow_recorder import OssShadowRecorder
from intraday_shadow_runtime import IntradayShadowRuntime


def _error(status_code, code, message):
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


class _LazyEnvironmentRuntime:
    def __init__(self):
        self._runtime = None
        self._lock = threading.Lock()

    def predict(self, request):
        if self._runtime is None:
            with self._lock:
                if self._runtime is None:
                    self._runtime = IntradayShadowRuntime(
                        model_path=os.environ.get("SHADOW_MODEL_PATH", ""),
                        run_id=os.environ.get("SHADOW_RUN_ID", ""),
                        expected_sha256=os.environ.get(
                            "SHADOW_MODEL_SHA256",
                            "",
                        ),
                    )
        return self._runtime.predict(request)


class _LazyEnvironmentRecorder:
    def __init__(self):
        self._recorder = None
        self._lock = threading.Lock()

    def record(self, prediction):
        if self._recorder is None:
            with self._lock:
                if self._recorder is None:
                    self._recorder = OssShadowRecorder.from_environment()
        return self._recorder.record(prediction)


def create_app(*, runtime=None, api_key=None, recorder=None):
    service = FastAPI(
        title="Intraday Shadow Predictor",
        version="1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    runtime = runtime or _LazyEnvironmentRuntime()
    recorder = recorder or _LazyEnvironmentRecorder()
    configured_key = (
        os.environ.get("SHADOW_API_KEY", "")
        if api_key is None
        else api_key
    )

    @service.get("/health")
    def health():
        return {
            "ok": True,
            "shadowOnly": True,
            "configured": bool(configured_key),
        }

    @service.post("/predict-v2")
    def predict_v2(
        payload: dict = Body(...),
        x_shadow_key: str = Header(default="", alias="X-Shadow-Key"),
    ):
        if not configured_key:
            return _error(503, "NOT_CONFIGURED", "影子服务尚未配置")
        if not hmac.compare_digest(x_shadow_key, configured_key):
            return _error(401, "UNAUTHORIZED", "影子服务鉴权失败")
        try:
            request = validate_predict_v2_payload(payload)
        except ValueError as error:
            return _error(422, "INVALID_INPUT", str(error))
        try:
            prediction = runtime.predict(request)
        except (RuntimeError, ValueError):
            return _error(503, "INFERENCE_UNAVAILABLE", "影子推理暂不可用")
        try:
            recorder.record(prediction)
        except Exception:  # noqa: BLE001
            return _error(503, "RECORDING_FAILED", "影子预测记录失败")
        return prediction

    return service


app = create_app()
