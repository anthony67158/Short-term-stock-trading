import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const today = read('src/components/TodayTab.jsx')
const component = read('src/components/TailPick.jsx')
const candidate = read('src/components/TailPickCandidate.jsx')
const results = read('src/components/TailPickResults.jsx')
const client = read('src/tailPickClient.js')
const styles = read('src/styles/precision.css')

test('尾盘拾金位于板块前瞻和普通候选池之间', () => {
  assert.match(today, /import TailPick from '\.\/TailPick'/)
  assert.ok(today.indexOf('<SectorForecast') < today.indexOf('<TailPick'))
  assert.ok(today.indexOf('<TailPick') < today.indexOf('<CandidatePool'))
})

test('尾盘拾金支持14:50自动正式扫描和手动试算', () => {
  assert.match(component, /runTailPick/)
  assert.match(component, /14:50 自动正式扫描/)
  assert.match(component, /随时手动试算/)
  assert.match(component, /15_000/)
  assert.match(component, /确认开仓环境/)
  assert.match(component, /扫描公式信号/)
  assert.match(component, /执行纪律过滤/)
  assert.match(component, /生成最终顺序/)
  assert.match(component, /role="progressbar"/)
  assert.match(component, /session\.canRun/)
})

test('结果明确区分首选候补且只写入人工观察计划', () => {
  assert.match(candidate, /首选观察/)
  assert.match(candidate, /候补/)
  assert.match(candidate, /加入尾盘计划/)
  assert.match(candidate, /加入自选/)
  assert.match(component, /planStore\.addPlan/)
  assert.doesNotMatch(component, /planStore\.buy/)
  assert.match(results, /唯一操作：今天不新开仓/)
  assert.match(results, /尚未通过分钟级样本外回测，不自动下单/)
})

test('尾盘接口携带账号令牌、幂等键和明确超时', () => {
  assert.match(client, /accountRequestHeaders/)
  assert.match(client, /AbortController/)
  assert.match(client, /tail-pick:\$\{tradeDate\}:manual:/)
  assert.match(client, /尾盘选股超过45秒/)
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
})
