# Tasks: 盈利能力 V3 五项改造

依赖：[规格](./trading-engine-profitability-v3-spec.md)。
状态：改造项3核心已落地（默认恒等），项1-2由并行会话进行中，项4待实施，项5数据阻断。

## 改造项3：费后机会奖励（直接优化账户收益）

- [x] Task 3.1 费后奖励纯函数 + 惩罚项（换手/最低佣金/资金占用/尾部）
  - Acceptance：默认全0时返回原始 netR；各惩罚单调、缺失降级。
  - Verify：`/private/tmp/qenv/bin/python -m unittest tests.test_opportunity_reward`（9/9）
  - Files：`opportunity_reward.py`、`tests/test_opportunity_reward.py`
- [x] Task 3.2 接入 `y_opportunity_r`，默认恒等
  - Acceptance：`test_decision_review_dataset` 仍为 `[1.2, 0.0]`。
  - Verify：`unittest tests.test_decision_review_dataset`（通过）
  - Files：`review_dataset.py`
- [ ] Task 3.3 离线搜索惩罚系数并作为挑战者训练（不改默认，不旁路门禁）
  - Acceptance：给出使 10bps 正收益、净R下界≥0.02R 的系数；未达标 KEEP_CURRENT。
  - Verify：`review_release.py` 冠军挑战者门禁 + 10万账户 5/10bps 回放。

## 改造项1-2：Alpha158 连续特征 + 六打法分层联合排序

- [~] 并行会话进行中（`接入Alpha158连续信号联合排序`、`将联合排序贯穿人工成交学习`
  已提交；另有大量未提交改动）。本 spec 不重复实现。
- [ ] Task 1.1 验收：确认 Alpha158 仅作连续特征，无 Top50 硬过滤回归。
- [ ] Task 2.1 分层评估口径：按打法/路径输出成交数、净R下界、相关性去重后有效机会数，
  目标年化 120-160 笔。

## 改造项4：独立退出模型

- [ ] Task 4.1 退出数据集：从成熟成交提取 持有/部分减仓/全部退出 的反事实动作价值，
  四段时间隔离，禁止未来信息；硬止损不进入模型样本。
- [ ] Task 4.2 退出动作价值头 + 单测；接入 `holding-exit` 复核，账本硬止损独立执行。
- [ ] Task 4.3 冠军挑战者门禁评估，未提升则 KEEP_CURRENT。

## 改造项5：跨市场 3-5 年数据（数据阻断）

- [ ] BLOCKED：本地仅 260 交易日（2025-08-18→2026-09-11），每日训练禁用 Tushare。
  需单独授权数据源与人工历史回填窗口，并划出完全未调参的年度测试集。
  在数据到位前，任何“年度稳定性/70% 概率”结论都不得基于 260 日样本给出。
