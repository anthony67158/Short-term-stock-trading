# 选股模块重构设计（2026-09-17）

状态：`In Progress`
决策者：平台所有者
设计入口从属：`docs/legacy-system-restoration-and-model-agent-integration.md`
进度记录：`docs/rebuild/IMPLEMENTATION.md`

## 用户决策（本次明确）

1. 一级模块 `今日作战` → 重定位为 `选股`；移除"今日作战"外壳。
2. 全市场扫描给出候选 → 模型排序 → Agent 结合盘面/资金/公告精选最佳可买股票，并给出**买入策略与时机推断**。
3. `选股` 与 `盘面研究` 结合：同一"选股"页含两个子视图（选股结果 / 盘面研究），Agent 精选读取盘面研究的市场/板块/资金作为输入。
4. 需求 2 为**重新引入**：旧候选池 Agent（opportunity-agent-selection）方案删除，按本方案重建。
5. 排序引擎：新引入开源模型（qlib + LightGBM）**直接上线**替换旧生成模型；不再以旧决策模型为选股依赖。
6. Agent 判定不选（证据不足/不可用）时：**展示 Top 候选供参考**，明确标注"未经 Agent 精选"。

## 唯一保留护栏

- 新排序模型训练后跑一次费后（双边佣金+印花税+过户费+卖出滑点）、时间外（walk-forward）、全股票池回测，得出并**透明展示**指标；正常达标即直接上线。
- 仅当回测费后为负/明显破产时，不得把它包装成"正收益预测"（AGENTS.md 硬约束）；该极端情况如实标注，不静默上线伪造分。
- 市场事实、模型预测、Agent 研判、模拟、真实成交分开保存并可追溯；Agent 不改代码/价格/手数/路径；不自动下单。

## 选型结论（据两份调研证据）

- **召回层（可立即上线）**：复用现成全A股全池分页器 `fetchTailPickRealtimePool`（`api/_tail_pick_data.js`，翻页并发 + `unique.length === total` 完整性强校验）+ qlib **Alpha158 因子公式**（MIT，逻辑在自有数据重算）+ 经典量价/资金规则。产出"候选池 + 可解释理由"，不包装成收益预测。
- **排序层（新模型，直接上线）**：qlib 工作流 `Alpha158 → LightGBM → 费后 walk-forward 回测`（MIT，本地 macOS M4 离线训练）。**硬边界**：qlib/Python 只在离线；线上 Node/FC 只消费离线产出的排序分与候选清单。
- **Agent 精选层**：读取盘面研究（市场/板块/资金）+ 三级资金（`_stock_fund.js`）+ 公告/新闻（复用豆包 `_ai_search.js` / 开源 `_searxng_search.js`），在候选池内精选最佳可买股票，输出：结论、买入理由、**买入策略（价格区间/仓位上限/分批）**、**时机推断（触发条件/有效期/次日预案）**、反方、失效条件、证据引用。
- **排除**：backtrader（停更、无 A 股规则）、时序基础模型直接上线（非横截面排序）、TimesFM 3.0 商用权重（非商用许可）、RD-Agent 直出上线因子（评测证实实盘脱钩）。

## 目标架构（三层）

```
选股页（原 today 位，一级导航"选股"）
├─ 子视图 A：选股结果
│    候选池召回(全市场扫描) → 模型排序分 → Agent 精选卡片
│       每张卡：结论/买入理由/买入策略/时机推断/反方/失效/证据状态
└─ 子视图 B：盘面研究（复用 ResearchTab 整套，作为 Agent 盘面输入）

在线服务 (Node/FC)
├─ /api/stock_pick        选股快照读取(GET) + Agent 精选(POST run/invalidate)
│    ├─ 召回：fetchTailPickRealtimePool 全池 → Alpha158 因子 + 规则过滤
│    ├─ 排序：读离线发布的排序模型分数（rankingBundle）；缺失则用规则召回分并标注
│    └─ Agent：盘面(market_snapshot)+资金(_stock_fund)+公告新闻(_ai_search) → 精选 + 买入策略/时机
└─ 复用：market_snapshot / sectors / board / _stock_fund / _ai_search

离线 (Python, backend/experiments + qlib-service)
└─ qlib Alpha158+LightGBM 训练 → 费后全池 walk-forward 回测 → 发布 rankingBundle(分数+指标)
```

## 纵向切片计划

- S1 信息架构：`today`→`选股`（appShell + App.jsx 子视图 + 深链归一 + 快捷键），盘面研究并入选股页子视图。旧 today 指令中心迁走/移除，持仓指令保留在持仓页。
- S2 召回服务：`/api/stock_pick` 召回层（全池扫描 + Alpha158 因子 + 规则），产出候选池 + 可解释理由 + 规则召回分。
- S3 离线排序模型：qlib Alpha158+LightGBM 训练 + 费后全池 walk-forward 回测 + 发布 rankingBundle（分数与指标）；线上消费。
- S4 Agent 精选：候选池内精选 + 买入策略/时机推断 + 证据（盘面/资金/公告新闻）；不选则展示 Top 候选供参考。
- S5 前端选股结果视图：候选、排序分、Agent 精选卡（结论/理由/策略/时机/反方/失效/证据）。
- S6 零消费者删除旧今日作战 + 候选池 Agent（先确认新链路验收、训练标签数据源已切换，再删）。
- S7 全量测试 + 构建 + FC 打包 + 文档验收记录。

## 删除边界（S6，先验收替代再删）

- 纯候选池 Agent（可删）：`api/opportunity_agent_selection.js`、`api/_opportunity_agent_selection.js`、`api/_opportunity_agent_selection_store.js`、`api/_opportunity_agent_evidence.js`、`shared/opportunityAgentSelection.js`、`src/components/OpportunityRadar*.jsx`、`OpportunityCandidateRow.jsx`、`OpportunityIntradayNav.jsx`、`src/opportunityRadarClient.js`、`src/components/TodayTab.jsx` 及对应测试。
- 需谨慎（效果账本族同时是训练标签来源）：`opportunity_radar` 聚合与 `_opportunity_radar_ledger/baseline/settlement/outcome`；删除前须确认新排序模型训练数据管道已切换来源。
- 保留（共享/基础设施）：盘面研究整套与 `market_snapshot/sectors/board`；召回源 `formula_selection/tail_pick/pre_catalyst/sector_forecast` 及 `_tail_pick_data` 全池扫描；`_stock_fund`、`_ai_search`、`_searxng_search`；`buildTodayCommandList`（持仓指令，迁至持仓页）；`AccountRiskStrip`、`marketRegime`。
