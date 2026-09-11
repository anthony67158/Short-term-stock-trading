# 短线操盘台

面向 A 股短线、做 T 和持仓纪律执行的个人交易工作台。系统把公开行情、V3 量化决策、价格预警、交易记录和复盘整合成一条可审计链路。

它不连接券商，也不会自动下单。所有买卖操作仍由用户在券商客户端确认执行。

> 本项目仅用于研究与工程实践，不构成投资建议。量化预测与大模型输出都可能出错，据此交易需自行承担风险。

## 当前能力

主导航收敛为**市场与选股、交易与持仓、复盘与改进**。
仓位诊断和资产管理位于交易工作区，盘面研究位于选股工作区。
本轮规格与验收见 [三工作区升级](docs/system-upgrade-20260908.md)。

### 决策

- 汇总指数、市场广度、涨跌停、资金流和情绪周期。
- 板块前瞻统一输出次日、一周和盘中动态版，明确区分可以买入、暂不买、不要买和回避。
- 入选板块展示真实成分股，可直接进入个股详情继续核验。
- 机会雷达为唯一候选入口；涨停、资金、涨速等客观盘面信息仅作研究证据。
- 雷达按本账号持仓、待买预留和现金计算预算参考，价格接近不等于已经可以买入。

### 持仓

- 建仓、加仓、减仓、清仓和做 T 流水。
- A 股 T+1、整手交易、佣金、印花税、过户费和含费成本。
- 做 T 买卖腿 FIFO 配对，也支持手动指定配对。
- 持仓与自选按核心概念或行业筛选。
- V3 统一生成动作、价格、手数和费后期望；LLM 只提供不改变决策的白话解释。
- V3 决策可加入人工执行队列，按到价、用户确认、部分成交和完成状态闭环记录。
- 真实成交按决策价、触发价、VWAP、费用和记录延迟归因，不冒充券商委托。
- 全局胜率、持续复核、一次性生成和任务进度统一位于账户总览区。
- 从雷达加入自选时保留原始依据、关注价、退出条件和时效；真实买卖继续关联该来源。
- 缺可靠概率不发布新增风险指令，研究模型和尾部估计不会冒充生产正期望。

### 账户

- 总资产按可用现金与实时持仓市值动态计算。
- 展示持仓浮盈亏、当日现金流、当日已实现盈亏和损益归因。
- 概念分层热力图以面积表达仓位，以红涨绿跌表达当日表现。
- 持仓组合分析只汇总当前有效 V3 决策，生成目标仓位、个股执行单和失效条件。
- 组合白话解释失败不影响 V3 执行单，结果和历史记录继续持久化。
- 盯盘预警采用“触价观察 -> 最新证据 -> V3 复核”两段式确认；普通退出也必须先观察约 60 秒。
- 组合风险包括现有持仓和未完成买入；卖出预案不提前释放现金。
- 复盘按首次选股来源汇总已记录的真实费后卖出结果，并说明样本与覆盖边界。

### 研究

- 板块资金流、成分股、涨停池、炸板池、异动和龙虎榜。
- 概念分时、日 K、周 K、月 K 与成交量。
- 个股分时、K 线、技术指标、V3 决策和后置白话解释。
- 豆包搜索 Global版作为独立“检索参考”维度，不替代公告、行情、资金和量化证据。

### 云端与多设备

- 昵称密码账号，数据保存到阿里云 OSS。
- 交易账本采用版本与指纹保护，避免旧页面覆盖新交易。
- V3 决策、执行计划、成交归因、预警、持仓分析和复盘支持跨设备增量同步。
- PWA、亮暗主题、桌面与移动端响应式布局。
- 备案域名支持设备授权；Vercel 和 FC 原地址不受该授权层影响。

## 系统架构

项目不是纯 Vercel 应用，而是前端、后端和量化服务分离部署。

```text
浏览器
  |
  +-- Vercel 静态 React SPA
  |     https://stock-dashboard-one-plum.vercel.app
  |
  +-- 备案域名
  |     https://www.tedixtf.cn
  |     FC 托管同一份 dist，并增加设备授权
  |
  +-------- HTTPS --------+
                           |
                    阿里云 FC 3.0
                    server.js 单进程
                    承载全部 api/*
                           |
          +----------------+----------------+
          |                |                |
       阿里云 OSS       LLM 端点池       公开行情源
       账号/配置/任务    四角色路由        东财/腾讯等
          |
          +------ 量化模型、难样本池、训练报告
                           |
                    FastAPI 量化服务
              V3机会模型 + 日线辅助预测
                           |
                    GitHub Actions
                    每日增量训练与质量门禁
```

### 部署职责

| 层 | 运行位置 | 主要职责 |
|---|---|---|
| 前端主入口 | Vercel | React SPA、PWA、交互和可视化 |
| 后端 | 阿里云 FC 3.0 | API、账号、任务、AI、预警、定时器、OSS 访问 |
| 前端备案入口 | 阿里云 FC 3.0 | 托管与 Vercel 同一前端源码版本的 `dist/`，服务 `www.tedixtf.cn` |
| 量化服务 | 独立 Python 服务 | V3 机会评分、36 因子日线辅助预测和模型元数据 |
| 存储 | 阿里云 OSS | 账号快照、配置、任务、报告、模型和难样本 |
| 定时 | FC Timer + GitHub Actions | 盯盘、复盘、任务恢复、V3 样本结算和每日训练 |

### 部署铁律

- 修改任何影响 `dist/` 的前端文件：必须把同一前端源码版本双部署到 Vercel 和 `www.tedixtf.cn` 所在的阿里云 FC；缺一边视为未完成。
- 修改 `api/**`、`server.js` 或后端引用模块：必须部署阿里云 FC。
- 前后端都修改：Vercel 与 FC 都部署，并分别验收两个前端域名和 FC API。
- FC 部署前必须加载 `.env`，否则 `s.yaml` 中的环境变量会解析为空。

详细规则见 [AGENTS.md](AGENTS.md) 和 [CLAUDE.md](CLAUDE.md)。

## AI 运行层

### 四个角色、五个端点槽位

| 角色 | 用途 | 默认模型 |
|---|---|---|
| `explain` | V3 单股和组合白话解释（固定两个端点） | `DeepSeek-V4-Pro` |
| `assistant` | Function Calling 研究助手 | `Qwen3-Max-A` |
| `daily` | 策略日报 | `Qwen3-Max-A` |
| `sector` | 板块前瞻 | `gpt-5.6-terra` |

模型配置保存在 OSS `config/llm.json`，优先级为：

```text
OSS 运行时配置 > FC 环境变量 > 代码默认值
```

配置使用 `roleEndpoints` 按角色严格隔离。`explain` 使用两个端点，其余角色各使用一个独立端点；同角色按最少在途与近期响应时长路由，任何角色都不会回退到其他角色。解释请求显式关闭深度推理，端点连续失败后会熔断、冷却并半开恢复。

V3 决策任务保留 `advisor` / `review` 两条历史 lane 名称，以兼容已持久化运行态；它们不是 LLM 角色。单股评估与到价复核都直接运行 V3，不占用解释端点。旧 `advisor`、`review`、`portfolio`、`agent`、`judge` 配置只在首次读取时迁移到四角色，保存后不再写回。

到价复核采用低延迟快路径：页面在线时一旦实时价命中观察位，会立即通过账号鉴权接口把预警切为复核中并排入紧急任务，云端 Timer 负责离线兜底。普通 V3 减仓或退出不要求价格再次穿越旧参考价，下一笔有效报价就开始约 60 秒观察；随后无论反弹还是下跌，都使用最新价格、分时、资金和 V3 特征重评。转为正期望时撤销旧退出，仍为负期望时才按最新价格授权退出。账本硬止损不等待该窗口。

### 后台任务

任务优先级：

```text
到价与退出前紧急复核
  > 单股手动V3评估
  > 一次性批量V3评估
  > 自动持续复核
```

关键约束：

- 同股重复提交按幂等键合并；每轮 V3 只使用一次完整证据快照，真实交易变化最多即时重算一次。
- 主 V3 评估默认并发 4 路（`V3_DECISION_CONCURRENCY`，硬上限 8），与两个 `explain` 端点无关；到价复核另用独立容量。提交响应丢失时最多核对 30 秒，权威任务出现后立即切换为真实进度。
- 运行期间仅真实持仓、成交、现金或执行计划变化会使旧结论失效；题材、行业和同步时间戳更新不会制造假重排。
- 主力/小单资金说明由服务端写入真实的当日净额、完整五日双序列与五日合计；历史不足五日时只显示实际天数。
- V3 决策不等待 LLM、新闻、搜索或策略日报；这些信息只进入后置解释和研究层。
- 主力/小单资金并行比较多个历史镜像并选择交易日最完整的数据；不足5日时明确标注实际天数，禁止伪称“最近5日序列”。
- 相同用户请求、触发事件和已被当前证据覆盖的复核均按幂等键去重。
- 只有完整 V3 结果成功落盘后才替换旧决策；白话解释失败不得撤回或覆盖该结果。
- 持仓和自选分别维护持续复核白名单，可按概念、行业、置顶和具体股票筛选；新增股票不会自动加入已显式配置的名单。
- Worker 分段执行后立即接力，不依赖长周期 Timer 才继续。
- 取消请求携带 `jobId` 和 `batchId`，防止旧取消误伤新任务。
- 本地在途请求使用 `AbortController`；云端取消等待权威状态确认。
- 任务阶段、数据源、模型、端点和安全摘要持续写入 OSS，可跨设备恢复。

### 持仓组合分析

组合分析由服务端读取账户内每只股票的当前有效 V3 决策，按现金、费用、T+1
和执行状态汇总。未完成退出前复核的普通 `REDUCE/EXIT` 只显示“正在复核”，
不会进入可执行卖单。`explain` 可生成四字段白话说明，但任何超时、空正文或
越权字段都只影响说明，不影响组合执行单。

## 量化系统

### V3 机会模型

- 唯一交易决策核心，统一决定动作、价格路径、手数、费后净期望和风险预算。
- 使用 120 维 `opportunity-score-feature.v5` 特征合同。
- 当前生产组合为三种子 LightGBM 动作价值头与 CatBoost 横截面排序头的预测级集成。
- 只接受 `READY + usagePolicy=DIRECT` 的结果；缺失时禁止用研究先验或旧模型补出概率。
- 每日合并历史数据与新增成熟反事实样本，执行三折三种子回测后发布当前最佳基准。

### 日线辅助模型

- 固定 36 维 OHLCV 因子口径，训练与推理共用实现。
- 只输出今日完整交易日、下一交易日和未来 5 日的概率与价格区间。
- 只作为 V3 的辅助证据，不得覆盖 V3 的动作、价格、手数、排序或风险核定。
- Transformer V2/V2.1 已下线，不再保留选择入口、EAS 服务、定时评估或训练管线。

### 每日增量训练

每日任务以 V3 为主线：

```text
历史成熟反事实
  + 当日新增成熟结果
  + 正负样本平衡、近期权重和困难负样本重加权
  -> 三折三种子训练与回测
  -> LightGBM 动作价值头 + CatBoost 排序头
  -> 与现役 V3 逐组成部分比较
  -> 穷举改善部分并验证混合组合
  -> 通过整体风险阈值后原子发布
```

- 最新盲测窗禁止参与训练和困难样本标记。
- 回测只纳入费后净期望为正的候选，无合法机会时按不交易 `0R` 计入。
- 当前生产模型保持 `usagePolicy=DIRECT`；新训练版本不会自动覆盖现役版本。
- 成交概率、盈利概率、胜负幅度、尾部风险和横截面排序可分别晋级，但每种
  混合组合都必须重新验证费后净R、下置信界、回撤、命中率、覆盖率、校准
  误差和推理耗时。
- 训练、评估、成员选择、部署结果和版本来源写入 OSS，并集中同步到站内
  “V3 每日训练与发布”。

量化服务细节见 [qlib-service/README.md](qlib-service/README.md)。

## 目录

```text
api/                    FC 后端路由与共享模块
  _llm*.js              LLM 调用、运行时配置和端点池
  _jobs.js              AI 建议任务、租约、优先级和取消
  _confirm.js           两段式交易确认
  portfolio_analysis.js 持仓组合V3汇总与后置解释
  cron_*.js             后台任务、预警和定时入口

src/                    React 前端
  App.jsx               应用框架和工作区
  planStore.js          交易账本与账户状态
  authStore.js          账号和跨设备同步
  advice*.js            AI 建议调度、缓存、批量和复核
  components/           页面、图表、持仓分析和配置面板
  styles/               基础与精细化样式

shared/                 前后端共用纯函数和业务契约
qlib-service/           Python 量化服务、训练和研究管线
harness/                系统级离线/在线质量 Harness
test/                   Node 单元与契约测试
.github/workflows/      Harness CI 与每日量化训练
server.js               FC 自定义运行时入口
dev-server.js           本地 API 服务
s.yaml                  FC、环境变量、自定义域名和 Timer
```

## 本地运行

### 前置条件

- Node.js 20 或更高版本。
- npm。
- 可选：Python 3.10+，仅在运行量化服务或训练脚本时需要。

### 启动

```bash
git clone https://github.com/anthony67158/Short-term-stock-trading.git
cd Short-term-stock-trading

npm install
cp .env.example .env.local
```

至少配置可用的 OpenAI 兼容网关：

```env
LLM_BASE_URL=https://your-gateway.example/v1
LLM_API_KEY=your-key
AGENT_MODEL=your-function-calling-model
```

分别启动后端和前端：

```bash
# 终端 A
npm run dev:api

# 终端 B
npm run dev
```

打开 `http://localhost:5173`。本地 `VITE_API_BASE` 留空时，Vite 会把 `/api` 代理到 `http://localhost:3000`。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 Vite 前端 |
| `npm run dev:api` | 启动本地 API |
| `npm test` | 运行全部 Node 测试 |
| `npm run build` | 生产构建 |
| `npm run package:fc` | 生成最小 FC 上传包 |
| `npm run harness` | 运行全部离线 Harness |
| `npm run harness:ci` | 按 CI 口径运行并输出报告 |
| `npm run harness:portfolio` | 仅运行持仓再平衡套件 |
| `npm run harness:execution` | 仅运行人工执行与归因套件 |
| `npm run harness:online` | 显式调用真实端点能力矩阵 |
| `npm run harness:shadow` | 显式执行多端点影子对拍 |
| `npm run harness:export -- --input failure.json` | 脱敏导出生产失败 |

默认 Harness 不联网、不读取生产账号、不调用付费模型。在线命令会产生真实调用费用，必须显式执行。

完整说明见 [docs/harness-engineering.md](docs/harness-engineering.md)。

## 环境变量

复制 [.env.example](.env.example) 后按需配置。

### AI

- `LLM_BASE_URL` / `LLM_API_KEY`
- `ADVISOR_MODEL`
- `REVIEW_MODEL`
- `PORTFOLIO_MODEL`
- `AGENT_MODEL`
- `DAILY_MODEL`
- `SECTOR_MODEL`
- `JUDGE_MODEL`
- `EMBED_MODEL`
- `DOUBAO_SEARCH_API_KEY` / `DOUBAO_SEARCH_KEY_NAME`

### 存储与后台任务

- `OSS_REGION` / `OSS_BUCKET` / `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`
- `OSS_ALLOW_PUBLIC_NETWORK`
- `CRON_KEY`
- `AUTHORIZED_ACCOUNT_HASHES`
- `RUNTIME_CONFIG_ADMIN_HASHES`
- `ADVISOR_COUNCIL_SHADOW`
- `STRATEGY_APPROVAL_KEY`

### 量化

- `QUANT_URL` / `QUANT_KEY`

### 推送与站点

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`
- `SITE_ACCESS_CODE_HMAC`
- `VITE_API_BASE`

真实密钥只能存在于本机环境、部署平台 Secrets 或受控 OSS 配置中。

## 测试与质量门禁

提交前至少运行：

```bash
npm test
npm run harness
npm run build
git diff --check
```

涉及以下模块时必须运行对应 Harness：

- AI 决策与建议标准化。
- 账户、现金、T+1 和整手约束。
- 证据快照和白名单。
- 量化适配与风险策略。
- 持仓组合执行单。

生产故障应先归因，再沉淀为脱敏最小回归场景；不能只修改 Prompt。

## 部署

### 前端双部署到 Vercel 与阿里云 FC

```bash
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"

npm run package:fc
set -a
. ./.env
set +a
npx @serverless-devs/s deploy -y
```

两次部署必须来自同一份前端源码版本。部署后同时确认：

- `https://stock-dashboard-one-plum.vercel.app`
- `https://www.tedixtf.cn/`

备案域名启用了设备授权；未授权的普通 HTTP 请求可能返回 `401` 授权页，完整应用需在已授权设备浏览器验收。

### 后端到阿里云 FC

```bash
npm run build
npm run package:fc

set -a
. ./.env
set +a

npx @serverless-devs/s deploy -y
```

必须在加载 `.env` 后执行部署。

部署后冒烟：

```bash
FC="https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run"

curl -s -o /dev/null -w "%{http_code}\n" \
  "$FC/api/quote?code=600519"

curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$FC/api/ai" \
  -H "Content-Type: application/json" \
  -d '{"mode":"ping"}'
```

两个请求都应返回 `200`。

## 安全边界

- `.env`、`.env.local`、`CREDENTIALS.md`、`.vercel/`、日志和构建包不入库。
- GitHub Token 只允许用于单次 push URL，不写入文件或 Git 配置。
- LLM、OSS、VAPID 和量化密钥不返回浏览器。
- OSS 在 FC 内默认使用杭州内网 Endpoint，禁止意外产生公网出流量。
- 付费 AI 接口要求账号授权；Timer 和 Worker 要求内部密钥。
- 外部搜索、网页、模型和工具返回都按不可信输入处理。
- AI 只能给出建议和预警，不能自动执行真实交易。

## 已知边界

- 生产日线模型不能预测“当前时点到收盘”的剩余时段。
- 行情源在海外或受限网络可能不可达。
- 模型、搜索或量化服务不可用时系统会降级，降级结果不等同于完整模型结论。
- 备案域名需要设备授权；Vercel 和 FC 原地址保留用于验证与运维。

## 免责声明

本项目中的行情、统计、量化预测和 AI 内容仅供研究与学习，不构成任何证券投资建议或收益承诺。市场有风险，交易决策、下单和资金损失均由使用者自行承担。
