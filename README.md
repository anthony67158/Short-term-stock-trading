# 短线操盘台

面向 A 股短线、做 T 和持仓纪律执行的个人交易工作台。系统把公开行情、量化预测、AI 操作建议、价格预警、交易记录和复盘整合成一条可审计链路。

它不连接券商，也不会自动下单。所有买卖操作仍由用户在券商客户端确认执行。

> 本项目仅用于研究与工程实践，不构成投资建议。量化预测与大模型输出都可能出错，据此交易需自行承担风险。

## 当前能力

### 决策

- 汇总指数、市场广度、涨跌停、资金流和情绪周期。
- 全市场扫描后依次执行确定性过滤、量化复排和 LLM 研判。
- 候选分为可执行、等待触发和观察，给出买入区、目标、止损、触发条件和失效条件。
- 休市期间生成下一交易日观察池，不把旧行情冒充盘中结论。

### 持仓

- 建仓、加仓、减仓、清仓和做 T 流水。
- A 股 T+1、整手交易、佣金、印花税、过户费和含费成本。
- 做 T 买卖腿 FIFO 配对，也支持手动指定配对。
- 持仓与自选按核心概念或行业筛选。
- AI 操作建议支持单股、批量、持续复核和跨页面后台生成。
- 全局胜率、持续复核、一次性生成和任务进度统一位于账户总览区。

### 账户

- 总资产按可用现金与实时持仓市值动态计算。
- 展示持仓浮盈亏、当日现金流、当日已实现盈亏和损益归因。
- 概念分层热力图以面积表达仓位，以红涨绿跌表达当日表现。
- 持仓组合分析生成目标仓位、概念调整、个股执行单、强弱场景和失效条件。
- 持仓分析结果和历史记录持久化；模型超时、空正文或 JSON 不完整时自动切换稳定模式或备用模型。
- 盯盘预警采用“触价观察 -> 客观信号 -> LLM Judge”两段式确认。

### 研究

- 板块资金流、成分股、涨停池、炸板池、异动和龙虎榜。
- 概念分时、日 K、周 K、月 K 与成交量。
- 个股分时、K 线、技术指标、量化预测和 AI 操作建议。
- AI Search 作为独立“检索参考”维度，不替代公告、行情、资金和量化证据。

### 云端与多设备

- 昵称密码账号，数据保存到阿里云 OSS。
- 交易账本采用版本与指纹保护，避免旧页面覆盖新交易。
- AI 建议、预警、持仓分析和复盘支持跨设备增量同步。
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
       账号/配置/任务    五角色路由        东财/腾讯等
          |
          +------ 量化模型、难样本池、训练报告
                           |
                    FastAPI 量化服务
                    LightGBM + 波动率区间
                           |
                    GitHub Actions
                    每日增量训练与质量门禁
```

### 部署职责

| 层 | 运行位置 | 主要职责 |
|---|---|---|
| 前端 | Vercel | React SPA、PWA、交互和可视化 |
| 后端 | 阿里云 FC 3.0 | API、账号、任务、AI、预警、定时器、OSS 访问 |
| 静态备用入口 | 阿里云 FC 3.0 | 托管 `dist/`，服务备案域名 |
| 量化服务 | 独立 Python 服务 | 日线/V2/V2.1 预测、模型元数据和准确率 |
| 存储 | 阿里云 OSS | 账号快照、配置、任务、报告、模型和难样本 |
| 定时 | FC Timer + GitHub Actions | 盯盘、复盘、任务恢复、准确率刷新、每日训练 |

### 部署铁律

- 修改 `src/**`：构建并部署 Vercel。
- 修改 `api/**`、`server.js` 或后端引用模块：必须部署阿里云 FC。
- 前后端都修改：两边都部署。
- FC 部署前必须加载 `.env`，否则 `s.yaml` 中的环境变量会解析为空。

详细规则见 [AGENTS.md](AGENTS.md) 和 [CLAUDE.md](CLAUDE.md)。

## AI 运行层

### 五个角色

| 角色 | 用途 | 默认模型 |
|---|---|---|
| `chat` | 对话与盘面分析 | `DeepSeek-V3.2-Pro` |
| `advisor` | 单股军师和操作建议 | `DeepSeek-V4-Pro` |
| `portfolio` | 持仓组合分析 | `DeepSeek-V4-Pro` |
| `agent` | Function Calling 与策略日报 | `Qwen3-Max-A` |
| `judge` | 交易时机确认 | `gemini-2.5-flash` |

模型配置保存在 OSS `config/llm.json`，优先级为：

```text
OSS 运行时配置 > FC 环境变量 > 代码默认值
```

每个角色可使用不同端点和模型。端点池支持最少在途路由、连续失败熔断、冷却和半开恢复。

### 后台任务

任务优先级：

```text
Judge 安全事件
  > 一次性批量生成
  > 单股手动生成
  > 自动持续复核
```

关键约束：

- 一次性生成期间暂停自动复核，避免模型端点争用。
- Worker 分段执行后立即接力，不依赖长周期 Timer 才继续。
- 取消请求携带 `jobId` 和 `batchId`，防止旧取消误伤新任务。
- 本地在途请求使用 `AbortController`；云端取消等待权威状态确认。
- 任务阶段、数据源、模型、端点和安全摘要持续写入 OSS，可跨设备恢复。

### 持仓分析恢复

持仓组合分析要求模型输出较长的结构化 JSON。服务端针对常见失败提供分层恢复：

1. 深度模型超时、空正文或 JSON 不完整时，关闭深度思考重试。
2. 专用模型不存在、无权限或持续失败时，切换到可用军师模型。
3. 输出可解析但执行单字段不足时，进行一次低温结构修复。
4. 两条模型链都失败时才生成规则风险诊断，并明确标记降级原因。
5. 自动复核记住上次有效模式，避免周期性重复等待同类超时。

## 量化系统

### 生产日线模型

- 固定 36 维 OHLCV 因子口径，训练与推理共用实现。
- 输出今日完整交易日预测、下一交易日预测和未来 5 日预测。
- 今日预测只使用上一交易日完整日线，不是“当前时点到收盘”的盘中预测。
- 输出方向、上涨概率、预期涨跌、价格中枢和 P10-P90 区间。
- 前端展示生产模型前向回测命中率、平衡准确率、强信号命中率和区间覆盖率。

### V2 与 V2.1

- V2：分钟 Transformer 三重障碍预测。
- V2.1：实验性盘中双头预测，按预测头和时段独立统计。
- 服务不可用时明确标记回退版本，不把 V2.0 结果冒充 V2.1。

### 每日增量训练

每日任务采用冠军-挑战者机制：

```text
历史训练数据
  + 新成熟样本适配窗
  + 持续难样本池加权重放
  -> 挑战者
  -> 最新独立盲测窗
  -> AUC / LogLoss / Top10% Precision 晋级门
  -> 通过才替换冠军
```

- 最新盲测窗禁止参与训练和难样本标记。
- 误判样本按日期与股票去重，近期错误获得更高权重并随时间衰减。
- 样本不足时安全跳过，不为完成任务强行晋级。
- 训练结果写入 OSS，并同步到站内“量化汇报”。

量化服务细节见 [qlib-service/README.md](qlib-service/README.md)。

## 目录

```text
api/                    FC 后端路由与共享模块
  _llm*.js              LLM 调用、运行时配置和端点池
  _jobs.js              AI 建议任务、租约、优先级和取消
  _confirm.js           两段式交易确认
  portfolio_analysis.js 持仓组合分析与模型恢复
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
| `npm run harness:online` | 显式调用真实端点能力矩阵 |
| `npm run harness:shadow` | 显式执行多端点影子对拍 |
| `npm run harness:export -- --input failure.json` | 脱敏导出生产失败 |

默认 Harness 不联网、不读取生产账号、不调用付费模型。在线命令会产生真实调用费用，必须显式执行。

完整说明见 [docs/harness-engineering.md](docs/harness-engineering.md)。

## 环境变量

复制 [.env.example](.env.example) 后按需配置。

### AI

- `LLM_BASE_URL` / `LLM_API_KEY`
- `LLM_MODEL`
- `ADVISOR_MODEL`
- `PORTFOLIO_MODEL`
- `AGENT_MODEL`
- `JUDGE_MODEL`
- `EMBED_MODEL`
- `ANSPIRE_API_KEY`

### 存储与后台任务

- `OSS_REGION` / `OSS_BUCKET` / `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`
- `OSS_ALLOW_PUBLIC_NETWORK`
- `CRON_KEY`
- `AUTHORIZED_ACCOUNT_HASHES`
- `ADVISOR_COUNCIL_SHADOW`
- `STRATEGY_APPROVAL_KEY`

### 量化

- `QUANT_URL` / `QUANT_KEY`
- `V2_QUANT_URL`
- `V2_EAS_TOKEN`
- `V2_API_KEY`

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

### 前端到 Vercel

```bash
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"
```

部署后确认稳定域名返回 HTTP 200。

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
