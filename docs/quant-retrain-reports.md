# 每日量化重训汇报

周一至周六北京时间 01:15 的 `daily-retrain.yml` 运行训练，周六凌晨处理
周五收盘数据，周一保留为既有补齐时段。定时表达式为 UTC `15 17 * * 0-5`。
增量指合并历史基线与新增成熟结果后重训挑战者，不是直接在旧权重上续训；
原始收盘行情先归档，尚未成熟的结果不得充当训练标签。

以下为各模型的汇报存储约定（站内入口只展示决策模型）：

- 个股模型：保留 `publish_retrain_report.py` 的现有汇报与旧历史记录。
- V3 机会模型：`publish_model_retrain_report.py --model opportunity`。
- 板块模型：`publish_model_retrain_report.py --model sector`。

## 存储与状态

新记录按 `quantreport/<model>-<GITHUB_RUN_ID>.json` 写入 OSS，同模型重跑覆盖
本轮记录；同一轮不同模型不会相互覆盖或去重。每条记录保留运行链接、
训练时点、运行状态、样本事实、样本外指标及未通过原因。

发布步骤使用 `if: always()`。数据不足、数据源跳过、取消、运行失败和
缺失/损坏的训练报告均产生明确状态，不把“脚本执行成功”当作“晋级成功”。
V3 直接发布回执记为“已更新”，保留未通过的评测指标，不标记为通过晋级；
只有同时具备晋级通过和合格模型上传成功回执才显示合格发布。板块发布必须
同时具备 `promoted=true` 和 `uploaded=true`。汇报过程不改变模型或晋级阈值。

## 展示

`GET /api/quant_report` 聚合历史汇报、GitHub 运行态，以及 OSS 中最新 V3
训练状态。现有状态快照只显示实际保存的字段，不补造历史评估指标。

量化汇报支持全部/V3/个股/板块筛选，默认展开当前列表首条结果。打开时刷新，
可见页面每 30 秒更新；加载错误保留已有记录。请求有 15 秒超时，
缺失数值显示“未提供”，负净R保留原始符号。

V3 的 Top5 正净R信号占比包括未成交信号，不等于成交后的盈利率，
也不代表真实账户收益。清空历史需要确认；删除失败保留记录并提示。

## 验收

- `node --test test/quant-model-reports.test.js test/quant-retrain-report.test.js`
- `python3 -m unittest discover -s qlib-service/tests -p test_publish_model_retrain_report.py`
- `scripts/verify-quant-report.mjs`：本地隔离接口，320/768/1024/1440 宽度，
  明暗主题，筛选、指标、详情、错误、清空、焦点与无溢出检查。

前端与 API 修改必须同步部署 Vercel 和阿里云 FC；Actions 更新需推送 GitHub。
