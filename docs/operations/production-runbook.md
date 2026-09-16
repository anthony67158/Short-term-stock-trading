# 生产部署与恢复手册

适用版本：`a-share-platform-rebuild.v1.0`。

## 发布前门禁

1. `pnpm install --frozen-lockfile`
2. `cd backend && uv sync --frozen`
3. `uv run alembic upgrade head`
4. `uv run platform-ops preflight`
5. `pnpm lint && pnpm test:backend && pnpm contracts`
6. `pnpm typecheck && pnpm build`
7. `pnpm audit --audit-level high`

`preflight` 必须回读当前数据库 revision、活动联合包和写入开关。SHADOW
允许有模型/收益门禁，但必须保持 `allowsNewRisk=false`。

## 运行进程

同一代码 revision 运行：

- API/Web：`uvicorn platform_app.entrypoints.api:app`
- Research Agent：`python -m platform_app.modules.research.worker`
- Decision/monitor/outbox：`python -m platform_app.modules.decisions.worker`
- Review/Strategy Agent：`python -m platform_app.modules.review.worker`
- 计划到期维护：`python -m platform_app.modules.portfolio.worker`
- 每日批处理：`platform-cli run-daily-joint-cycle ...`

本机一体化启动：

```bash
PLATFORM_PORT=8000 ./infra/deploy/run-local-stack.sh
```

容器模板位于 `infra/containers/`。生产环境必须由密钥服务注入环境变量，
使用 HTTPS origin 与 Secure cookie，不使用 `compose.local.yml` 的本地数据库口令。

## 备份与恢复演练

备份文件和报告必须位于仓库外：

```bash
platform-ops backup \
  --output ~/.local/share/stock-platform/backups/platform.dump
platform-ops verify-restore \
  --backup ~/.local/share/stock-platform/backups/platform.dump
```

恢复校验会创建临时数据库、执行 `pg_restore`、核对 Alembic revision 和关键表
行数，然后删除临时库。输出不得包含数据库口令。

## 旧数据迁移

只接受 `legacy-current-state.v1` 的有来源快照。每个账户提供：

- `sourceObjectId` 与 canonical `sourceHash`
- 账户类型、现金、基准时点
- 每个持仓的证券、数量、成本、取得日和来源对象 ID
- `performanceReconstructable=false`

执行：

```bash
platform-ops migrate-snapshot \
  --snapshot /absolute/private/migration-input.json \
  --output /absolute/private/migration-report.json
```

单个账户在一个事务中写入期初现金和期初批次，随后独立对账。重复运行相同
`migrationRunId/sourceObjectId/sourceHash` 不重复创建。缺历史成交时不反推成交，
历史绩效明确不可复算。

## 维护窗口与切流

1. 将旧系统写入口和旧定时任务停止，并记录最终写入水位。
2. 新平台设置 `PLATFORM_WRITE_ENABLED=false`，部署并完成最终迁移、对账和备份。
3. 核对只有一个账户写入方后，设置 `PLATFORM_WRITE_ENABLED=true` 并重启 API/Worker。
4. 回读 `/api/v1/health`，确认 revision、数据库和活动联合包一致。
5. 使用合成账户验证研究、计划、成交、复盘；真实账户仅做只读核对。

无法证明旧写入已停止或任一账户对账失败时，不得启用新写入。

## 回滚

- 应用故障：部署前一个镜像，保留当前 PostgreSQL，不回放旧快照覆盖新事实。
- 联合包故障：使用发布历史原子回滚完整联合包。
- 数据库故障：恢复已验证备份或 PITR，随后运行账户独立对账。
- 已产生新成交后：禁止恢复旧应用为写入方，除非反向迁移已单独验证。
