# 部署架构与铁律（务必遵守）

> 配套文件:`README.md`(完整项目介绍)、`AGENTS.md`(面向编码代理的工程指南)、`CREDENTIALS.md`(明文密钥,仅本人自用、绝不入库)。

本项目是**前后端分离**部署，不是纯 Vercel 项目：

- **前端（双入口，同一前端版本）**：
  - Vercel 项目 `stock-dashboard`（`prj_kj8hwBB7BtFtz8REVGttUwSQhpTG`），稳定域名 `https://stock-dashboard-one-plum.vercel.app`。
  - 阿里云 FC 自定义域名 `https://www.tedixtf.cn/`，由 `server.js` 托管同一前端源码版本的 `dist/`。
- **后端（所有 API）**：阿里云函数计算（FC3.0），实例 `stock-dashboard-znrlekbzit`，
  地址 `https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run`（cn-hangzhou）。
  前端通过 `VITE_API_BASE` 注入此地址，浏览器**直连 FC**（Vercel 侧不跑 serverless）。

## 决策架构铁律

当前生产决策架构是 `docs/adaptive-trading-engine.md` 定义的自适应动作价值引擎：

- 全市场扫描后按动量、资金潜伏、超跌修复和流动性四路召回，旧公式只作特征。
- 每只深查股票同时计算现价、回踩、突破三条路径，并分别进入反事实结算。
- 市场状态只切换打法和风险预算，不能作为普通全局买入开关。
- 新增风险以费后净期望、尾部损失和账户开放风险为准，不使用统一
  `1.8:1` / `2.2:1` 盈亏比。
- 持仓同时比较加仓、持有、减仓、退出，不使用固定第 5 日退出。
- LLM 只解释服务端动作，不得决定价格、手数、路径或覆盖 T+1 与账户风控。

必须保留兼容的数据只有账户、持仓、真实成交、执行计划、执行归因、T+1批次和
费用信息。旧建议正文、旧公式结果和旧页面结构不得反向约束新架构。

机会模型使用 `opportunity-score-feature.v3`。按用户2026-09-10指示，模型文件、
特征合同及预测数值有效即以 `usagePolicy=DIRECT` 直接启用，不等待影子或晋级。
原 `shadowOnly`、`productionEligible` 保留为真实评测记录，不能伪造。
每日训练先发布当前有效产物，晋级只作后置诊断；保留真实错误、正期望与账户风控。

## 铁律：前端改动必须双部署

**只要改动会影响前端 `dist/`（例如 `src/**`、`public/**`、`index.html`、`tokens.css`），
就必须把同一前端版本同时部署到 Vercel 和阿里云 FC 的 `https://www.tedixtf.cn/`。**

只完成其中一边一律视为**部署未完成**，不得对外宣称“已上线”。部署顺序：

```bash
cd <project-root>
npm run build
npx vercel --prod --yes --token "$VC_TOKEN"

npm run package:fc
set -a; . ./.env; set +a
npx @serverless-devs/s deploy -y
```

部署后必须同时验收：
- `https://stock-dashboard-one-plum.vercel.app`
- `https://www.tedixtf.cn/`（设备授权域名；未授权时返回 `200` 授权页，完整工作台需在已授权设备验证）

## 铁律：后端改动必须部署到阿里云 FC

**只要改动涉及后端（`api/`、`server.js`、以及任何被后端引用的模块，例如 `api/_ai_prompts.js` 军师 prompt），
就必须部署到阿里云 FC，绝不能只推 Vercel。** 仅推 Vercel 不会更新任何后端逻辑。

### 后端部署步骤（Serverless Devs）

```bash
cd <project-root>
npm run build                       # 前端产物 dist/ 一并打进 FC 包，保持一致
npm run package:fc                  # 生成最小 FC 运行包，避免上传前端开发依赖
set -a; . ./.env; set +a            # 加载 .env，让 s.yaml 的 ${env('...')} 取到真值（关键，否则会把线上环境变量清空搞挂）
npx @serverless-devs/s deploy -y    # 用 ~/.s/access.yaml 的 default 凭证部署到 stock-dashboard-znrlekbzit
```

部署后冒烟校验（都应 200）：
```bash
FC="https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run"
curl -s -o /dev/null -w "%{http_code}\n" "$FC/api/quote?code=600519"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$FC/api/ai" -H "Content-Type: application/json" -d '{"mode":"ping"}'
```

### 改动分类速查
- 改任何影响 `dist/` 的前端文件 → **Vercel + 阿里云 FC 双部署**。
- 改 `api/**`、`server.js`（后端）→ 部署阿里云 FC（`s deploy`）。
- 前后端都改 → Vercel 部署一次，FC 部署一次；最终两个前端域名和 FC API 都验收。

## 安全铁律
- GitHub token 是受保护占位符：**绝不**写入 git config / 文件 / 仓库，只在一次性命令 URL 里用。
- **绝不**提交 `.env`、`.env.local`、`.vercel/`、运行日志。
- `~/.s/access.yaml` 内阿里云密钥、`.env` 内各类 key：绝不打印明文值。
