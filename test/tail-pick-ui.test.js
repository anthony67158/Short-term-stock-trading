import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const today = read('src/components/TodayTab.jsx')
const formulaSelection = read('src/components/FormulaSelection.jsx')
const component = read('src/components/TailPick.jsx')
const progress = read('src/components/FormulaSelectionProgress.jsx')
const candidate = read('src/components/TailPickCandidate.jsx')
const results = read('src/components/TailPickResults.jsx')
const client = read('src/tailPickClient.js')
const styles = read('src/styles/precision.css')

test('尾盘拾金位于板块前瞻和普通候选池之间', () => {
  assert.match(today, /import FormulaSelection from '\.\/FormulaSelection'/)
  assert.match(formulaSelection, /import TailPick from '\.\/TailPick'/)
  assert.ok(
    today.indexOf('<SectorForecast') < today.indexOf('<FormulaSelection'),
  )
  assert.ok(
    today.indexOf('<FormulaSelection') < today.indexOf('<CandidatePool'),
  )
})

test('尾盘拾金支持14:50自动正式扫描和手动试算', () => {
  assert.match(component, /runTailPick/)
  assert.match(component, /14:50 自动正式扫描/)
  assert.match(component, /随时手动试算/)
  assert.match(component, /15_000/)
  assert.match(component, /读取大盘环境/)
  assert.match(component, /扫描公式信号/)
  assert.match(component, /汇总风险指标/)
  assert.match(component, /整理计算结果/)
  assert.match(component, /FormulaSelectionProgress/)
  assert.match(progress, /role="progressbar"/)
  assert.match(component, /session\.canRun/)
})

test('结果展示完整计算依据且只写入人工观察计划', () => {
  assert.match(candidate, /首选观察/)
  assert.match(candidate, /候补/)
  assert.match(candidate, /接近公式/)
  assert.match(candidate, /passedCount/)
  assert.match(candidate, /totalRuleCount/)
  assert.match(candidate, /加入尾盘计划/)
  assert.match(candidate, /加入自选/)
  assert.match(component, /planStore\.addPlan/)
  assert.doesNotMatch(component, /planStore\.buy/)
  assert.doesNotMatch(component, /accountCircuitBreaker/)
  assert.doesNotMatch(results, /唯一操作：今天不新开仓/)
  assert.match(results, /市场环境参考/)
  assert.match(results, /接近公式计算结果/)
  assert.match(results, /完整展示缺失条件与风险项/)
  assert.match(results, /计算结果仅供判断，不自动下单/)
})

test('尾盘接口携带账号令牌、幂等键和明确超时', () => {
  assert.match(client, /accountRequestHeaders/)
  assert.match(client, /AbortController/)
  assert.match(client, /tail-pick:\$\{tradeDate\}:manual:/)
  assert.match(client, /REQUEST_TIMEOUT/)
  assert.match(client, /15_000/)
  assert.match(component, /isActiveTailPickTask/)
  assert.match(component, /submitted\?\.running === true/)
})

test('尾盘结果在移动端改为单列且操作按钮不溢出', () => {
  assert.match(styles, /\.tail-pick-row\s*{/)
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.tail-pick-row\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  )
  assert.match(
    styles,
    /\.tail-pick-row > button\s*{[\s\S]*width:\s*132px/,
  )
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.tail-pick-row > button\s*{[\s\S]*width:\s*100%/,
  )
  assert.match(styles, /\.tail-pick-row\[data-role="near"\]/)
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.tail-pick-near-head/,
  )
})
