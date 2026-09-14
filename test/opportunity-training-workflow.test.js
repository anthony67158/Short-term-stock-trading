import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const exporter = read('scripts/export-opportunity-outcomes.mjs')

test('决策模型每日重训以现役版本为冠军并只发布通过验证的组合', () => {
  assert.match(workflow, /opportunity-retrain:/)
  assert.match(workflow, /download_decision_release\.py/)
  assert.match(workflow, /collect_opportunity_outcomes\.py/)
  assert.match(workflow, /decision_engine\.training\.ensemble/)
  assert.match(workflow, /decision_engine\.training\.release/)
  assert.match(
    workflow,
    /--champion opportunity-model\/champion[\s\S]*?--challenger opportunity-model\/shadow/,
  )
  assert.match(workflow, /release_decision\.json/)
  assert.match(
    workflow,
    /--directory opportunity-model\/release[\s\S]*?--release-decision opportunity-model\/release_decision\.json/,
  )
  assert.match(
    workflow,
    /publish_opportunity_training_status\.py/,
  )
})

test('没有通过选择与整体兼容性验证时不得覆盖现役决策模型', () => {
  const selectionStep = workflow.match(
    /- name: Select improved decision heads and validate the whole model([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''
  const publishStep = workflow.match(
    /- name: Publish selected decision release atomically([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''

  assert.match(selectionStep, /decision\.get\("action"\) == "PUBLISH"/)
  assert.match(
    publishStep,
    /if: steps\.opportunity-selection\.outputs\.publish == 'true'/,
  )
  assert.match(publishStep, /--activate-baseline/)
  assert.doesNotMatch(
    workflow,
    /--directory opportunity-model\/shadow[\s\S]*?--activate-baseline/,
  )
  assert.match(exporter, /opportunity-score-feature\.v5/)
})

test('复核模型每日训练只允许主板挑战者胜出现役版本后发布', () => {
  const downloadAt = workflow.indexOf('download_review_release.py')
  const trainAt = workflow.indexOf(
    'decision_engine.training.review_ensemble',
  )
  const selectAt = workflow.indexOf(
    'decision_engine.training.review_release',
  )
  const publishAt = workflow.indexOf('upload_review_model.py')
  const publishStep = workflow.match(
    /- name: Publish trigger-review ensemble atomically([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''

  assert.ok(downloadAt >= 0)
  assert.ok(trainAt > downloadAt)
  assert.ok(selectAt > trainAt)
  assert.ok(publishAt > selectAt)
  assert.match(
    workflow,
    /decision\.get\("action"\) == "PUBLISH"/,
  )
  assert.match(
    publishStep,
    /if: steps\.review-selection\.outputs\.publish == 'true'/,
  )
  assert.match(
    publishStep,
    /--release-decision opportunity-model\/review-release-decision\.json/,
  )
  assert.match(
    workflow,
    /review_bakeoff[\s\S]*?--feature-schema v4/,
  )
  assert.match(
    workflow,
    /review_ensemble[\s\S]*?--feature-schema v4/,
  )
  assert.match(workflow, /tests\/test_review_release\.py/)
  assert.match(workflow, /tests\/test_review_schema_migration\.py/)
})

test('Alpha158每日生成V4连续特征快照且失败不阻断主训练', () => {
  const job = workflow.split('  opportunity-retrain:')[1]
    ?.split('\n  market-data-archive:')[0] || ''
  const alphaStep = job.match(
    /- name: Train and publish Alpha158 continuous feature snapshot([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''

  assert.match(alphaStep, /continue-on-error: true/)
  assert.match(alphaStep, /alpha158_market_history\.py/)
  assert.match(
    alphaStep,
    /decision_engine\.training\.alpha158_mainboard/,
  )
  assert.match(alphaStep, /--top-n 1000/)
  assert.match(alphaStep, /alpha158_snapshot\.py/)
  assert.match(alphaStep, /--publish/)
  assert.match(workflow, /tests\/test_alpha158_snapshot\.py/)
})

test('每日重训把新成熟结果压实进版本化历史基线', () => {
  const collectAt = workflow.indexOf('python collect_opportunity_outcomes.py')
  const compactAt = workflow.indexOf('python publish_opportunity_history.py')
  const trainAt = workflow.indexOf(
    'python -m decision_engine.training.ensemble',
  )

  assert.ok(collectAt >= 0)
  assert.ok(compactAt > collectAt)
  assert.ok(trainAt > compactAt)
  assert.match(
    workflow.slice(compactAt, trainAt),
    /--input opportunity-outcomes\.json/,
  )
})

test('市场归档强制使用QUANT_KEY且不再依赖Tushare', () => {
  const archive = workflow.split('  market-data-archive:')[1] || ''

  assert.match(
    archive,
    /for name in \\\s*QUANT_KEY \\\s*OSS_ACCESS_KEY_ID/,
  )
  assert.match(archive, /validate_market_archive_report\.py/)
  assert.match(archive, /market-archive-validation\.json/)
  assert.doesNotMatch(archive, /REUSED_EXISTING_ARCHIVE/)
  assert.match(archive, /X-API-Key: \$QUANT_KEY/)
  assert.doesNotMatch(archive, /archive_tushare_market_day/)
  assert.doesNotMatch(archive, /TUSHARE_TOKEN/)
})

test('辅助模型异常会留审计但不再拖垮决策模型主训练状态', () => {
  const stock = workflow.split('  stock-retrain:')[1]
    ?.split('\n  opportunity-retrain:')[0] || ''

  assert.match(stock, /continue-on-error: true/)
  assert.match(stock, /id: stock-training/)
  assert.match(stock, /Record auxiliary retrain failure/)
  assert.match(stock, /stage.*github-actions/)
  assert.match(stock, /\("失败阶段", rec\.get\("stage", "-"\)\)/)
  assert.match(stock, /\("错误详情", rec\.get\("error", "-"\)\)/)
})
