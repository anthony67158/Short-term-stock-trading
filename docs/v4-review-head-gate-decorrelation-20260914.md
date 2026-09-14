# v4 复核头接入 + 冠亚门禁 + 组合去相关 + alpha rankIc 交付验收（2026-09-14）

> 本文记录“让 v4 正式过门槛”后续四项的落地与**诚实**验证结果。延续
> `profitability-v4-final-summary-20260914.md` 的纪律：日线近似口径 ≠ 生产分钟链路，
> 门槛未全通过前不提升生产仓位、不改 V3 生产链路。

## 交付范围（对应用户四项要求）

1. **跨折岭回归 → v4 复核头（176 维）接入 `review_ensemble`**（Task10）
2. **v4 冠军挑战者门禁与一致性校验**（Task11）
3. **组合层强制低相关去重压回撤**（Task12）
4. **补齐 alpha rankIc 维度**（Task9，已在前序完成，本次复验）

## 1. v4 复核头接入训练管线（Task10）

“v4 复核头（176 维）”= 现有 3 种子 CatBoost 复核集成在 **v4 特征合同**下的实例化，
而非把临时岭回归当成生产头。岭回归只是 R4/R5 的**排序能力探针**（
`scripts/validate-v4-model-crossfold.mjs`），证明 alpha 块可跨折外推；生产复核头
仍是 `review_ensemble` 的 7 头 CatBoost 集成，本次让它可在 v4 176 维下训练。

改动（v3 默认逐位不变，v4 仅显式 `feature_schema="v4"` 选用）：

- `qlib-service/decision_engine/training/review_dataset.py`
  - `build_opportunity_review_dataset(outcomes, *, feature_schema="v3")`；
    v4 时用 `FEATURE_NAMES_V4`(176)/`feature_vector_v4`，输出附 `feature_schema`。
- `qlib-service/decision_engine/training/review_bakeoff.py`
  - `load_dataset(path, *, feature_schema="v3")` 透传。
- `qlib-service/decision_engine/training/review_ensemble.py`
  - `REVIEW_FEATURE_SCHEMAS` + `_resolve_feature_schema()`；
  - `_feature_support(matrix, feature_names, missing_indices)` 参数化；
  - `train_review_ensemble(..., feature_schema="v3")`：artifact/metadata 的
    `featureSchemaVersion`/`featureNames`/`featureSupport` 全部跟随解析结果；
  - CLI 新增 `--feature-schema {v3,v4}`（默认 v3）。
- `qlib-service/decision_engine/review_registry.py`
  - `validate_review_metadata(metadata, *, feature_schema=FEATURE_SCHEMA_VERSION)`、
    `load_review_release(..., feature_schema=...)`、`_valid_feature_support(value, names)`
    参数化；新增 `REVIEW_FEATURE_SCHEMAS={v3,v4}` 白名单。
  - **生产热加载/清单（`_download_release`/`validate_review_manifest`）仍锁 v3**，
    v4 不会因文件合法就被线上加载——这是硬安全边界。

验证：`tests/test_decision_review_training.py` 新增
`test_default_feature_schema_is_v3` / `test_v4_feature_schema_propagates_to_artifact_and_metadata`
/ `test_resolve_feature_schema_rejects_unknown`；全套 review 测试 50 项通过，
Python 全量 308 项通过。v3 训练产物与改动前逐位一致。

> **数据口径诚实说明**：`~/.mainboard-5y/v4-training-samples.jsonl`(29.4 万条) 只含
> 8 维 alpha 块 + 净R（日线近似），**不含** 168 维 v3 触价/初始特征——后者需要
> 生产分钟级触价观察路径，5 年历史不可得。因此 v4 复核头的**端到端 176 维训练**
> 需在生产成熟 outcome（含 `reviewScoreInput.factors` 全 176 维）上跑；本次交付的是
> **可训练、可门禁、v3 零污染**的完整管线，不是伪造的 176 维日线训练结论。

## 2. v4 冠军挑战者门禁（Task11）

- `review_release.py`：`_load_bundle` 先探测 `featureSchemaVersion` 再按对应合同严格加载；
  `select_review_release` 先载双方 bundle，再按**挑战者合同**装配数据集，
  仅当冠亚合同一致时进入同窗评估；不一致直接门禁 `KEEP_CURRENT`。
  决策 JSON 增记 `championFeatureSchemaVersion`/`challengerFeatureSchemaVersion`。
- `upload_review_model.py`：`_load_validated_metadata` 按元数据声明的 schema 校验，
  使 `--record-only` 对 v4 挑战者也不崩；发布裁决闸门 `validate_release_decision` 不变。

**核心安全属性（有测试）**：v4 挑战者对 v3 现役冠军 → “现役模型与挑战者特征合同不一致”
→ `KEEP_CURRENT`，**绝不覆盖生产 v3 清单**；v4-vs-v4 才允许同窗评估与晋级。
新增 `test_v4_challenger_publishes_against_v4_champion`、
`test_v4_challenger_blocked_against_v3_champion`。

日切工作流 `.github/workflows/daily-retrain.yml` 不带 `--feature-schema`，
默认 v3；v4 保持显式 opt-in，未过门槛前不进 CI 默认路径。

## 3. 组合层强制低相关去重压回撤（Task12）

日线 v4 样本无题材/板块标签，`shared/lowCorrelationSelection.js`(Jaccard) 在此会退化为
空集去重（等于没做），故新增**基于入场前收益相关性**的同类去重器（同一思想、
不同数据可得性）：

- `shared/portfolioCorrelationSelection.js`：`pearsonCorrelation` +
  `selectLowCorrelationBook(candidates, held, {maxCorrelation, maxHoldings, roomForNew})`，
  贪心把并发持仓的 |皮尔逊相关| 压到阈值以下。**严格无前视**：相关性只用
  signalDate 及之前的 trailing 收益。
- `scripts/enrich-v4-trailing-returns.py`：从 5 年日线补每样本 20 日 trailing 收益
  （29.36 万/29.38 万成功，仅 236 缺失）。
- `scripts/replay-v4-portfolio-decorrelated.mjs`：在基线回放上叠加去相关，其余口径不变，
  可比地量化去相关对回撤的影响。

**受控对照结果（同参、仅改 maxCorrelation）**：

| 配置 | fold | maxCorr | 回撤% | 收益% | meanR |
|---|---|---|---|---|---|
| 高并发 maxConc=40, risk0.8%, top5 | 3 | 关(1.0) | **71.23** | −35.02 | 0.053 |
| 同上 | 3 | 0.7 | **60.23** | +28.22 | 0.100 |
| 保守 maxConc=12, risk0.5%, top4, minPct0.85 | 1(熊) | 关(1.0) | 45.98 | −44.99 | −0.314 |
| 同上 | 1(熊) | 0.6 | **36.73** | −36.73 | −0.241 |
| 同上 | 2 | 关(1.0) | 20.59 | +28.67 | 0.203 |
| 同上 | 2 | 0.6 | 22.76 | +19.14 | 0.163 |
| 同上 | 3 | 关(1.0) | 27.93 | −12.57 | −0.052 |
| 同上 | 3 | 0.6 | **22.33** | −14.09 | −0.067 |

**诚实结论**：去相关在高并发（相关性聚集最严重）时效果巨大（回撤 71→60，收益转正）；
保守配置下 fold1/fold3 回撤明显下降（46→37、28→22），fold2 有轻微收益让渡。
这是一个**真实、跨 regime 成立**的回撤控制杠杆，不是单折挑选。注意上表是按
**alpha 分位追高**（已知偏弱的选股法）的组合，绝对收益仍差——这与“去相关能否压回撤”
是两个独立问题，去相关的边际贡献已被单变量对照证实。

## 4. alpha rankIc 维度（Task9 复验）

`~/.mainboard-5y/v4-crossfold.json` 用当前 5 特征脚本重算：
testIC 0.0851、**testRankIC 0.2275**、单调 8/9、top-bottom spread **0.5813**
（3 特征时 spread 0.281 → 加 rankIc 两维后翻倍），证明 rankIc 有实质增益。

## 相对目标的诚实定位（10-20%/回撤≤10%/70%）

- **排序能力**：跨折 RankIC 0.20-0.23 稳定，方向正确。
- **回撤控制**：去相关是有效杠杆，但按 alpha 追高的组合绝对收益/回撤仍不达标；
  达标依赖“v4 复核头按预测净R选股 + 去相关 + 保守仓位”的**联合**效果，且需在
  **生产 176 维成熟 outcome** 上训练验证。
- **未夸大**：日线近似 ≠ 生产分钟链路；门槛未全通过前不提升生产仓位、不改 V3 生产。

## 测试与回归

- Python：`qlib-service/tests/` 全量 **308 passed**（含 review 50、v4 契约、门禁）。
- JS：`test/portfolio-correlation-selection.test.js`(4)、`test/v4-crossfold-validate.test.js`(1) 通过；
  修正了跨折验证测试用例以匹配 Task9 后的 5 特征脚本。
- 数据资产（不入库）：`~/.mainboard-5y/v4-trailing-returns.jsonl`、刷新后的 `v4-crossfold.json`。
