# 📈 短线操盘台 · A股短线 / 做T 交易决策系统

> 一个面向 A 股短线与做 T 场景的 **AI 交易决策工作台**：把实时行情、板块资金、涨停梯队、交易理论融进一条「盘前研判 → 选股 → 建仓/做T → 交易复盘」的操盘闭环。

前端 React + Vite，后端 Vercel Serverless Functions，行情来自东方财富公开接口，AI 能力由大模型（Function Calling Agent + RAG）驱动。

---

## ✨ 核心功能

| 模块 | 能力 |
|---|---|
| **今日选股** | 大盘盘面全景（四大指数+情绪红绿灯）、AI 今日操盘建议、精选候选池（涨停/主力抢筹/涨速多信号合成）、涨停连板池 |
| **持仓 · 做T** | 自选/候选盯盘、建仓、加仓、减仓/清仓；**做 T** 独立抽屉（AI 低吸/高抛价位建议、流水式记录、FIFO 自动配对算差价、按天折叠、含费买卖均价） |
| **交易记录** | 买入/卖出/平仓/做T 分类统计（胜率、净收益、手续费）、按天/按股票折叠的操作流水、含费均价 |
| **盘面研究** | 板块资金流桑基图、板块/成分股下钻（表头可点击排序）、板块近 10 日资金趋势、盘中异动 |
| **AI 助手** | 工具增强 Agent，自主多轮调用行情/选股/板块/涨停/异动/情绪/新闻，结合经典交易理论 RAG 给出「数据+理论」双支撑的操盘分析 |
| **云端账号** | 昵称+密码登录，交易数据云端存储、跨设备同步 |

---

## 🧠 AI 能力设计

- **工具增强 Agent（Function Calling）**：AI 助手自主决定调用哪些工具、调几轮 —— 查行情、选股筛选、板块资金、涨停连板、盘中异动、大盘情绪、联网新闻，多轮后综合作答。
- **投资理论 RAG**：将道氏理论、缠论、量价关系、龙头战法、市场情绪周期、仓位与风控等经典交易体系蒸馏为知识库，向量检索（BGE-m3）按问题召回并注入上下文，让结论有据可依、标注引用出处、降低幻觉。
- **结构化决策**：今日操盘、盘面复盘、做T建议等以 JSON 模式输出，前端渲染成卡片。

---

## 🛠 技术栈

- **前端**：React 18、Vite 5、ECharts（K线/桑基图/热力图）
- **后端**：Vercel Serverless Functions（Node.js）
- **数据**：东方财富公开行情接口（服务端代理）
- **AI**：兼容 OpenAI 格式的 LLM 网关（Chat + Function Calling + Embeddings）
- **存储**：Vercel Blob（云端账号数据）+ 浏览器 localStorage（本地兜底）

---

## 📂 目录结构

```
.
├── api/                  # Serverless 后端函数（生产由 Vercel 托管）
│   ├── _lib.js           # 东财请求 / 响应工具（下划线=共享模块，不占函数额度）
│   ├── _rag.js           # RAG 语料构建 + 向量检索
│   ├── _kb.js            # 投资理论知识库
│   ├── _screen.js        # 选股筛选核心逻辑
│   ├── agent.js          # AI 助手（工具增强 Agent）
│   ├── ai.js             # 结构化 AI（今日操盘/盘面复盘/做T建议）
│   ├── account.js        # 云端账号（注册/登录/数据同步）
│   ├── market.js sectors.js limitup.js movers.js quote.js ...  # 各类行情
│   └── stock_detail.js sector_history.js stocks.js search.js
├── src/
│   ├── App.jsx           # 主框架 + Tab 路由 + 登录门户
│   ├── components/       # 各页面与组件
│   ├── planStore.js      # 交易账本（计划/持仓/交易记录/做T）
│   ├── authStore.js      # 云端账号状态
│   ├── aiStore.js detailStore.js  # AI 助手 / 个股详情全局状态
│   └── styles.css        # 全站样式（Linear 风格暗色主题）
├── dev-server.js         # ★本地开发 API 服务器（把 api/ 挂成本地路由）
├── vite.config.js        # 前端配置（/api 代理到本地 3000）
├── vercel.json           # Vercel 部署配置
└── .env.example          # 环境变量示例
```

---

## 🚀 本地运行

### 1. 克隆项目

```bash
git clone https://github.com/anthony67158/Short-term-stock-trading.git
cd Short-term-stock-trading
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制示例文件并填入你的 LLM 网关信息（不配 AI 相关变量时，行情功能可用，但 AI 助手/做T建议不可用）：

```bash
cp .env.example .env.local
# 然后编辑 .env.local，至少填 LLM_BASE_URL / LLM_API_KEY / AGENT_MODEL
```

### 4. 启动（需要两个终端）

```bash
# 终端 A：启动本地 API 服务器（端口 3000）
npm run dev:api

# 终端 B：启动前端（Vite，默认 5173，已配置把 /api 代理到 3000）
npm run dev
```

浏览器打开 **http://localhost:5173** 即可使用。

> **说明**：`api/` 目录里是 Vercel Serverless 函数。本地用 `dev-server.js` 把它们挂载成 `http://localhost:3000/api/*` 路由，Vite 再把前端的 `/api` 请求代理过去，从而在本机完整跑起来。
>
> ⚠️ 东方财富行情接口在**部分网络环境**下可能无法直连（如海外/受限网络），若行情为空属正常现象，部署到 Vercel 海外节点则可正常获取。

---

## ☁️ 部署到 Vercel

1. 在 [Vercel](https://vercel.com) 导入本仓库。
2. 在项目 **Settings → Environment Variables** 配置 `.env.example` 中的变量。
3. （可选）需要云端账号功能：在 Vercel 创建一个 **Blob Store** 并连接到项目，会自动注入 `BLOB_READ_WRITE_TOKEN`。
4. Vercel 会自动识别 Vite 构建与 `api/` 函数，一键部署。

> 注意：Vercel Hobby 计划 Serverless 函数上限为 **12 个**；本项目已用满，新增后端能力时请复用现有函数或合并为下划线共享模块。

---

## ⚙️ A股手续费模型（做T/交易记录内置）

- 佣金：万 3，最低 5 元（买卖双向）
- 印花税：千 0.5（仅卖出）
- 过户费：万 0.1（买卖双向）

做 T 采用 **FIFO 配对**计算已实现差价，均价均为**含费均价**（买入均价含买费、卖出均价扣卖费），更贴近真实成本与所得。

---

## 📌 免责声明

本项目为个人技术项目，所有 AI 分析与数据均基于公开行情、**仅供研究与学习参考，不构成任何投资建议**。据此交易，风险自负。

---

## 📄 License

MIT
