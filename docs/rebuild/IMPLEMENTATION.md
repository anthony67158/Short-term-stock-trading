# 重建实施记录

## 授权与目标

用户已在2026-09-15明确要求开始全量重建与替换，必要时重新训练A股量化模型，系统完成后通过browser-use跑全部流程并修复。按`a-share-platform-rebuild.v1.0`执行；选股与持仓管理必须由量化模型和Agent共同参与。

Agent服务指定为`https://linlongs.com`，用户指定模型名称为`gpt 5.6 terra`。实际API模型ID为`gpt-5.6-terra`，模型列表可访问，推理401尚未解决，禁止擅自替换模型。凭据保存在仓库外私密配置，任何提交、日志和浏览器不得包含明文。

## M0恢复点

- 初始提交：`7c153939f120ca16bda83d1fd2de6a548d300767`。
- 原工作区带大量未提交增删改，已保存tracked/untracked快照、删除清单、binary patch和状态。
- 私密恢复目录：`/Users/bytedance/Desktop/stock-dashboard-recovery-20260915`，目录权限700。
- 压缩快照包含1,313个文件，已逐文件读回并核验SHA-256。
- 旧环境配置与凭据独立保存在恢复目录private下，文件权限600；未写入Git。
- 重建分支：`rebuild/platform-v1`，在共享工作区创建；旧业务树已隔离归档，清理提交`d6d5d5c6`。
- 新Agent私密配置：`/Users/bytedance/.config/stock-platform/rebuild.env`，权限600；模型ID与连接仍未验证。

## 环境探测

本机已有Node22、pnpm10、uv。已安装PostgreSQL17.11，并在仓库外建立独立本地集群，
仅监听127.0.0.1:55432，TCP采用SCRAM认证。数据库与秘密配置在
`~/.config/stock-platform/`；新应用只加载`platform.env`，不自动加载旧`.env`。
Python3.12及依赖由`backend/uv.lock`锁定。云端托管PG、容器部署与成本验证尚未完成。

## 当前进度

| 任务 | 状态 | 证据/下一步 |
|---|---|---|
| T00规格与追溯 | 已完成设计核验，已获实施授权 | 文档结构、链接、55项任务依赖与20组AC检查通过 |
| T01恢复点 | 已完成备份及清理清单 | recovery目录`cleanup-plan.json`与`legacy-tree/`保存106项移出资产；包括ignored数据、模型、资料，无资产销毁 |
| T02新工程 | 后端与Web独立启动、构建通过 | 根AGENTS/README重写；新工程不引用旧服务 |
| T03基础合同 | 已实现首批并生成客户端 | Decimal字符串、严格股数、UTC时间、错误包；`pnpm contracts`通过，随业务扩展 |
| T04 UI基础 | 深浅token/控件/登录/导航已实现 | browser-use验证登录页472px无横向溢出；全视口及完整工作区尚待后续验收 |
| T05运行验证 | 本机数据库与任务验证通过，云端未验证 | Alembic迁移、并发领取、幂等、租约隔离与取消测试通过 |
| T06身份 | 会话及基础安全已实现 | Argon2、HttpOnly cookie、注销/过期、Origin校验、共享限流；账户级授权随后扩展 |
| Agent连通性 | 模型存在，推理鉴权失败 | `/v1/models`返回`gpt-5.6-terra`；两次最小chat请求均401 `User not found`，未替换模型 |
| 应用/模型/全流程验收 | 持续实施中 | 尚未训练新模型、迁移真实账本、部署或切流；当前业务页为空状态 |

### 首批验证（2026-09-15）

- `uv run alembic upgrade head`：0001任务/outbox、0002身份迁移成功。
- `uv run platform-cli health`：实际PostgreSQL连接成功。
- `pytest -q backend/tests`：6项通过，覆盖金额/股数、并发幂等、租约fencing、
  取消发布、会话/注销/过期、Origin与登录限流；存在2项第三方弃用警告，后续锁定兼容版本处理。
- `pnpm contracts`：实际生成OpenAPI与TS；`pnpm build`包含TypeScript检查并构建成功。
- `pnpm lint`：后端Ruff通过（前端lint后续补齐）。
- browser-use发现并修复CSS token导入层级错误；实际页面标题、登录form和深色背景正确，
  472px视口无横向溢出。发现浏览器恢复到旧生产域名后立即关闭，未执行任何生产写入。
- 框架依据：FastAPI multiple files、SQLAlchemy2 Session Basics、openapi-ts/openapi-fetch官方文档。

## 后续交付记录

### 账户资金切片（T13/T16/T18 的首批范围）

- 实现账户创建、实盘/模拟隔离、显式单股风险上限、期初/入金/出金、分页流水。
  PostgreSQL迁移0003包含账户归属、唯一幂等键、版本与资金符号约束。
- 资金写入锁定账户，校验版本与归属；重复请求返回原记录，内容变化返回409；
  不允许未来资金事实、超额出金、重复期初；按发生顺序录入。
  金额采用Decimal；账本更新和`portfolio.changed` outbox同事务提交。
- Web组合与执行页面接入生成的API类型，支持创建、选择账户、资金录入、
  错误反馈、流水分页和刷新恢复。纯现金余额不冒充净资产或可用资金。
- `uv run pytest -q`：8项通过（含并发重复写、精确金额、跨账户访问、错误金额、
  版本与余额约束）；`alembic check`确认数据库与声明无漂移；构建和Ruff通过。
- `pnpm test:e2e`：真实Chromium完成创建→期初10,000.01→刷新→拒绝超额出金
  →出金200.02→余额9,799.99→登出→刷新，1条完整场景通过。
  同场景检查390/768/1280/1440深浅主题无页面横向溢出，保留8张本地截图。
- 浏览器发现并修复：长用户名挤出移动端按钮；清空整个QueryCache导致登出后
  活跃observer仍展示私人页面。新逻辑先更新会话再移除其他查询。
- browser-use MCP已验证本地登录页面；该工具禁止代填密码。账户内流程通过
  Playwright调用真实登录接口建立临时合成会话后执行，测试结束清理合成账户。
  这不代表全部平台流程已完成browser-use验收。
- 限制：证券、持仓、成交、预留、冲正、公司行为尚未进入本切片，M2未完成；
  本地验证不代表生产部署。两条第三方依赖弃用警告仍待处理。

每个切片记录实际修改、验证命令、结果、限制和提交，不记录密钥、完整私人账户或无关日志。只有实际通过的任务才更新完成状态。
