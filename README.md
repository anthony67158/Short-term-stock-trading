# 知衡 · A股投资工作台

以量化模型和 Agent 联合辅助股票研究、选股、持仓管理、人工成交和策略实验。
工程正在按 [重建方案](docs/rebuild/README.md) 分阶段替换；实际交付状态见
[实施记录](docs/rebuild/IMPLEMENTATION.md)，尚未启用新生产交易决策。

## 结构

- `apps/web`：React / TypeScript / Vite，Linear 风格工作区。
- `backend`：FastAPI / PostgreSQL，领域模块、独立任务进程及统一计算内核。
- `contracts`、`packages/api-client`：从 Python OpenAPI 生成的客户端合同。
- `packages/design-tokens`：深浅主题与控件 token。

## 本地开发

要求 Node 22、pnpm 10、uv、Python 3.12、PostgreSQL 17。
私密环境文件通过 `PLATFORM_CONFIG_FILE` 指定，默认读取
`~/.config/stock-platform/platform.env`；不会自动加载旧工程 `.env`。

```bash
pnpm install
cd backend
uv sync --python 3.12
uv run alembic upgrade head
uv run uvicorn platform_app.entrypoints.api:app --reload --host 127.0.0.1 --port 8000
```

另开终端在根目录执行 `pnpm dev`，浏览器访问 `http://localhost:5173`。
创建登录用户使用`uv run platform-cli create-user`（密码交互输入），
投资账户在“组合与执行”中创建，不在前端内置默认密码。
首次证券目录通过`uv run platform-cli sync-instruments`显式联网采集；
当前目录不能用于历史回测股票池。

## 验证

```bash
pnpm contracts
pnpm typecheck
pnpm build
pnpm lint
pnpm test:backend
```

启动本地前后端、同步证券目录后，可执行`pnpm exec playwright install chromium`
与`pnpm test:e2e`。该浏览器场景使用临时合成账户，当前包含真实公开报价访问，
不属于默认离线CI；截图与报告在忽略目录`test-results/`、`playwright-report/`。

后端集成测试需要隔离 PostgreSQL；只创建和清理带随机标识的合成测试记录，
不连接旧生产账户。云端切流需完成联合模型验证及真实账本迁移对账。
