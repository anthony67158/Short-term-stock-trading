# AGENTS.md — 短线操盘台 · 面向 AI 编码代理的工程指南

> 本文件供 **Codex / Claude Code** 等编码代理阅读，帮助你在**不重复踩坑**的前提下修改、部署本项目。
> 人类向的完整介绍见 `README.md`；部署铁律见 `CLAUDE.md`;密钥见 `CREDENTIALS.md`（不入库）。

---

## 一句话定位

面向 A 股短线 / 做 T 的 **AI 交易决策 + 量化预测 + 纪律执行工作台**。前后端分离：
- **前端** React 18 + Vite 5 静态站 → 必须同时部署 **Vercel + 阿里云 FC 自定义域名 `https://www.tedixtf.cn/`**。
- **后端** 所有 `api/*` 由**单个 `server.js` Node 进程**承载 → 部署**阿里云函数计算 FC 3.0**。
- **量化微服务** FastAPI + LightGBM + GARCH → 独立部署，模型每小时从 OSS 热更新。
- **存储** 阿里云 OSS（封装成 `_blob.js`）。
- **定时** 阿里云 FC Timer（交易时段盯盘）+ GitHub Actions（每日重训）。

---

## ⛔ 铁律（违反会搞挂线上，务必遵守）

1. **前端改动必须双部署到 Vercel 和阿里云 FC，缺一不可。**
   改到 `src/**`、`public/**`、`index.html`、`tokens.css` 或任何影响 `dist/` 的前端文件后，必须把同一前端版本依次部署：
   - Vercel 稳定域名：`https://stock-dashboard-one-plum.vercel.app`
   - 阿里云 FC 自定义域名：`https://www.tedixtf.cn/`
   只部署 Vercel 或只部署 FC 都视为**部署未完成**；两边都必须做线上验收。
2. **后端改动必须部署到阿里云 FC，不能只推 Vercel。**
   改到 `api/**`、`server.js`、或被后端 import 的任何模块（如 `api/_ai_prompts.js`）→ 必须 `s deploy`。
   仅推 Vercel 不会更新任何后端逻辑。
3. **部署 FC 前必须先 `set -a; . ./.env; set +a` 加载 `.env`**，否则 `s.yaml` 里的 `${env('...')}` 取到空值，会把**线上环境变量清空**搞挂服务。
4. **密钥绝不入库**：`.env` / `.env.local` / `.vercel/` / `CREDENTIALS.md` / 运行日志 已在 `.gitignore`。
   - GitHub Token 只在一次性 `git push` 命令 URL 里内联使用，绝不写 `.git/config`。
   - 阿里云 / OSS / LLM Key 绝不打印明文、绝不提交。
5. **不要改量化 `/predict` 的 36 维 OHLCV 模型口径**（`qlib-service/factors_lib.py` 训练/推理共用）——改了会训练/线上不一致。确认闸门 `_confirm.js` 只用公开行情 + 通用技术指标 + LLM，绝不触碰该口径。
6. **禁止使用生产个人账号执行有副作用的自动化验收。**
   - 生产账号“飞飞徐”只能做只读检查，权威账本应只有 `003036 泰坦股份 1手`；不得自动触发 AI 生成/取消、交易、账本覆盖、设置修改或其他会写 OSS 的操作。
   - 唯一允许执行“生成→停止→刷新”等有副作用验收的云端账号是“测试账号”，密码只保存在本机 `CREDENTIALS.md`，严禁写入 Git。
   - 测试账号必须使用 `test/fixtures/comprehensive-test-account.json` 的假数据，不得复制生产账号快照；本地模拟仍优先于云端写入测试。
   - 自动化浏览器若恢复到生产账号，必须立即停止测试并关闭会话，不能把旧本地快照当成测试数据。
7. **模块化多任务决策引擎是唯一新增风险决策核心。**
   - `shared/marketOpportunityContext.js` 负责市场机会地图；
     `opportunityPlaybooks.js` 负责六打法竞争；
     `adaptivePricePlans.js` 负责现价/回踩/突破三路径；
     `decisionStateContract.js` 负责统一状态；
     `actionValueArbiter.js` 与 `decisionEnginePolicy.js` 负责合法动作竞争；
     `qlib-service/decision_engine/` 负责共享编码、路由和任务头。
   - 禁止恢复“旧公式先淘汰、市场弱一票否决、统一 1.8/2.2 盈亏比、
     固定第 5 日退出、LLM 自行决定动作”的旧链路。
   - LLM 只解释服务端动作、最强反方与失效条件，不得覆盖价格、手数、
     账户风险、动作路径或费后期望。
8. **重构时只强制兼容账户和真实交易数据。**
   `account` / `holding` / `closed` / `transactions` / `executionPlans` /
   `executionAttributions`、T+1 批次、费用和成交关联必须保留；旧建议正文、
   旧公式结果、旧观察页面和旧影子分不属于兼容边界。完整架构见
   `docs/adaptive-trading-engine.md`。

---

## 目录速览（改哪里找哪里）

```
api/                后端(下划线开头=共享模块,非独立路由)
  server.js 入口相关 ; _lib.js 行情多镜像容错 ; _ta.js 技术指标+量化调用
  _llm.js LLM层 ; _llm_config.js 运行时配置(OSS+env+七角色九槽位) ; _llm_pool.js 角色端点路由
  _confirm.js 两段式交易确认闸门 ; _ai_prompts.js 各模式prompt(含军师)
  _rag.js/_kb.js RAG ; _screen.js 选股 ; _blob.js OSS抽象 ; _portfolio.js 持仓计算
  _jobs.js 服务端任务表 ; ai.js 结构化AI ; agent.js 工具增强Agent
  cron_advice.js/cron_alert.js 云端定时 ; confirm_signal.js 确认入口 ; push.js WebPush
  llm_config.js/account.js/board.js/market.js/quote.js/... 各业务端点
qlib-service/        量化微服务(FastAPI+LightGBM+GARCH,独立部署)
  app.py /predict ; factors_lib.py 因子(训练/推理共用) ; model_lib.py 模型加载+GARCH
  opportunity_*.py 动作价值数据/评估/推理 ; promote_opportunity_model.py 晋级闸门
  retrain_daily.py 冠军-挑战者编排 ; train_*.py/build_dataset*.py 训练管线
shared/             服务端与浏览器共用的交易合同、动作价值、账户及执行逻辑
src/                 前端
  App.jsx 主框架 ; apiBase.js API基址 ; planStore.js 交易账本 ; alertStore.js 预警引擎
  review.js 复盘 ; authStore.js 账号 ; advice*.js AI建议调度 ; components/ 各页面
.github/workflows/   daily-retrain.yml(每日重训)
server.js            ★ FC 自定义运行时入口:单进程承载 api/* + 托管 dist/
dev-server.js        ★ 本地开发 API 服务器
s.yaml               FC 部署配置 + Timer 触发器 ; vercel.json/vite.config.js 前端
```

---

## 本地开发

```bash
npm install
cp .env.example .env.local   # 至少填 LLM_BASE_URL / LLM_API_KEY / AGENT_MODEL
npm run dev:api              # 终端A: 本地API(dev-server.js, 端口3000)
npm run dev                  # 终端B: 前端Vite(5173, /api 已代理到3000)
```
本地 `VITE_API_BASE` 留空即走 Vite 代理到 3000。东财行情在海外/受限网络可能拉不到,属正常。

---

## Harness 质量门禁

系统级 Harness 规格见 `docs/harness-engineering.md`。修改 AI 决策、账户约束、
证据、量化适配或风险策略时，除单元测试外必须运行对应 Harness：

```bash
npm run harness             # 全部离线 suite + JSON/Markdown episode 报告
npm run harness:portfolio   # 仅持仓再平衡
npm run harness:execution   # 仅人工执行、事件、熔断、做T与成交归因
npm run harness:lifecycle   # 假股票端到端决策→预警→复核→通知
npm run evaluate:lifecycle  # 95次重复回放并生成Excel/MD/HTML评测报告
npm run harness:ci          # CI 同口径，失败返回非零退出码
npm run harness:online      # 显式付费：FC内运行端点能力矩阵
npm run harness:shadow      # 显式付费：多端点同题影子对拍
npm run harness:export -- --input failure.json
                            # 生产失败脱敏导出为回归case
HARNESS_NICK=... HARNESS_PASSWORD=... npm run harness:advice
                            # 需显式账号与本地 API 的在线决策抽样
HARNESS_SCOPE=holding HARNESS_PROFILE=deep HARNESS_RUNS=3 \
  HARNESS_NICK=... HARNESS_PASSWORD=... npm run harness:advice
                            # 轮询测试账号全部持仓；HARNESS_CODES 可按代码筛选
```

默认 Harness 不联网、不读取生产账号、不调用付费模型。场景只能放脱敏事实，
严禁把昵称、密码、Token、API Key 或完整账户快照写入 `harness/cases/`。
每次线上 AI 事故必须先归因，再沉淀为最小回归 case；不得只改 Prompt。
在线 suite 必须显式 `--online`，不得加入默认 CI。基线只能通过
`node harness/run.mjs --update-baseline` 人工更新并随代码审查。

---

## 部署（Codex 请严格按此顺序）

### 前端 → Vercel + 阿里云 FC（改了任何影响 `dist/` 的文件）
```bash
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"
# alias 到 one-plum 稳定域名并验 HTTP 200

# 同一前端源码版本必须继续部署到 FC，更新 www.tedixtf.cn
npm run package:fc
set -a; . ./.env; set +a
npx @serverless-devs/s deploy -y

# 两端都验收；备案域名未授权时返回 200 设备授权页，
# 完整工作台验收需在已授权设备浏览器中完成。
curl -s -o /dev/null -w "%{http_code}\n" https://stock-dashboard-one-plum.vercel.app/
curl -s -o /dev/null -w "%{http_code}\n" https://www.tedixtf.cn/
```

### 后端 → 阿里云 FC（改了 `api/**`、`server.js`）
```bash
npx @serverless-devs/s config add --AccessKeyID <RAM_AK> --AccessKeySecret <RAM_SK> -f   # 首次配 default 凭证
npm run build                    # dist/ 一并打进 FC 包
npm run package:fc               # 生成仅含后端运行依赖的 .fc-package/
set -a; . ./.env; set +a         # 关键!加载 .env,否则清空线上环境变量
npx @serverless-devs/s deploy -y
```
冒烟（都应 200）：
```bash
FC="https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run"
curl -s -o /dev/null -w "%{http_code}\n" "$FC/api/quote?code=600519"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$FC/api/ai" -H "Content-Type: application/json" -d '{"mode":"ping"}'
```

### 量化服务 → 阿里云 FC / PAI-EAS（可选）
见 `qlib-service/README.md`。部署后把地址/Key 配到后端 `QUANT_URL`/`QUANT_KEY`。不配也能跑,只是预测与融合建议不可用。

### 定时任务
- 盯盘预警：`s.yaml` 的 FC Timer 在工作日 09:30–11:30、13:00–15:00 每分钟触发。
- 策略日报：`daily-report-schedule-timer` 每 5 分钟检查账号级盘前/午间/收盘计划，到期后异步生成。
- 每日重训：GitHub Actions `daily-retrain.yml`，仓库 Settings→Secrets 配好 `OSS_*` 后自动生效。

---

## 关键约定与坑

- **前端设计基线统一读取 `docs/DESIGN.md`**：所有新增或改造组件都必须沿用当前“Apple 空间秩序 + Google Material 状态清晰度 + 交易工作台信息密度”，坚持单层表面、统一 token、明确状态、真实进度和响应式可访问性；同一操作组控件必须等高，纯图标按钮必须以同一 token 约束宽高并保持正方形；禁止卡片套卡片、重复大标题、独立视觉体系、内部枚举直出及无上下文的加载动画。
- **全市场扫描必须消除旧公式选择偏差**：按代码稳定分页读取全部 A 股并校验 `allList.length === inspectedCount === total`，任何缺页、重复代码或数量不一致都必须失败关闭。深度特征预算按动量、资金潜伏、超跌修复、流动性四路召回并保留稳定探索样本；固定涨幅或旧公式不得在召回前淘汰合法股票。每只深查股票的现价、回踩、突破路径必须写入 `counterfactualPlans` 分别结算，展示截断不能改变训练账本。
- **四个 LLM 角色、五个固定槽位**（`_llm_config.js`）：`explain` 两路，`assistant` / `daily` / `sector` 各一路。系统单股和组合结果只允许由 `explain` 后置说明；侧边栏研究问答使用 `assistant`；日报和板块研究保持独立。配置存 OSS `config/llm.json` 的 `roleEndpoints`，优先级 **OSS > env > 默认**，改完即时生效免重部署。
- **角色端点严格隔离**（`_llm_pool.js`）：请求只能进入本物理角色槽位，禁止跨角色回退；同角色结合最少在途与近期响应时长路由，连续失败 3 次冷却 60 秒并自动半开恢复。解释必须显式下发 `reasoning_effort=none`。旧 `advisor` / `review` / `portfolio` / `agent` / `judge`、`baseUrl` / `endpoints` / `judgeEndpoint` / `sectorEndpoint` 只允许迁移读取；显式保存后只写四角色，禁止重新暴露旧配置入口。
- **决策任务 lane 与 LLM 角色分离**（`_jobs.js` / `cron_advice.js`）：`data.jobs` 的 `advisor` 和 `data.reviewJobs` 的 `review` 只是历史队列名，用于兼容持久化运行态，不代表物理 LLM 角色。单股评估、批量评估和到价复核直接运行模块化决策引擎，不占用 `explain` 容量；同股可各有一个主评估和复核任务，复核发布前必须校验其基准 `decisionId` 仍是当前版本。
- **LLM只做有界后置能力**：系统决策不得等待 LLM、新闻、搜索或策略日报。单股和组合解释只接受服务端构造的只读决策包，最多一次调用，输出只允许 `summary` / `counterCase` / `invalidation` / `evidenceGap`；超时、空正文、越权字段或保存冲突只使解释失败，不得改变或撤回系统决策。`assistant` 只做工具研究，不得生成交易提案；`daily` 与 `sector` 只解释硬数据，不得改写动作、价格或手数。
- **操作建议与监控计划分层**：每次成功发布的持仓建议都必须独立给出当前动作、手数、执行时点和人工核对条件，不能用“无法跟踪”或“重新生成”替代操作建议。`monitoring-plan.v2` 的秒级规则只使用报价链稳定提供的价格、涨跌幅、主力/小单、VWAP、量比、换手和日内高点回撤；相对强度与板块阶段走五分钟事件复核。只有当前最终动作为 `HOLD` 且监控计划属于当前 `decisionId`、未过期、结构有效时才展示自动跟踪；过期计划或错版计划必须忽略。模型驱动且非硬止损的 `REDUCE/EXIT` 不属于 `monitoring-plan`，必须先投影独立的 `holding-exit` 退出复核：下一笔有效报价即进入约60秒观察并重新调用一次系统决策，复核仍支持退出后才可执行。账本硬止损不等待该复核。旧 `monitoring-plan.v1` 只读兼容。
- **理论与检索只解释证据**：RAG、新闻和联网检索可帮助 `explain`、`assistant`、`daily`、`sector` 解释事实和证据缺口，但不能覆盖实时行情、资金、系统概率、账户约束或风控纪律。解释不得新增决策包中不存在的数值。
- **决策评估并发不依赖解释端点**：单股任务容量由量化服务和独立调度上限决定，不能因为 `explain` 端点忙碌而阻塞第二只股票。详情页状态必须绑定股票代码，切换股票时不得继承上一只的 `loading`。
- **到价复核走低延迟快路径**：页面在线时由前端报价轮询立即调用账号鉴权接口，将命中的 `reviewOnly` 预警原子更新为 `reviewing` 并排入紧急复核；FC Timer 继续作为离线兜底。观察价首次命中后先持续观察约 60 秒，期间不调用模型；窗口结束后一次性采集完整触价后路径并调用唯一一次系统决策，使回踩后的均价线恢复、突破后的站稳和量能延续能够进入同一轮判断。非硬止损退出使用相同窗口，但不要求价格再次穿越旧参考价：无论随后反弹还是继续下跌，下一笔有效报价都必须启动复核，禁止旧清仓价长期挂起。保留 2 分钟硬截止且只尝试一次，禁止第二轮重跑；超时或输出不完整时直接形成不新增观察价的确定性终态。重新采集实时价格、分时、主力/散户资金、日线技术、大盘与板块资金，不得为重复慢证据阻塞当下决策。Worker 每秒发现新任务。
- **预警多通道必须同源**：页面横幅、浏览器系统通知、提示音和预警中心记录必须由同一个结构化通知事件驱动，股票、代码、触发条件和操作说明保持一致；去重失败时不得单独响铃。多条同时命中时横幅按队列逐条展示，不能只留下红点或声音。
- **策略日报是后置软证据**：系统决策不得等待或自动生成策略日报；日报缺失、超时或内容不完整只能影响解释和研究，禁止阻断个股行情和量化决策。
- **策略日报按场次提供新增决策价值**：`daily-report.v3` 固定拆为盘前“预判与预案”、盘中“确认与纠偏”、盘后“复盘与次日预判”。盘前候选只来自板块前瞻与确定性日线价位；午报、晚报必须读取同账号同日早报逐项验证，缺失时明确标记不可复盘。行情、量能、板块资金、异动、龙虎榜和北向成交为只读硬数据，LLM 只能解释逻辑与动作，不得改写。北向净买额按现行披露规则固定为“未披露”，禁止把缺失值写成 `0` 或推断流向。
- **策略日报证据必须可追溯且可降级**：公告/政策、行情与权威媒体、网页搜索线索统一进入 `E##` 证据包，每条软信息保留来源、链接和发布时间。豆包 Global 为默认搜索源；可选 SearXNG 只允许显式配置自托管 HTTPS 实例，默认关闭且不得依赖公共实例。模型缺字段、引用不存在编号或使用证据包外数字时必须重试，仍失败则返回明确标记的规则化版本。
- **日报自动计划按账号隔离**：配置保存在 `settings["dailyReport.schedule"]`，默认关闭；`daily-report-schedule-timer` 每五分钟只判断到期场次并异步分发独立 Worker。盘前可每日运行，午间/收盘仅交易日运行；同一 `日期:场次` 使用租约、完成记录和最多三次尝试防重，只占用 `daily` 端点。
- **决策事件幂等**：相同用户请求在任务终态后仍不得重复创建；确定性确认只推进执行状态，只有旧决策失效、计划冲突或证据快照之后的新实质事件才允许续跑。
- **生成期间的账本失效只看交易事实**：Worker 完成前校验必须使用建议专用指纹，只比较持仓数量/成本、成交记录、现金与执行计划等决策输入；题材、行业、量化分、通知开关和更新时间不得让任务回到排队。真实交易变化最多自动重算一次，并在当前 Worker 内立即续跑；再次变化则明确终止，禁止无限重排。
- **失联 Worker 不得制造假排队**：账号级 Worker 协调锁失效时，不能继续等待更长的单任务租约。尚未进入模型调用的任务可立即回到队列并重新领取；已经进入模型调用的任务必须明确失败并释放角色容量，禁止为了恢复而重复生成整题。账本变化重排时必须清空上一轮阶段、模型和端点状态。
- **人工执行状态**（`executionPlan.js` / `executionPlanStore.js`）：`USER_CONFIRMED` 只表示用户确认人工计划，不代表券商已报单；`PARTIALLY_RECORDED/COMPLETED` 只能由真实人工成交推进。执行计划与归因按成交进度、状态历史和时间合并，禁止旧设备回滚完成状态。
- **账户执行风控**（`accountCircuitBreaker.js` / `executionAttribution.js`）：未完成买入占用现金，未完成卖出不得提前释放现金；账户熔断只阻止新增风险，不阻止减仓/退出。只有完整且已核验的真实费后结果可进入效果学习。
- **持续复核使用显式股票白名单**：持仓和自选分别保存 `advAuto.holdCodes` / `advAuto.watchCodes`，FC Timer 只为名单内股票排队；字段缺失仅用于兼容旧账号“全部”，一旦用户选择后，后续新增股票不得自动加入。前端筛选复用一次性生成的概念/行业多选，自选额外支持“置顶”；个股持续复核开关必须与白名单保持一致。
- **策略日报与板块前瞻独立**：`daily`、`sector`、`assistant`、`explain` 互不复用；每个槽位独立配置 Base URL、Key、模型、深度思考、启停与在线验证。
- **批量建议增量持久化**：每只股票生成完成后先写入账号 `runtime/advice/<code>.json` 小对象，任务运行态写 `runtime/state.json`；禁止每只完成都重写整份账号快照。整批收尾再压实 `current.json`，其他设备通过增量同步立即看到单股结果。
- **OSS 并发写锁**：阿里云 OSS `PutObject` 不支持 `If-Match`，禁止把该 Header 当 CAS。账号 `current.json` 必须先通过 `x-oss-forbid-overwrite` 创建短期原子锁，锁内重读 ETag/版本后再覆盖，最后按 owner 释放锁。
- **板块前瞻读取性能**：首屏统一使用 `bootstrap` 聚合快照、设置、任务与历史摘要；历史列表读取 `history-index.json`，不得在每次进入页面时扫描并下载全部历史快照。
- **板块生成完成态**：前端只有在任务终态为 `done`、快照非空且 `generatedAt` 严格晚于点击前版本时才能提示完成。休市日手动正式生成重算最近交易日，不得创建周末信号日或用旧快照冒充新结果。
- **豆包联网检索**（`_ai_search.js` / `_ai_search_config.js`）：仅调用豆包搜索 Global版，运行时开关、API Key 名称和 Key 保存在 OSS `config/doubao-search.json`，环境变量 `DOUBAO_SEARCH_*` 仅作回退。开启后 `assistant`、`daily`、`sector` 可增加“检索参考”；关闭后禁止调用与展示。行业优先复用240分钟缓存，个股缓存30分钟、失败冷却15分钟，同键并发请求单飞合并。搜索摘要是待核验外部证据，不能替代公告、行情、资金、系统决策或龙虎榜，也不得阻塞系统决策。
- **决策评估与复核必须合参散户资金**：东方财富 `f84` / 日资金流 `f53` 作为小单净流入，统一映射为 `stockFund.retailNetYi`，它只是按成交规模划分的散户行为代理，不等于真实账户身份。服务端 `fundNote` 必须同时引用主力与小单净额并解释同向/背离：主力流出+小单流入重点防散户承接与高位派发，主力流入+小单流出需用价格和量能确认承接；禁止把单日小单净额独立当作买卖信号，缺失值不得写成 `0`。
- **五日资金必须取完整镜像**：资金历史镜像不得采用“最快非空即返回”，必须并行比较并选择有效交易日最多的结果，优先拿满最近5个交易日。用户可见 `fundNote` 由服务端根据真实快照写入当日主力/小单、完整五日双序列和五日合计，禁止让模型自行抄写或改写数值。`historyDayCount < 5` 时必须明确标记实际天数，禁止把单日或不足5日的数据称为“最近5日序列”或据此判断持续性。
- **观望价必须是近期可达的双路径**：未持仓观望分别使用 `pullbackWatchPrice`（回踩企稳，向下触发）与 `breakoutWatchPrice`（放量突破，向上触发），任一到价即可进入复核。价位必须来自实时行情、技术或量化锚点，并通过基于 ATR 的 1–5 个交易日可达性校验；已经越过、方向错误或距离过远的价位不得展示或创建预警。旧 `watchPrice` 只读兼容并在校验后迁移。
- **新增风险按动作价值而非统一赔率决策**：合法价格、关键证据、现金、T+1、账户开放风险和费后净期望为硬条件；市场、板块、涨幅、拥挤和资金背离用于切换打法与缩小仓位，不得重复升级为全局禁止。没有跨打法统一 `1.8:1` 或 `2.2:1` 阈值；成功概率、费用、滑点和尾部损失必须共同进入盈亏平衡计算。账本硬止损不等待模型；模型驱动的普通减仓/退出必须先完成一次退出前系统复核，不能把单次负期望直接当作已确认清仓。
- **用户可见文案不得暴露内部字段**：`marketEnv.regime`、`RISK_OFF`、`blockerCodes` 等字段名和枚举只允许存在于结构化数据、日志与开发配置中。军师、复核、做T和其他前台说明必须通过 `shared/userFacingLanguage.js` 转成普通中文，并直接说明“当前能不能操作、还缺什么条件、何时重新评估”；旧建议中的已废弃策略字段也必须在展示层兼容转译。
- **板块前瞻是唯一方向决策入口**（`sector_forecast.js` / `SectorForecast.jsx`）：前端位于“今日决策”，不得在“盘面研究”或其他页面重复挂载独立 AI 选股模块。交易日 09:30–11:30、13:00–15:00 按运行时设置每 5/10/15 分钟生成独立 `intraday.json`；只复用最近正式版 LightGBM 概率作为日终先验，再用实时资金、涨幅和成分股扩散重算可买性。盘中版禁止覆盖 `latest.json`、正式历史或 08:50 盘前排名，也禁止每轮重复调用 LLM/豆包。
- **概念标签动态同步**（`stock_tags.js` / `stockTagStore.js`）：标签来自东方财富个股资料与 F10 精确题材，不得写死到持仓或自选数据。服务端成功缓存 5 分钟、空结果 2 分钟；前端只对当前正在展示的股票定期重验，变化后通过统一 store 同步所有页面。
- **两段式确认**（`_confirm.js`）：价到点→`watching`（弱提醒）；持续观察结束后由确定性信号决定是否进入系统复核，LLM 不参与动作确认。置信阈值由确定性分数边际、动作价值差和尾部风险动态计算，不得恢复买入78/卖出70/止损65的固定阈值。
- **决策数据必须分层归档**：成熟反事实标签保存在兼容路径 `opportunitymodel/training-data/`，每日训练先合并线上真实成熟结果并发布新的版本化基线；规范化日线、资金流和因果股票池 5 分钟线按交易日保存在 `opportunitymodel/market-data/v1/`，对象不可变且必须校验 SHA-256。每日归档只调用带 `QUANT_KEY` 的杭州量化 FC，由同花顺扶摇或东方财富主源和腾讯回退完成；`daily-retrain.yml` 不得读取或回退到 `TUSHARE_TOKEN`。Tushare 只允许人工历史回填，不得成为每日训练依赖。夜间定时任务必须取得最新完整交易日分片并读回校验 OSS 日线、资金流、1,000 股分钟池及至少 85% 覆盖率；端点失败、分片缺失或覆盖不足必须阻断决策模型训练，禁止复用旧归档伪装成功。盘中手动运行仅可在端点明确返回 `market_open_skipped` 时使用已校验的最近完整分片。原始行情不能直接冒充标签。完整协议见 `docs/v3-market-data-archive.md`。
- **决策模型生产使用与每日选择性晋级**：当前线上模型继续以 `usagePolicy=DIRECT` 直接参与决策；每日新训练模型只能作为挑战者，不得在评估前覆盖生产清单。生产组合为三个固定种子的 LightGBM 成交/胜率/胜负R/Q10 动作价值头 + CatBoost 横截面排序头预测级集成。每日发布以最新生产版本为冠军，分别评估成交概率、盈利概率、胜负幅度、尾部风险、横截面排序五个组成部分，再穷举已改善部分的混合组合；只有整体净R下界、回撤、命中率、覆盖率、校准误差和推理耗时均通过 `opportunity-selective-release.v1` 阈值时才原子更新 DIRECT 清单，否则维持现役版本。回测不得把负期望候选补进每日 Top5；无合法机会的日期按不交易 `0R` 计入。不得把真实加载、评测或发布失败伪装成成功。完整决策见 `docs/decisions/ADR-004-v3-selective-model-release.md`。
- **今日作战只认生产决策模型**：预催化、盘中公式、收盘公式和尾盘候选都必须在服务端比较现价/回踩/突破路径，并且只允许 `READY + usagePolicy=DIRECT` 的系统分数参与动作、排序和仓位。缺少 DIRECT 结果时明确标记不可执行；禁止用研究先验、影子分、灰度排序或旧预催化样本提示补出概率。
- **每日重训与量化汇报**：GitHub Actions 在北京时间周一至周六 01:15 先归档市场数据，再下载现役决策模型、训练挑战者、执行成员级比较和整体兼容性验证。周六凌晨必须处理周五收盘数据，不得延后到周一；周一保留为既有补齐时段，UTC cron 为 `15 17 * * 0-5`。通过的组合自动写入不可变版本与发布审计后切换清单；无提升或风险越界时保持生产版本。站内“量化汇报”只展示决策模型的训练、评估、选择和部署记录，不再混入日线辅助模型或板块模型报告。
- **A股规则**：T+1(今日买入手数当日锁定)、手续费(佣金万3最低5/印花税千0.5仅卖/过户费万0.1)、做T FIFO 配对、含费均价。
- **健壮性**：各模块 ErrorBoundary 隔离、事件订阅 try-catch、网络请求带超时、数值渲染 `Number.isFinite` 守卫。改动时保持这些防护,勿裸 fetch、勿无超时。

---

## 提交规范

用语义化前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `style:`。中文描述根因与影响。示例见 git log。
