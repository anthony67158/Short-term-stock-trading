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

历史数据集必须写入仓库外绝对路径，并按参考数据、逐交易日、封存三阶段执行：

```bash
uv run platform-cli build-market-dataset --dataset-root /absolute/external/path \
  --dataset-id a-share-2016-current --start-date 20160101 --end-date YYYYMMDD \
  --stage reference
uv run platform-cli build-market-dataset --dataset-root /absolute/external/path \
  --dataset-id a-share-2016-current --start-date 20160101 --end-date YYYYMMDD \
  --stage daily
uv run platform-cli build-market-dataset --dataset-root /absolute/external/path \
  --dataset-id a-share-2016-current --start-date 20160101 --end-date YYYYMMDD \
  --stage block-trades
uv run platform-cli build-market-dataset --dataset-root /absolute/external/path \
  --dataset-id a-share-2016-current --stage seal
```

该命令只从`PLATFORM_MARKET_DATA_*`读取仓库外凭据。未完成所有分区质量检查前
不得执行`seal`，封存后数据集拒绝继续写入。

研究Worker单独启动：`uv run python -m platform_app.modules.research.worker`。
账本维护单独启动：`uv run python -m platform_app.modules.portfolio.worker`，
每秒为到期人工计划释放剩余预留并追加审计；读取时也立即排除到期占用。
`PLATFORM_AGENT_ENABLED`默认关闭，完成供应商真实鉴权验证后才启用；
未启用时仍可保存研究材料。调用次数、时间与材料包均有限额，
当前研判只用于研究，不能生成生产交易动作。

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
