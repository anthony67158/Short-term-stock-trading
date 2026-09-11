import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const exporter = read('scripts/export-opportunity-outcomes.mjs')

test('V3每日重训以现役版本为冠军并只发布通过验证的组合', () => {
  assert.match(workflow, /opportunity-retrain:/)
  assert.match(workflow, /download_opportunity_release\.py/)
  assert.match(workflow, /collect_opportunity_outcomes\.py/)
  assert.match(workflow, /train_opportunity_seed_ensemble\.py/)
  assert.match(workflow, /select_opportunity_release\.py/)
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

test('没有通过选择与整体兼容性验证时不得覆盖现役V3', () => {
  const selectionStep = workflow.match(
    /- name: Select improved V3 components and validate the whole model([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''
  const publishStep = workflow.match(
    /- name: Publish selected V3 release atomically([\s\S]*?)(?=\n      - name:)/,
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

test('每日重训把新成熟结果压实进版本化历史基线', () => {
  const collectAt = workflow.indexOf('python collect_opportunity_outcomes.py')
  const compactAt = workflow.indexOf('python publish_opportunity_history.py')
  const trainAt = workflow.indexOf(
    'python train_opportunity_seed_ensemble.py',
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
  assert.match(archive, /继续使用现有OSS市场归档/)
  assert.match(archive, /X-API-Key: \$QUANT_KEY/)
  assert.doesNotMatch(archive, /archive_tushare_market_day/)
  assert.doesNotMatch(archive, /TUSHARE_TOKEN/)
})

test('辅助模型异常会留审计但不再拖垮V3主训练状态', () => {
  const stock = workflow.split('  stock-retrain:')[1]
    ?.split('\n  opportunity-retrain:')[0] || ''

  assert.match(stock, /continue-on-error: true/)
  assert.match(stock, /id: stock-training/)
  assert.match(stock, /Record auxiliary retrain failure/)
  assert.match(stock, /stage.*github-actions/)
  assert.match(stock, /\("失败阶段", rec\.get\("stage", "-"\)\)/)
  assert.match(stock, /\("错误详情", rec\.get\("error", "-"\)\)/)
})
