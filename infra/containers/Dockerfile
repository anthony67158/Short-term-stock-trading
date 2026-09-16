FROM node:22.22.1-bookworm-slim AS web

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @platform/web build

FROM ghcr.io/astral-sh/uv:0.11.17-python3.12-bookworm-slim

ENV PATH="/app/backend/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PLATFORM_WEB_DIST_ROOT=/app/web

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/alembic.ini ./alembic.ini
COPY backend/migrations ./migrations
COPY backend/src ./src
COPY --from=web /workspace/apps/web/dist /app/web

RUN useradd --create-home --uid 10001 platform \
    && chown -R platform:platform /app
USER platform

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/v1/health', timeout=3)); assert data['data']['status']=='ok'"]

CMD ["uvicorn", "platform_app.entrypoints.api:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips=127.0.0.1"]
