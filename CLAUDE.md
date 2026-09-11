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
- 账本硬止损直接执行；V3模型驱动的普通减仓/退出先进入约60秒
  `holding-exit` 复核，使用最新价格、分时和资金重新跑一次V3。反弹和继续下跌
  都必须触发，只有复核后仍支持退出才允许执行，旧参考价不能长期挂起。
- LLM 只解释服务端动作，不得决定价格、手数、路径或覆盖 T+1 与账户风控。

必须保留兼容的数据只有账户、持仓、真实成交、执行计划、执行归因、T+1批次和
费用信息。旧建议正文、旧公式结果和旧页面结构不得反向约束新架构。

机会模型使用 `opportunity-score-feature.v5`（120 维，包含五日主力/小单
资金序列、连续方向、趋势斜率和数据可用性标识）。生产组合固定为三个种子的
LightGBM 成交/胜率/胜负R/Q10 动作价值头 + CatBoost 横截面排序头预测级集成，
每个成员独立校准后再平均。当前生产模型以 `usagePolicy=DIRECT` 直接参与
交易决策；每日新训练版本只能作为挑战者，必须先与最新生产版本比较，不得
因文件和数值合同有效就直接覆盖生产清单。
每日训练使用正负样本平衡、近期权重、打法/路径分层和困难负样本重加权，并
执行三折三种子回测；负期望候选不得被补进每日 Top5，无机会日期按不交易
`0R` 计入。成交概率、盈利概率、胜负幅度、尾部风险、横截面排序分别做
单组件冠军对照；只有改善组件组成的混合模型通过净R下界、回撤、命中率、
覆盖率、校准误差和推理耗时整体阈值后，才自动更新 DIRECT 基准。否则维持
现役版本。发布规则见 `docs/decisions/ADR-004-v3-selective-model-release.md`。
CatBoost 只排序，不能覆盖费后正期望、价格、现金、T+1与账户风控。

V3 训练数据分两层保存在 OSS：成熟标签使用
`opportunitymodel/training-data/` 并在每日训练前合并新增真实结果后压实；
可复算的日线、资金流和因果股票池 5 分钟线使用
`opportunitymodel/market-data/v1/` 按交易日不可变归档并校验 SHA-256。
原始行情不得直接充当标签。每日市场分片由杭州量化 FC 使用东方财富主源、
腾讯回退写入 OSS；`daily-retrain.yml` 必须使用仓库 Secret `QUANT_KEY`
调用该 FC，不得读取或回退到 `TUSHARE_TOKEN`。Tushare 只允许人工历史回填，
不得成为 V3 每日训练依赖。夜间定时任务必须取得最新完整交易日归档并读回
校验 OSS 内容；端点失败、分片缺失或覆盖不足必须阻断 V3 训练。盘中手动
运行仅可在端点明确返回 `market_open_skipped` 时使用已校验的最近完整分片。

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
