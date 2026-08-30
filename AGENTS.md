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
  retrain_daily.py 冠军-挑战者编排 ; train_*.py/build_dataset*.py 训练管线
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
npm run harness:lifecycle   # 假股票端到端军师→预警→复核/Judge→通知
npm run evaluate:lifecycle  # 95次重复回放并生成Excel/MD/HTML评测报告
npm run harness:ci          # CI 同口径，失败返回非零退出码
npm run harness:online      # 显式付费：FC内运行端点能力矩阵
npm run harness:shadow      # 显式付费：多端点同题影子对拍
npm run harness:export -- --input failure.json
                            # 生产失败脱敏导出为回归case
HARNESS_NICK=... HARNESS_PASSWORD=... npm run harness:advice
                            # 需显式账号与本地 API 的在线军师抽样
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

# 两端都验收；备案域名未授权时返回 401 设备授权页也说明域名已到 FC，
# 完整页面验收需在已授权设备浏览器中完成。
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

### 量化服务 → 容器/CloudBase/FC（可选）
见 `qlib-service/README.md`。部署后把地址/Key 配到后端 `QUANT_URL`/`QUANT_KEY`。不配也能跑,只是预测与融合建议不可用。

### 定时任务
- 盯盘预警：`s.yaml` 的 FC Timer 在工作日 09:30–11:30、13:00–15:00 每分钟触发。
- 策略日报：`daily-report-schedule-timer` 每 5 分钟检查账号级盘前/午间/收盘计划，到期后异步生成。
- 每日重训：GitHub Actions `daily-retrain.yml`，仓库 Settings→Secrets 配好 `OSS_*` 后自动生效。

---

## 关键约定与坑

- **前端设计基线统一读取 `docs/DESIGN.md`**：所有新增或改造组件都必须沿用当前“Apple 空间秩序 + Google Material 状态清晰度 + 交易工作台信息密度”，坚持单层表面、统一 token、明确状态、真实进度和响应式可访问性；同一操作组控件必须等高，纯图标按钮必须以同一 token 约束宽高并保持正方形；禁止卡片套卡片、重复大标题、独立视觉体系、内部枚举直出及无上下文的加载动画。
- **公式选股必须物理读取完整市场后再筛选**：按代码稳定分页读取全部 A 股并校验 `allList.length === inspectedCount === total`，任何缺页、重复代码或数量不一致都必须失败关闭；实时必要条件和日线必要条件只用于全量读取后的分层减负，禁止按涨幅、排名或固定前 N 只提前截断。最终 `.slice(0, 5)` 只能限制展示结果，不能限制参与筛选的股票。
- **七个 LLM 角色、十一个固定槽位**（`_llm_config.js`）：`advisor` / `review` / `portfolio` / `agent` / `daily` / `sector` / `judge`。军师主建议使用 `advisor` 两路，定时与 Judge 失效复核使用 `review` 四路，其余角色独立；侧边栏对话统一使用 `agent`。配置存 OSS `config/llm.json` 的 `roleEndpoints`，优先级 **OSS > env > 默认**，改完即时生效免重部署。
- **角色端点严格隔离**（`_llm_pool.js`）：请求只能进入本角色槽位，禁止跨角色回退；同角色端点先轮询采样，再结合最少在途与近期响应时长优先使用较快端点，连续失败 3 次冷却 60 秒并自动半开恢复。快速与复核必须显式下发 `reasoning_effort=none`，不能仅删除字段后让上游回到默认深度推理。`review` 四路中普通定时复核最多占两路，至少预留两路给到价/Judge 紧急复核；旧配置新增的槽位保持未配置，绝不借用 `advisor` 或复制密钥。旧 `baseUrl` / `endpoints` / `judgeEndpoint` / `sectorEndpoint` 只允许迁移读取，不得作为新功能配置入口。
- **建议任务按角色分 lane**（`_jobs.js` / `cron_advice.js`）：`data.jobs` 只承载用户单股/一次生成的 `advisor` 任务，`data.reviewJobs` 只承载定时/Judge `review` 任务；同股可各有一个活跃任务。调度按 `resourceRole` 分别计算容量，主批次进度不得混入 review。单股增量按角色使用独立 OSS 对象，复核结果发布前必须校验其基准建议仍是当前版本。
- **生成统一采用有界推理**：快速生成、深度研判与复核每个任务都只允许一次完整模型生成；底层可在尚未收到成功响应头时切换同角色端点，但响应开始后禁止换端点、重跑整题或再次调用“终稿整理器”。快速生成总预算 55 秒，只等待行情、K线、分时、主力/小单资金、大盘、板块与量化等价格决策必需证据，不等待龙虎榜、新闻、搜索、快讯或策略日报；慢证据留给深度研判。普通生成显式关闭深度思考；只有用户选择深度研判才开启中等强度思考。深度研判使用紧凑事实投影、不超过6k输出和150秒模型预算。任务的前置账户读取与报价预取必须分别有短超时，失败后使用当前账号副本或空报价降级继续；完整任务还必须有独立总时限并释放资源。模型调用前的准备故障最多自动恢复一次，模型开始后禁止重跑整题。单股快速/深度按钮在服务端受理返回前必须共用提交锁，禁止双击或跨模式重复入队。仓位诊断、板块解释和智能体同样使用有界预算；工具规划不得开启深度思考。`advisor` 端点不得被持仓诊断或其他角色借用。
- **三种军师人格与理论分层**：快速生成使用“盘中执行官”，深度研判使用“主策略官”，复核使用“临盘裁决官”。三者都读取同一理论库，但快速与复核只能做同步本地关键词检索并注入最多3条紧凑记忆，禁止增加联网、向量或慢证据等待；深度研判可注入最多5条经验正文。理论只解释和校准事实，不能覆盖实时行情、资金、量化、账户约束或风控纪律。
- **单股深度生成保持两路并行**：`advisor` 的两个专用端点可同时承载两只不同股票的单股深度任务，不能因为第一只股票在生成就全局禁用第二只。详情页生成状态必须绑定股票代码，切换股票时不得继承上一只的 `loading`；不得借用 `review`、`portfolio` 或其他角色端点扩容。
- **到价复核走低延迟快路径**：页面在线时由前端报价轮询立即调用账号鉴权接口，将命中的 `reviewOnly` 预警原子更新为 `reviewing` 并排入紧急复核；FC Timer 继续作为离线兜底。保留 2 分钟硬截止，模型预算最多 45 秒且只尝试一次，整段可用预算交给唯一模型调用，禁止预留第二轮重跑窗口；模型超时或输出不完整时直接形成不新增观察价的确定性终态。重新采集实时价格、分时、主力/散户资金、日线技术、大盘与板块资金，复用原建议中的量化、新闻、龙虎榜和策略日报，不得为重复慢证据阻塞当下决策。Worker 每秒发现新任务，普通定时复核不得占满四路 `review` 容量。
- **预警多通道必须同源**：页面横幅、浏览器系统通知、提示音和预警中心记录必须由同一个结构化通知事件驱动，股票、代码、触发条件和操作说明保持一致；去重失败时不得单独响铃。多条同时命中时横幅按队列逐条展示，不能只留下红点或声音。
- **策略日报是军师软证据**：快速建议不得等待或自动生成策略日报；深度研判可尝试补齐，但日报缺失、超时或内容不完整只能降级该证据，禁止阻断个股行情、量化和军师主模型。
- **策略日报按场次提供新增决策价值**：`daily-report.v3` 固定拆为盘前“预判与预案”、盘中“确认与纠偏”、盘后“复盘与次日预判”。盘前候选只来自板块前瞻与确定性日线价位；午报、晚报必须读取同账号同日早报逐项验证，缺失时明确标记不可复盘。行情、量能、板块资金、异动、龙虎榜和北向成交为只读硬数据，LLM 只能解释逻辑与动作，不得改写。北向净买额按现行披露规则固定为“未披露”，禁止把缺失值写成 `0` 或推断流向。
- **策略日报证据必须可追溯且可降级**：公告/政策、行情与权威媒体、网页搜索线索统一进入 `E##` 证据包，每条软信息保留来源、链接和发布时间。豆包 Global 为默认搜索源；可选 SearXNG 只允许显式配置自托管 HTTPS 实例，默认关闭且不得依赖公共实例。模型缺字段、引用不存在编号或使用证据包外数字时必须重试，仍失败则返回明确标记的规则化版本。
- **日报自动计划按账号隔离**：配置保存在 `settings["dailyReport.schedule"]`，默认关闭；`daily-report-schedule-timer` 每五分钟只判断到期场次并异步分发独立 Worker。盘前可每日运行，午间/收盘仅交易日运行；同一 `日期:场次` 使用租约、完成记录和最多三次尝试防重，不得占用 `advisor` 端点。
- **军师事件幂等**：相同用户请求在任务终态后仍不得重复创建；Judge `confirm` 只推进确定性执行状态，不重新调用军师，只有 `invalid`/计划冲突或证据快照之后的新实质事件才允许续跑。
- **生成期间的账本失效只看交易事实**：Worker 完成前校验必须使用建议专用指纹，只比较持仓数量/成本、成交记录、现金与执行计划等决策输入；题材、行业、量化分、通知开关和更新时间不得让任务回到排队。真实交易变化最多自动重算一次，并在当前 Worker 内立即续跑；再次变化则明确终止，禁止无限重排。
- **失联 Worker 不得制造假排队**：账号级 Worker 协调锁失效时，不能继续等待更长的单任务租约。尚未进入模型调用的任务可立即回到队列并重新领取；已经进入模型调用的任务必须明确失败并释放角色容量，禁止为了恢复而重复生成整题。账本变化重排时必须清空上一轮阶段、模型和端点状态。
- **人工执行状态**（`executionPlan.js` / `executionPlanStore.js`）：`USER_CONFIRMED` 只表示用户确认人工计划，不代表券商已报单；`PARTIALLY_RECORDED/COMPLETED` 只能由真实人工成交推进。执行计划与归因按成交进度、状态历史和时间合并，禁止旧设备回滚完成状态。
- **账户执行风控**（`accountCircuitBreaker.js` / `executionAttribution.js`）：未完成买入占用现金，未完成卖出不得提前释放现金；账户熔断只阻止新增风险，不阻止减仓/退出。只有完整且已核验的真实费后结果可进入效果学习。
- **持续复核使用显式股票白名单**：持仓和自选分别保存 `advAuto.holdCodes` / `advAuto.watchCodes`，FC Timer 只为名单内股票排队；字段缺失仅用于兼容旧账号“全部”，一旦用户选择后，后续新增股票不得自动加入。前端筛选复用一次性生成的概念/行业多选，自选额外支持“置顶”；个股持续复核开关必须与白名单保持一致。
- **策略日报与板块前瞻独立**：`daily` 不得复用 `agent`，`sector` 不得复用或占用 `advisor`；每个槽位独立配置 Base URL、Key、模型、深度思考、启停与在线验证。
- **批量建议增量持久化**：每只股票生成完成后先写入账号 `runtime/advice/<code>.json` 小对象，任务运行态写 `runtime/state.json`；禁止每只完成都重写整份账号快照。整批收尾再压实 `current.json`，其他设备通过增量同步立即看到单股结果。
- **OSS 并发写锁**：阿里云 OSS `PutObject` 不支持 `If-Match`，禁止把该 Header 当 CAS。账号 `current.json` 必须先通过 `x-oss-forbid-overwrite` 创建短期原子锁，锁内重读 ETag/版本后再覆盖，最后按 owner 释放锁。
- **板块前瞻读取性能**：首屏统一使用 `bootstrap` 聚合快照、设置、任务与历史摘要；历史列表读取 `history-index.json`，不得在每次进入页面时扫描并下载全部历史快照。
- **板块生成完成态**：前端只有在任务终态为 `done`、快照非空且 `generatedAt` 严格晚于点击前版本时才能提示完成。休市日手动正式生成重算最近交易日，不得创建周末信号日或用旧快照冒充新结果。
- **豆包联网检索**（`_ai_search.js` / `_ai_search_config.js`）：仅调用豆包搜索 Global版，运行时开关、API Key 名称和 Key 保存在 OSS `config/doubao-search.json`，环境变量 `DOUBAO_SEARCH_*` 仅作回退。开启后军师的个股信息与行业资讯均以豆包为正式检索源，助手、策略日报统一增加“检索参考”；关闭后禁止调用与展示。军师个股检索每轮最多一次；行业优先复用240分钟缓存，缺失时每轮最多补一次；个股缓存30分钟、失败冷却15分钟，自动复核/Judge只读缓存；同键并发请求单飞合并。搜索摘要是待核验外部证据，不能替代公告、行情、资金或龙虎榜。
- **军师与复核必须合参散户资金**：东方财富 `f84` / 日资金流 `f53` 作为小单净流入，统一映射为 `stockFund.retailNetYi`，它只是按成交规模划分的散户行为代理，不等于真实账户身份。`advisor` 与 `review` 的 `fundNote` 必须同时引用主力与小单净额并解释同向/背离：主力流出+小单流入重点防散户承接与高位派发，主力流入+小单流出需用价格和量能确认承接；禁止把单日小单净额独立当作买卖信号，缺失值不得写成 `0`。
- **五日资金必须取完整镜像**：资金历史镜像不得采用“最快非空即返回”，必须并行比较并选择有效交易日最多的结果，优先拿满最近5个交易日。用户可见 `fundNote` 由服务端根据真实快照写入当日主力/小单、完整五日双序列和五日合计，禁止让模型自行抄写或改写数值。`historyDayCount < 5` 时必须明确标记实际天数，禁止把单日或不足5日的数据称为“最近5日序列”或据此判断持续性。
- **观望价必须是近期可达的双路径**：未持仓观望分别使用 `pullbackWatchPrice`（回踩企稳，向下触发）与 `breakoutWatchPrice`（放量突破，向上触发），任一到价即可进入复核。价位必须来自实时行情、技术或量化锚点，并通过基于 ATR 的 1–5 个交易日可达性校验；已经越过、方向错误或距离过远的价位不得展示或创建预警。旧 `watchPrice` 只读兼容并在校验后迁移。
- **军师直接按证据与风险决策**：不得恢复策略治理、策略路由、版本晋级或研究级门槛。新增风险只受关键证据完整性、市场风险、量化与资金确认、合法价格、账户现金/仓位和至少 `1.8:1` 盈亏比约束；小仓试错最多总资产 `5%` 且必须人工确认。减仓、退出和硬止损不等待模型治理状态。
- **用户可见文案不得暴露内部字段**：`marketEnv.regime`、`RISK_OFF`、`blockerCodes` 等字段名和枚举只允许存在于结构化数据、日志与开发配置中。军师、复核、做T和其他前台说明必须通过 `shared/userFacingLanguage.js` 转成普通中文，并直接说明“当前能不能操作、还缺什么条件、何时重新评估”；旧建议中的已废弃策略字段也必须在展示层兼容转译。
- **板块前瞻是唯一方向决策入口**（`sector_forecast.js` / `SectorForecast.jsx`）：前端位于“今日决策”，不得在“盘面研究”或其他页面重复挂载独立 AI 选股模块。交易日 09:30–11:30、13:00–15:00 按运行时设置每 5/10/15 分钟生成独立 `intraday.json`；只复用最近正式版 LightGBM 概率作为日终先验，再用实时资金、涨幅和成分股扩散重算可买性。盘中版禁止覆盖 `latest.json`、正式历史或 08:50 盘前排名，也禁止每轮重复调用 LLM/豆包。
- **概念标签动态同步**（`stock_tags.js` / `stockTagStore.js`）：标签来自东方财富个股资料与 F10 精确题材，不得写死到持仓或自选数据。服务端成功缓存 5 分钟、空结果 2 分钟；前端只对当前正在展示的股票定期重验，变化后通过统一 store 同步所有页面。
- **两段式确认**（`_confirm.js`）：价到点→watching(弱提醒);确定性信号+LLM Judge 双判→confirm 才发强提示;LLM 置信度门槛按动作分级（买入78、止盈/减仓70、止损65），未达标降级 wait;LLM 挂了回退确定性结论。
- **每日重训**（`retrain_daily.py`）：冠军-挑战者,leak-free holdout AUC 过护栏才晋级、只升不降;腾讯为硬性前置,新浪仅参考(海外 CI 出口 IP 拉不到新浪),股票池有 `pool_cache.json` 兜底。
- **A股规则**：T+1(今日买入手数当日锁定)、手续费(佣金万3最低5/印花税千0.5仅卖/过户费万0.1)、做T FIFO 配对、含费均价。
- **健壮性**：各模块 ErrorBoundary 隔离、事件订阅 try-catch、网络请求带超时、数值渲染 `Number.isFinite` 守卫。改动时保持这些防护,勿裸 fetch、勿无超时。

---

## 提交规范

用语义化前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `style:`。中文描述根因与影响。示例见 git log。
