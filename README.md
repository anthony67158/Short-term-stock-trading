# 📈 短线操盘台 · A股短线 / 做T 交易决策系统

> 一个面向 A 股短线与做 T 场景的 **AI 交易决策 + 量化预测 + 纪律执行工作台**。
> 覆盖 **AI 选股 → 建仓/做T → 盯盘预警 → 交易时机确认 → 仓位纪律 → 交易复盘** 的完整操盘闭环——
> 不只告诉你「今天能不能做、做什么」,更把量化模型的**走势预测**与大模型的**具体买卖价位建议**拧成一体,
> 帮你把交易理论落成**可执行、可监控、可复盘**的买卖纪律。

**它到底是什么(一句话)**:一套「量化模型算概率、大模型给价位、规则引擎守纪律、确认闸门定时机」的个人短线交易副驾——
自己算分、自己给建议、自己盯盘推送,人只负责在券商 App 里按建议下单。

> ⚠️ **定位为决策 / 纪律 / 复盘工具,不做真实下单**——下单仍在券商 App 完成。
> 所有分析、量化预测均基于公开行情,**仅供研究学习参考,不构成任何投资建议**。据此交易,风险自负。

---

## 目录

- [一、整体架构](#一整体架构)
- [二、核心功能全景](#二核心功能全景)
- [三、AI × 量化 能力设计](#三ai--量化-能力设计)
- [四、量化微服务与每日持续训练](#四量化微服务与每日持续训练)
- [五、技术栈](#五技术栈)
- [六、目录结构](#六目录结构)
- [七、本地运行](#七本地运行)
- [八、部署(前端 Vercel + 后端阿里云 FC + 量化服务 + 定时任务)](#八部署前端-vercel--后端阿里云-fc--量化服务--定时任务)
- [九、环境变量一览](#九环境变量一览)
- [十、在应用内配置 AI 模型(无需改代码/重部署)](#十在应用内配置-ai-模型无需改代码重部署)
- [十一、A股手续费模型](#十一a股手续费模型)
- [十二、安全与隐私](#十二安全与隐私)
- [免责声明 · License](#免责声明--license)

---

## 一、整体架构

这是一个**前后端分离**的系统,不是纯 Vercel 项目。三块独立部署、各司其职:

```
┌─────────────────────────┐         ┌──────────────────────────────────────┐
│  前端(静态 SPA)          │  浏览器  │  后端(所有 API,单进程)                 │
│  React + Vite            │  直连    │  阿里云函数计算 FC 3.0 自定义运行时       │
│  部署于 Vercel           │ ───────▶ │  server.js 一个 Node 进程承载 api/*      │
│  one-plum.vercel.app     │  CORS    │  + 托管 dist/ 静态前端(备用)             │
└─────────────────────────┘         └───────────────┬──────────────────────┘
      │ VITE_API_BASE 注入 FC 地址                    │
      │                                    ┌──────────┼───────────────┐
      │                                    ▼          ▼               ▼
      │                          东财/腾讯行情    LLM 网关(可多端点)   阿里云 OSS
      │                          (服务端代理)   对话/军师/智能体/判定   账号·计划·配置·日志
      │                                                               │
┌─────┴──────────────┐   POST K线    ┌───────────────────────────────┐│
│  量化微服务          │ ◀──────────── │  FC 后端(_ta.fetchQuantPredict)││
│  FastAPI + LightGBM  │   打分+预测    └───────────────────────────────┘│
│  + GARCH 蒙特卡洛    │ ──────────▶                                    │
│  独立容器部署        │  模型每 1h 从 OSS 热更新 ◀──────────────────────┘
└──────────────────────┘
        ▲
        │ 每日凌晨拉最新日线→冠军/挑战者对拍→过护栏才晋级→上传 OSS
   GitHub Actions(daily-retrain) + GitHub Actions(cron-alert 每分钟盯盘推送)
```

**为什么这样拆:**

- **前端放 Vercel**:静态站全球 CDN、构建简单、免费额度足。
- **后端放阿里云 FC**:所有 `api/*` 由**单个 `server.js` 进程**承载(含 SSE 流式),浏览器**直连 FC**(已开 CORS)。
  之所以不走 Vercel Serverless,是因为**军师深度研判常需 47s+、AI 走 SSE 长连接**,而 Vercel Hobby 函数超时短、外部 rewrite 对 SSE 支持不稳定;FC 单函数超时可放到 600s、单实例并发 20,更适合长连接与大 JSON 解析。
- **量化服务独立部署**:Python 计算(LightGBM 打分 + GARCH 波动率 + 蒙特卡洛路径),与 Node 后端解耦,**模型每小时从 OSS 热更新**,训练产物一上传即上线,无需重部署。
- **数据落 OSS**:账号数据、AI 建议、模型配置、判定日志、Web Push 订阅统一存阿里云 OSS(封装成与 Vercel Blob 同接口的 `_blob.js`,可无缝切换)。
- **定时靠 GitHub Actions**:盯盘预警拨测(工作日每分钟)、每日模型重训(工作日凌晨),脱离浏览器也持续跑。

---

## 二、核心功能全景

### 📅 今日选股
- **大盘全景**:四大指数 + 情绪红绿灯 + **市场情绪温度计**(涨停/炸板率/最高板/连板/跌停 → 综合评分)。
- **AI 选股(量化 + 大模型融合)**:从涨停/异动/涨速候选池里,先用**量化模型逐只打分**,再由大模型结合大盘与板块**精选 3 只**,给出入选理由、买点、买入区间、止损、风险。
- **时段感知**:盘中(含午间休市 11:30–13:00)显示「AI 选股」且结果**本地持久化、刷新不丢**;**收盘后自动变「明日计划入选」**,供次日开盘参考。
- 精选候选池(涨停/主力抢筹/涨速多信号合成)、涨停连板池。

### 💼 持仓 · 做T
- 建仓 / 加仓 / 减仓 / 清仓,**每步均可 AI 建议挂单价**(结合实时价 + 历史规律 + 技术面 + 量化预测)。
- **做 T**:AI 低吸/高抛两腿价位与手数建议(量化预测 × 大模型);流水式记录、**FIFO 自动配对**算差价、含费买卖均价、手动/次日自动结算;做T后持仓手数/成本实时同步。
- **遵守 A 股 T+1**:记录买入时间,**今日买入的手数当日锁定不可卖**;自选股无底仓不可当日卖。
- **「踏5不破10」策略信号灯**:本地规则引擎实时比对现价与 MA5/MA10、量价、盈亏,给持有/低吸/减仓/清仓/止损信号,不占接口。
- **交易计划**:AI 参考技术面 + 理论生成止盈/止损价,触及即预警。
- **自动复盘**:持仓股在**午间休市、收盘**各自动生成一条复盘(午盘指导下午、收盘指导次日),每只只留最新一条、云端持久化。
- **精简卡片**:默认只显示「关键数据 + 一条当下焦点提示 + 操作按钮」,明细收进可展开区,扫读清爽不删功能。
- **按行业分类 Tab**:自动按东财行业归类,「全部 + 各行业 + 其他」,带只数/平均涨幅,按热度排序、星标置顶。

### 💰 账户 · 交易
- **账户全景**:总资产 / 仓位% / 浮盈 / 持仓分布 / 单票超配预警。
- **盯盘预警**:到价 / 涨跌幅 / 量比 / 换手 / 涨跌停临近,命中即浏览器通知 + 响铃 + **Web Push 后台推送**。
- **两段式交易确认(核心亮点)**:价触及关键价位≠立刻动手。系统先给**弱提醒(开始盯)**,再由**确认闸门**判定真正时机到了才发**强提示**(详见 [三](#三ai--量化-能力设计))。
- **交易记录**:按时间/按个股双视角、分类统计、**绩效归因**(胜率/盈亏比/每笔期望值)、CSV 导出。
- **一步撤回**:清仓/买入/做T 等操作支持撤回 Toast。

### 🔬 盘面研究
- **大盘主力资金流向图**(左出→中枢→右入,红入绿出)、板块/成分股下钻(表头排序 + 热力图)、板块近 10 日资金趋势、盘中异动、龙虎榜。

### 📊 个股详情
- 分时图(VWAP 均价线 + 昨收基准)/ K 线切换、MA5/10/20/60 数值 + 技术参考结论。
- **AI 操作建议卡(核心)**:
  - **持仓股** → 大模型结合量化预测/技术面/**你的持仓成本**,给「加仓 / 减仓 / 持有 / 清仓 + 具体挂单价位」。
  - **未持仓股** → 给「该不该买 / 买入时机 / 建议买入价 + 买入区间 + 止损 + 目标」,明确可执行。
  - **量化走势预测**:未来 5 日方向、上涨概率、预期涨跌、目标价区间、中枢价(GARCH + 蒙特卡洛)。
  - 建议生成带**实时进度时间线**(采集 → 推理 → 结论),军师深度思考过程可展开查看。
- 公司简介、一键把股票信息 + 建议问题预填进 AI 助手。

### 🤖 AI 助手(工具增强 Agent)
- Function Calling Agent,自主多轮调用行情/选股/板块/涨停/异动/情绪/量化打分/新闻等工具,结合经典交易理论 RAG 给出「数据 + 理论」双支撑分析;对话按日期持久化、可停止分析。

### ☁️ 云端账号 · 跨设备同步
- 昵称 + 密码登录,交易/计划/预警/复盘/AI 建议数据云端(OSS)存储、**跨设备按时间戳合并同步**;支持白天/夜间主题、全站移动端响应式 + PWA。

### ⚙️ 服务端后台生成(脱离浏览器)
- **AI 操作建议可在服务端生成**:单股按需触发、批量多选并发、每日定时重生成、盘中定时刷新——即使**关掉浏览器也在云端跑**,进度增量写 OSS,回到页面继续看结果。
- 服务端**并发池 + 持久任务表**(生命周期/断点续跑/防重/取消),并发上限绑定 advisor 端点数,避免烧 token。

---

## 三、AI × 量化 能力设计

系统里有**四个 AI 角色**(可各自配不同网关与模型,见 [第十节](#十在应用内配置-ai-模型无需改代码重部署)):

| 角色 | 职责 | 默认模型 |
|---|---|---|
| `chat` | 对话 / 盘面分析 | DeepSeek-V3.2-Pro |
| `advisor` | 操盘军师(深度研判,给结构化买卖建议) | DeepSeek-V4-Pro |
| `agent` | 智能体 / 策略日报(需 Function Calling) | Qwen3-Max-A |
| `judge` | 交易时机判定(确认闸门) | gemini-2.5-flash |

**几项关键设计:**

- **量化 × 大模型融合**:做T、加/减仓、买入、选股等所有定价场景,都把量化的**走势预测、目标区间、校准后的上涨概率**喂给大模型,由大模型归纳成**可直接照做的一句话行动指令 + 具体价位**,两者拧成一体而非各说各话。军师还会拿到「高把握信号」,并把归因写回。

- **两段式交易确认闸门(`_confirm.js`)**:直接回应「上班没空盯盘,到点位别急着让我动手」的诉求。
  1. 价触及买点/止损/止盈/补仓/减仓 → 仅进入 **watching(弱提醒)**。
  2. **确定性信号层**:拉腾讯公开分时 + 日线,算「止跌企稳/站回均价/缩量」(买)、「冲高滞涨/放量不涨」(卖)、「真跌破而非插针」(止损),打分。
  3. **LLM Judge 层**:把交易意图 + 建议的确认/失效条件 + 确定性结论 + 技术面 + 分时快照喂给 judge 模型,产出 `{decision: confirm|wait|invalid, confidence, reason}`。
  4. **置信度双闸门**:即便判 `confirm`,置信度 `< 75` 也降级为 `wait`(只观察不发强提示);LLM 不可用/超时则**回退到确定性结论**,保守优先——宁可 wait,绝不误发强提示。
  5. 每次判定落一条轻量日志到 OSS,供事后统计命中率。

- **工具增强 Agent(Function Calling)**:AI 助手自主决定调哪些工具、调几轮,多轮后综合作答。

- **投资理论 RAG**:道氏理论、缠论、量价关系、龙头战法、市场情绪周期、仓位与风控等蒸馏为知识库,向量检索(BGE-m3)按问题召回注入,标注引用出处、降低幻觉。

- **策略规则引擎(本地)**:「踏5不破10」法则化,用日 K 均线 + 量能实时判信号灯,零接口开销。

- **结构化决策**:所有 AI 建议以 JSON 模式输出,前端渲染成卡片。

---

## 四、量化微服务与每日持续训练

量化能力由 `qlib-service/` 提供,是一个**只依赖 numpy/scipy/lightgbm 的轻量 FastAPI 服务**,独立部署(容器/CloudBase/阿里云 FC 均可)。

**推理(`/predict`)——前端拉 K 线后 POST 给它(绕开取数风控):**
- **打分**:Plan A 用 **LightGBM 达标概率模型**(从 OSS 拉 `quantmodel/lgb_score.txt`)打 0~100 分;模型缺失自动回落纯 numpy 规则分。
- **走势预测**:Plan B 用 **GARCH(1,1)** 在线拟合条件波动率喂给**蒙特卡洛**(默认 3000 条路径),输出未来 N 日上涨概率、预期涨跌、乐观/中性/悲观目标价、方向、信心;拟合失败回落历史 σ。
- **因子口径**:推理与训练**共用 `factors_lib`**,保证线上线下一致。

**每日持续训练(冠军-挑战者,只升不降):**
- GitHub Actions `daily-retrain.yml`:工作日 UTC 01:30(北京 ~09:30,收盘后新标签成熟)自动跑。
- 流程:拉最新日线 → 因子 → **ATR 锚定 5 日达标标签** → 重建数据集(新成熟样本自动进入)→ 切最近 15% 做 **leak-free holdout** → 现役冠军 vs 新挑战者算 **AUC 对拍** → **过护栏(AUC 提升越过阈值)才晋级** → 上传 OSS。
- 量化服务 `model_lib` **每小时从 OSS 热更新**,故上传即上线,无需重部署 FC。
- **数据源韧性**:海外 CI 出口 IP 访问 CN 行情常超时,故股票池有仓库内 `pool_cache.json` 兜底、个股日线走腾讯(海外可达);预检**只把腾讯作硬性前置**,腾讯通即可训练,新浪仅参考。

> `qlib-service/` 内还含正交因子集、事件驱动因子(龙虎榜/涨停)、holdout 对拍脚本、事件确认标记生成器等研究管线;**不配置量化服务应用也能跑**,只是走势预测与融合建议不可用。

---

## 五、技术栈

- **前端**:React 18、Vite 5、ECharts(K线/分时/热力图)、纯 CSS 资金流向图、PWA(Service Worker + Web Push)
- **后端**:Node.js(ESM),阿里云函数计算 **FC 3.0 自定义运行时**,单 `server.js` 进程承载全部 `api/*`(含 SSE)
- **量化服务**:Python + FastAPI + numpy/scipy + **LightGBM**(打分)+ **GARCH**(波动率)+ 蒙特卡洛(预测)
- **数据**:东方财富公开行情(服务端代理,东财 + 腾讯双源容错)、Finnhub(海外/宏观辅助)
- **AI**:兼容 OpenAI 格式的 LLM 网关(Chat + Function Calling + Embeddings),支持**多端点资源池**(路由 + 熔断 + 故障转移)
- **存储**:阿里云 **OSS**(账号/计划/AI建议/模型配置/判定日志/Push订阅,封装成 `_blob.js` 与 Vercel Blob 同接口)+ 浏览器 localStorage(会话/兜底)
- **定时**:GitHub Actions(每日重训 + 每分钟盯盘拨测)
- **健壮性**:盘面各模块 ErrorBoundary 隔离、全局事件订阅 try-catch 隔离、所有网络请求带超时保护、数值渲染 `Number.isFinite` 守卫,单模块异常不拖垮整页

---

## 六、目录结构

```
.
├── server.js                 # ★ 阿里云 FC 自定义运行时入口:单进程承载 api/* + 托管 dist/
├── dev-server.js             # ★ 本地开发 API 服务器(把 api/ 挂成本地路由)
├── s.yaml                    # 阿里云 FC 部署配置(Serverless Devs,含环境变量映射)
├── vercel.json / vite.config.js  # 前端构建与本地 /api 代理
│
├── api/                      # 后端函数(下划线开头=共享模块,不作为独立路由)
│   ├── server 入口相关
│   ├── _lib.js               # 东财/腾讯多镜像域名容错请求 + 响应工具
│   ├── _ta.js                # 技术指标引擎(ATR/布林/RSI/KDJ/MACD/价位锚) + 量化服务调用 fetchQuantPredict
│   ├── _llm.js               # 共享 LLM 层(callChat / 重试 / SSE / JSON 解析)
│   ├── _llm_config.js        # ★ LLM 运行时配置层(OSS 持久化 + env 回退 + 四角色 + 多端点)
│   ├── _llm_pool.js          # ★ LLM 端点资源池(多 Base URL/Key 路由 + 熔断 + 故障转移)
│   ├── _confirm.js           # ★ 智能交易确认闸门(确定性信号 + LLM Judge + 置信度双闸门)
│   ├── _ai_prompts.js        # AI 各模式提示词与配置(含军师 prompt)
│   ├── _rag.js / _kb.js      # RAG 向量检索 / 投资理论知识库
│   ├── _screen.js            # 选股筛选核心
│   ├── _blob.js              # 存储抽象层(阿里云 OSS,对齐 put/list/del)
│   ├── _portfolio.js         # 服务端纯函数持仓/做T/账户计算(移植自 planStore)
│   ├── _jobs.js              # 服务端 AI 建议持久任务表(生命周期/断点/防重/取消)
│   ├── _daily_summary.js _market_data.js _market_time.js _sector_snapshots.js _push_send.js _zh_reason.js
│   ├── ai.js                 # 结构化 AI(选股/做T/买入/持仓/交易计划/复盘,均融合量化)
│   ├── agent.js              # AI 助手(工具增强 Agent,含 get_quant_score 工具)
│   ├── confirm_signal.js     # 交易确认闸门前端调用入口
│   ├── cron_advice.js        # 云端 AI 建议任务队列 + 并发池 + 单 Worker 锁(脱离浏览器)
│   ├── cron_alert.js         # 云端定时盯盘评估 + Web Push 下发(脱离浏览器)
│   ├── push.js               # Web Push 订阅管理
│   ├── llm_config.js         # AI 模型配置端点(get/save,Key 只回掩码)
│   ├── account.js            # 云端账号(注册/登录/数据同步)
│   ├── daily_report.js quant_report.js
│   ├── board.js              # 涨停池 + 盘中异动 + 龙虎榜(合并接口)
│   └── market.js sectors.js quote.js search.js stock_detail.js sector_history.js stocks.js
│
├── qlib-service/             # ★ 量化微服务(FastAPI + LightGBM + GARCH,独立部署)
│   ├── app.py                # /predict 打分 + 走势预测 + /health
│   ├── factors_lib.py        # 因子计算(训练/推理共用,口径一致)
│   ├── model_lib.py          # 模型加载(OSS 每小时热更新)+ 打分 + GARCH + 事件标记
│   ├── retrain_daily.py      # 每日冠军-挑战者训练编排器(holdout AUC 护栏)
│   ├── train_lgb.py train_signal.py build_dataset*.py  # 训练与数据集构建
│   ├── ortho_factors.py bakeoff_ortho.py spike_event*.py  # 正交/事件因子研究管线
│   ├── build_event_tags.py event_tags.json  # 每日事件确认标记
│   ├── tushare_client.py tushare_panel.py    # Tushare HTTP 客户端(基本面/资金流)
│   ├── Dockerfile Dockerfile.aliyun deploy.sh s.yaml
│   └── README.md README-CloudBase.md         # 部署说明
│
├── src/
│   ├── App.jsx               # 主框架 + Tab 路由 + 登录门户 + 预警轮询 + 自动复盘调度
│   ├── apiBase.js            # 统一 API 基址(VITE_API_BASE → FC 地址;本地走代理)
│   ├── planStore.js          # 交易账本(计划/持仓/交易记录/做T/账户/预警/复盘/撤回栈)
│   ├── alertStore.js         # 盯盘预警引擎(命中判定 + 两段式确认 + 通知 + 响铃)
│   ├── review.js             # 复盘工具 + 午间/收盘自动复盘调度
│   ├── authStore.js          # 云端账号状态
│   ├── advice*.js            # AI 建议:Runner/Cache/Gate/Batch/Daily/AutoRefresh 一整套调度
│   ├── serverAdvice.js       # 服务端按需生成触发器(fire-and-forget)
│   ├── llmConfigStore.js     # AI 模型配置向导状态
│   ├── push.js               # Web Push 订阅(前端)
│   ├── quantScore.js quantReportStore.js quantReportUiStore.js  # 量化打分/报告
│   ├── ai.js aiStore.js chatStore.js detailStore.js themeStore.js format.js hooks.js
│   ├── components/           # 各页面与组件(TodayTab/PlanTab/StockDetail/AccountHub/LLMConfig…)
│   └── styles.css            # 全站样式(暗色/白天主题 + 移动端响应式 + design tokens)
│
├── .github/workflows/
│   ├── daily-retrain.yml     # 每日量化持续训练(工作日凌晨)
│   └── cron-alert.yml        # 盯盘预警定时拨测(工作日每分钟,服务端评估 + Web Push)
│
├── scripts/migrate-blob-to-oss.mjs   # Vercel Blob → 阿里云 OSS 数据迁移
├── CLAUDE.md                 # 部署铁律与安全约定(前后端分离,后端改动必须部署 FC)
└── .env.example              # 环境变量示例
```

---

## 七、本地运行

```bash
# 1. 克隆
git clone https://github.com/anthony67158/Short-term-stock-trading.git
cd Short-term-stock-trading

# 2. 安装依赖
npm install

# 3. 配置环境变量(不配 AI 变量时行情可用,但 AI 助手/做T/建议不可用)
cp .env.example .env.local
# 编辑 .env.local,至少填 LLM_BASE_URL / LLM_API_KEY / AGENT_MODEL

# 4. 启动(需要两个终端)
npm run dev:api   # 终端 A:本地 API 服务器(dev-server.js,端口 3000)
npm run dev       # 终端 B:前端 Vite(默认 5173,已把 /api 代理到 3000)
```

浏览器打开 **http://localhost:5173** 即可使用。

> **原理**:`api/` 的函数在生产由阿里云 FC 的 `server.js` 承载;本地用 `dev-server.js` 挂载成 `http://localhost:3000/api/*`,Vite 再把 `/api` 请求代理过去。本地 `VITE_API_BASE` 留空即走此代理。
>
> ⚠️ 东方财富行情接口在**部分网络环境**(海外/受限)下可能无法直连,行情为空属正常,部署到可达节点即恢复。

---

## 八、部署(前端 Vercel + 后端阿里云 FC + 量化服务 + 定时任务)

> 本项目是**前后端分离**部署。**只要改动涉及后端(`api/`、`server.js` 及其引用的模块),就必须部署到阿里云 FC**;仅推 Vercel 不会更新任何后端逻辑。改 `src/**` 才是部署 Vercel。前后端都改 → 两边都部署。(详见 `CLAUDE.md`)

### 1) 前端 → Vercel(静态站)

```bash
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"
# 部署后 alias 到稳定域名并验 HTTP 200
```
在 Vercel 项目设置里注入 `VITE_API_BASE` = 你的 FC 后端地址,前端浏览器即直连后端。

### 2) 后端 → 阿里云函数计算 FC 3.0(Serverless Devs)

```bash
# 先配置阿里云密钥别名 default(对应 s.yaml 的 access: default)
npx @serverless-devs/s config add --AccessKeyID <AK> --AccessKeySecret <SK> -f

npm run build                    # 前端产物 dist/ 一并打进 FC 包,保持一致
set -a; . ./.env; set +a         # 加载 .env,让 s.yaml 的 ${env('...')} 取到真值
                                 # (关键!否则会把线上环境变量清空搞挂)
npx @serverless-devs/s deploy -y
```
`s.yaml` 已声明:自定义运行时 `node server.js`、内存 2GB、超时 600s(军师慢模型 + SSE)、单实例并发 20、HTTP 触发器匿名访问。

部署后冒烟(都应 200):
```bash
FC="https://<你的实例>.cn-hangzhou.fcapp.run"
curl -s -o /dev/null -w "%{http_code}\n" "$FC/api/quote?code=600519"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$FC/api/ai" -H "Content-Type: application/json" -d '{"mode":"ping"}'
```

### 3) 量化微服务 → 容器 / CloudBase / 阿里云 FC(可选但推荐)

见 `qlib-service/README.md` 与 `README-CloudBase.md`。部署后把地址与鉴权 Key 配到后端环境变量 `QUANT_URL` / `QUANT_KEY`。**不配也能运行**,只是走势预测与「量化 × 大模型」融合建议不可用。

### 4) 定时任务 → GitHub Actions

在仓库 **Settings → Secrets** 配好 `OSS_*`、`CRON_KEY`(须与 FC 的 `CRON_KEY` 一致)后,两条 workflow 自动生效:
- `daily-retrain.yml`:工作日凌晨重训量化模型,过护栏才晋级、上传 OSS。
- `cron-alert.yml`:交易时段每分钟拨测 `/api/cron_alert`,服务端遍历账号评估预警 → 命中即 Web Push(单次拨测内部自循环 ~8 秒级评估,不受 cron 1 分钟粒度限制)。

---

## 九、环境变量一览

> 在后端(FC)通过 `.env` 注入,由 `s.yaml` 映射;**AI 相关变量也可在应用内配置并存 OSS 覆盖(见第十节)**。

| 变量 | 用途 | 必需性 |
|---|---|---|
| `LLM_BASE_URL` | LLM 网关地址(兼容 OpenAI 格式) | AI 功能必需(或在应用内配) |
| `LLM_API_KEY` | LLM 网关密钥 | AI 功能必需(或在应用内配) |
| `LLM_MODEL` | `chat` 角色模型(对话/盘面分析) | 有默认值 |
| `ADVISOR_MODEL` | `advisor` 角色模型(操盘军师) | 有默认值 |
| `AGENT_MODEL` | `agent` 角色模型(智能体/策略日报) | 有默认值 |
| `JUDGE_MODEL` | `judge` 角色模型(交易时机确认) | 有默认值 |
| `EMBED_MODEL` | RAG 向量模型(如 BGE-m3) | RAG 需要 |
| `QUANT_URL` / `QUANT_KEY` | 量化微服务 `/predict` 基址与鉴权 Key | 量化预测需要 |
| `OSS_REGION` / `OSS_BUCKET` | 阿里云 OSS 区域与桶 | 云端账号/存储需要 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 阿里云 OSS 访问密钥 | 云端账号/存储需要 |
| `OSS_ENDPOINT` | OSS Endpoint(训练脚本上传模型用) | 每日重训需要 |
| `CRON_KEY` | `/api/cron_advice`、`/api/cron_alert` 的鉴权口令 | 定时任务需要(防匿名烧 token) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push(VAPID)密钥;公钥经 `public/vapid.json` 给前端,私钥仅存服务端 | Web Push 需要 |
| `FINNHUB_KEY` | Finnhub(海外/宏观辅助数据) | 可选 |
| `VITE_API_BASE` | (前端构建时)后端 FC 地址,浏览器直连 | 生产前端必需 |

> **不要**把真实密钥写进仓库。`.env`、`.env.local`、`.vercel/` 均已在 `.gitignore` 中忽略。

---

## 十、在应用内配置 AI 模型(无需改代码/重部署)

系统内置「AI 模型配置」向导(入口藏在账号下拉菜单)。它把配置以 `config/llm.json` **持久化到 OSS**,读取优先级 **OSS 配置 > 环境变量 > 内置默认**,改完**即时对全系统生效**(对话、军师、智能体、日报、判定闸门),无需重部署。

- **四角色分别配模型**:`chat / advisor / agent / judge` 各自选模型名,并可**逐角色开启「深度思考」**(reasoning)。
- **多端点资源池**:可配多个 `{ baseUrl, apiKey, 权重, 各角色模型 }` 端点。运行时按**轮询/最少在途**路由,**连续失败熔断冷却 60s、到期自动半开恢复**;并发上限绑定 advisor 端点数。不配则退化为单端点,完全向后兼容。
- **安全**:API Key 只在后端与 OSS 之间流动,**前端只拿到掩码**(`sk-****xxxx`),保存时留空则沿用原 Key。

---

## 十一、A股手续费模型

做 T / 交易记录内置真实费率:

- **佣金**:万 3,最低 5 元(买卖双向)
- **印花税**:千 0.5(仅卖出)
- **过户费**:万 0.1(买卖双向)

做 T 采用 **FIFO 配对**计算已实现差价;均价均为**含费均价**(买入均价含买费、卖出均价扣卖费);成本/浮盈均为**含费口径**,价格**原样显示不做四舍五入**,更贴近真实成本与所得。

---

## 十二、安全与隐私

- **密钥绝不进仓库**:LLM Key、OSS Key、VAPID 私钥、Cron 口令均由环境变量/OSS 承载;`.env*`、`.vercel/`、运行日志已忽略。GitHub Token 等一次性凭据只在单条命令 URL 里使用,绝不写入 git config 或文件。
- **Key 不回前端**:模型配置接口只返回掩码;VAPID 只暴露公钥。
- **接口鉴权**:量化服务用 `X-API-Key`;云端定时任务用 `X-Cron-Key`,防匿名 HTTP 触发器烧 token。
- **本地兜底不断链**:LLM/量化/行情任一不可用时,系统降级到规则引擎/确定性信号/缓存池,而非报错阻断。

---

## 免责声明 · License

本项目为个人技术项目,所有 AI 分析、量化预测与数据均基于公开行情,**仅供研究与学习参考,不构成任何投资建议**,且**不提供真实下单能力**。据此交易,风险自负。

License: **MIT**
