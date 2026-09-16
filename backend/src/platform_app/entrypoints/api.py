from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from platform_app.adapters.database import engine
from platform_app.config import settings
from platform_app.contracts.base import (
    Contract,
    Envelope,
    ErrorDetail,
    ErrorEnvelope,
    new_id,
)
from platform_app.modules.identity.routes import router as identity_router
from platform_app.modules.identity.service import IdentityError
from platform_app.modules.portfolio.routes import router as portfolio_router
from platform_app.modules.portfolio.service import PortfolioError
from platform_app.modules.market.routes import router as market_router
from platform_app.adapters.market_public import MarketError
from platform_app.modules.research.routes import router as research_router
from platform_app.modules.research.service import ResearchError
from platform_app.modules.decisions.routes import router as decision_router
from platform_app.modules.decisions.service import DecisionError
from platform_app.modules.decisions.monitoring import MonitorError
from platform_app.modules.decisions.candidates import CandidateError
from platform_app.modules.operations.routes import router as operations_router
from platform_app.modules.operations.notifications import NotificationError
from platform_app.modules.experiments.routes import router as experiment_router
from platform_app.modules.experiments.service import ExperimentError
from platform_app.modules.experiments.release_service import ReleaseError
from platform_app.modules.review.routes import router as review_router
from platform_app.modules.review.service import ReviewError

app = FastAPI(title="A股投资平台", version="0.1.0")
app.include_router(identity_router)
app.include_router(portfolio_router)
app.include_router(market_router)
app.include_router(research_router)
app.include_router(decision_router)
app.include_router(operations_router)
app.include_router(experiment_router)
app.include_router(review_router)


@app.middleware("http")
async def request_boundary(request: Request, call_next):
    request.state.request_id = new_id()
    config = settings()
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("origin") != config.origin:
            return error_response("ORIGIN_REJECTED", "请求来源不受信任", 403)
        if (
            not config.write_enabled
            and request.url.path
            not in {"/api/v1/sessions", "/api/v1/sessions/current"}
        ):
            return error_response(
                "WRITE_AUTHORITY_DISABLED",
                "当前处于维护只读窗口，业务写入已停止",
                503,
            )
    try:
        response = await call_next(request)
    except SQLAlchemyError:
        response = error_response("DATABASE_UNAVAILABLE", "数据库暂不可用，请稍后重试", 503)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=()"
    )
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )
    if config.environment == "production":
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(IdentityError)
@app.exception_handler(PortfolioError)
@app.exception_handler(MarketError)
@app.exception_handler(ResearchError)
@app.exception_handler(DecisionError)
@app.exception_handler(MonitorError)
@app.exception_handler(CandidateError)
@app.exception_handler(NotificationError)
@app.exception_handler(ExperimentError)
@app.exception_handler(ReleaseError)
@app.exception_handler(ReviewError)
async def identity_error(_request, exc):
    return error_response(exc.code, exc.message, exc.status)


def error_response(code: str, message: str, status: int):
    body = ErrorEnvelope(
        error=ErrorDetail(
            code=code,
            message=message,
            retryable=status in (409, 429, 503),
        )
    )
    return JSONResponse(body.model_dump(mode="json", by_alias=True), status_code=status)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, _exc):
    # Pydantic errors may contain submitted passwords; do not serialize raw input.
    return error_response("INVALID_REQUEST", "请检查输入格式、数量和时间", 422)


class Health(Contract):
    status: str
    database: str
    revision: str
    write_enabled: bool
    active_release_id: str | None
    active_release_status: str | None


@app.get("/api/v1/health", response_model=Envelope[Health])
def health():
    with engine().connect() as connection:
        connection.execute(text("SELECT 1"))
    config = settings()
    release_id = None
    release_status = None
    if config.joint_bundle_root and config.joint_bundle_root.exists():
        try:
            from platform_app.modules.experiments.joint_bundle import (
                JointBundle,
            )

            release = JointBundle(
                config.joint_bundle_root,
                require_ready=False,
            ).manifest
            release_id = release["bundleId"]
            release_status = release["releaseStatus"]
        except (OSError, TypeError, ValueError):
            release_status = "INVALID"
    return Envelope(
        data=Health(
            status="ok",
            database="connected",
            revision=config.deployment_revision,
            write_enabled=config.write_enabled,
            active_release_id=release_id,
            active_release_status=release_status,
        )
    )


def _mount_web() -> None:
    configured = settings().web_dist_root
    if configured is None:
        return
    root = configured.expanduser().resolve()
    index = root / "index.html"
    assets = root / "assets"
    if not index.is_file() or not assets.is_dir():
        raise RuntimeError("Configured Web distribution is incomplete")
    app.mount(
        "/assets",
        StaticFiles(directory=assets),
        name="web-assets",
    )

    @app.get("/", include_in_schema=False)
    def web_index():
        return FileResponse(index)

    @app.get("/{full_path:path}", include_in_schema=False)
    def web_route(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (root / full_path).resolve()
        if root in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index)


_mount_web()
