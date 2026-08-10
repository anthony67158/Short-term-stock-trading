# AGENTS.md — 短线操盘台 · 面向 AI 编码代理的工程指南

> 本文件供 **Codex / Claude Code** 等编码代理阅读，帮助你在**不重复踩坑**的前提下修改、部署本项目。
> 人类向的完整介绍见 `README.md`；部署铁律见 `CLAUDE.md`;密钥见 `CREDENTIALS.md`（不入库）。

---

## 一句话定位

面向 A 股短线 / 做 T 的 **AI 交易决策 + 量化预测 + 纪律执行工作台**。前后端分离：
- **前端** React 18 + Vite 5 静态站 → 部署 **Vercel**。
- **后端** 所有 `api/*` 由**单个 `server.js` Node 进程**承载 → 部署**阿里云函数计算 FC 3.0**。
- **量化微服务** FastAPI + LightGBM + GARCH → 独立部署，模型每小时从 OSS 热更新。
- **存储** 阿里云 OSS（封装成 `_blob.js`）。
- **定时** GitHub Actions（每日重训 + 每分钟盯盘拨测）。

---

## ⛔ 铁律（违反会搞挂线上，务必遵守）

1. **后端改动必须部署到阿里云 FC，不能只推 Vercel。**
   改到 `api/**`、`server.js`、或被后端 import 的任何模块（如 `api/_ai_prompts.js`）→ 必须 `s deploy`。
   仅推 Vercel 不会更新任何后端逻辑。
2. **部署 FC 前必须先 `set -a; . ./.env; set +a` 加载 `.env`**，否则 `s.yaml` 里的 `${env('...')}` 取到空值，会把**线上环境变量清空**搞挂服务。
3. **密钥绝不入库**：`.env` / `.env.local` / `.vercel/` / `CREDENTIALS.md` / 运行日志 已在 `.gitignore`。
   - GitHub Token 只在一次性 `git push` 命令 URL 里内联使用，绝不写 `.git/config`。
   - 阿里云 / OSS / LLM Key 绝不打印明文、绝不提交。
4. **不要改量化 `/predict` 的 36 维 OHLCV 模型口径**（`qlib-service/factors_lib.py` 训练/推理共用）——改了会训练/线上不一致。确认闸门 `_confirm.js` 只用公开行情 + 通用技术指标 + LLM，绝不触碰该口径。

---

## 目录速览（改哪里找哪里）

```
api/                后端(下划线开头=共享模块,非独立路由)
  server.js 入口相关 ; _lib.js 行情多镜像容错 ; _ta.js 技术指标+量化调用
  _llm.js LLM层 ; _llm_config.js 运行时配置(OSS+env+四角色) ; _llm_pool.js 端点池
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
.github/workflows/   daily-retrain.yml(每日重训) ; cron-alert.yml(每分钟盯盘)
server.js            ★ FC 自定义运行时入口:单进程承载 api/* + 托管 dist/
dev-server.js        ★ 本地开发 API 服务器
s.yaml               FC 部署配置 ; vercel.json/vite.config.js 前端
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

## 部署（Codex 请严格按此顺序）

### 前端 → Vercel（改了 `src/**`）
```bash
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"
# alias 到 one-plum 稳定域名并验 HTTP 200
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

### 定时任务 → GitHub Actions
仓库 Settings→Secrets 配好 `OSS_*`、`CRON_KEY`（须与 FC 的 `CRON_KEY` 一致）后自动生效。

---

## 关键约定与坑

- **四 AI 角色**（`_llm_config.js` ROLES）：`chat` / `advisor`(军师) / `agent`(FunctionCalling) / `judge`(确认闸门)。可各配不同网关与模型,配置存 OSS `config/llm.json`,优先级 **OSS > env > 默认**,改完即时生效免重部署。
- **LLM 端点池**（`_llm_pool.js`）：多 Base URL/Key 路由(轮询/最少在途)+ 熔断(连续失败3次冷却60s)+ 自动半开恢复。附加端点必须自带该角色模型才承接该角色。
- **两段式确认**（`_confirm.js`）：价到点→watching(弱提醒);确定性信号+LLM Judge 双判→confirm 才发强提示;置信度 `<75` 降级 wait;LLM 挂了回退确定性结论。
- **每日重训**（`retrain_daily.py`）：冠军-挑战者,leak-free holdout AUC 过护栏才晋级、只升不降;腾讯为硬性前置,新浪仅参考(海外 CI 出口 IP 拉不到新浪),股票池有 `pool_cache.json` 兜底。
- **A股规则**：T+1(今日买入手数当日锁定)、手续费(佣金万3最低5/印花税千0.5仅卖/过户费万0.1)、做T FIFO 配对、含费均价。
- **健壮性**：各模块 ErrorBoundary 隔离、事件订阅 try-catch、网络请求带超时、数值渲染 `Number.isFinite` 守卫。改动时保持这些防护,勿裸 fetch、勿无超时。

---

## 提交规范

用语义化前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `style:`。中文描述根因与影响。示例见 git log。
