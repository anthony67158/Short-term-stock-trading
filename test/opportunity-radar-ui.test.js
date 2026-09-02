import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  opportunityRadarClientError,
  refreshOpportunityRadar,
} from '../src/opportunityRadarClient.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const today = read('src/components/TodayTab.jsx')
const radar = read('src/components/OpportunityRadar.jsx')
const content = read('src/components/OpportunityRadarContent.jsx')
const candidate = read('src/components/OpportunityCandidateRow.jsx')
const opportunityUi = `${content}\n${candidate}`
const client = read('src/opportunityRadarClient.js')
const styles = read('src/styles/precision.css')

test('今日决策只挂载一个机会雷达模块', () => {
  assert.match(today, /import OpportunityRadar from '\.\/OpportunityRadar'/)
  assert.match(today, /<OpportunityRadar/)
  assert.doesNotMatch(today, /<SectorForecast/)
  assert.doesNotMatch(today, /<FormulaSelection/)
})

test('机会雷达提供提前布局盘中机会和次日计划三个视图', () => {
  assert.match(radar, /提前布局/)
  assert.match(radar, /盘中机会/)
  assert.match(radar, /次日计划/)
  assert.match(radar, /role="tablist"/)
  assert.match(radar, /aria-selected=/)
  assert.match(radar, /loadOpportunityRadar/)
})

test('机会候选同时展示入场仓位和完整退出计划', () => {
  assert.match(opportunityUi, /entryPlan/)
  assert.match(opportunityUi, /exitPlan/)
  assert.match(opportunityUi, /买入条件/)
  assert.match(opportunityUi, /止损/)
  assert.match(opportunityUi, /止盈/)
  assert.match(opportunityUi, /时间退出/)
  assert.match(opportunityUi, /最大仓位/)
  assert.match(opportunityUi, /加入自选/)
  assert.match(opportunityUi, /openStockDetail/)
  assert.match(opportunityUi, /为什么能买/)
  assert.match(content, /plannedRows/)
  assert.match(content, /当前没有形成完整买卖计划的股票/)
  assert.match(content, /尚无完整价格，不代表可以买入/)
})

test('机会雷达显示真实来源状态和局部失败', () => {
  assert.match(content, /sourceStatus/)
  assert.match(content, /failed/)
  assert.match(content, /stale/)
  assert.match(radar, /role="status"/)
  assert.match(radar, /aria-busy=/)
})

test('统一客户端使用聚合接口并保留独立来源刷新', () => {
  assert.match(client, /\/api\/opportunity_radar/)
  assert.match(client, /sectorForecastRequest/)
  assert.match(client, /runFormulaSelection/)
  assert.match(client, /Promise\.allSettled/)
  assert.equal(
    opportunityRadarClientError({ status: 503 }),
    '机会数据暂时不可用，请稍后重试',
  )
})

test('盘中刷新并行启动板块和盘中公式且局部失败可返回', async () => {
  const started = []
  const resolvers = []
  const deferred = (name, failure = null) => () => new Promise(
    (resolve, reject) => {
      started.push(name)
      resolvers.push(() => failure ? reject(failure) : resolve({ ok: true }))
    },
  )
  const pending = refreshOpportunityRadar({
    lane: 'intraday',
    snapshot: {
      phase: 'INTRADAY',
      sourceStatus: {},
    },
    runSector: deferred('sector'),
    runFormula: deferred('formula', new Error('公式失败')),
    runTail: deferred('tail'),
    load: async () => ({ ok: true, lanes: {} }),
  })

  await Promise.resolve()
  assert.deepEqual(started.sort(), ['formula', 'sector'])
  resolvers.forEach((resolve) => resolve())
  const result = await pending
  assert.deepEqual(result.completed, ['sector'])
  assert.deepEqual(result.failed, ['formulaIntraday'])
})

test('盘前次日计划只复核隔夜板块证据', async () => {
  const calls = []
  await refreshOpportunityRadar({
    lane: 'next',
    snapshot: {
      phase: 'PREOPEN',
      sourceStatus: {},
    },
    runSector: async (session) => calls.push(['sector', session]),
    runFormula: async (mode) => calls.push(['formula', mode]),
    runTail: async () => calls.push(['tail']),
    load: async () => ({ ok: true, lanes: {} }),
  })
  assert.deepEqual(calls, [['sector', 'overnight']])
})

test('机会雷达使用单层响应式布局', () => {
  assert.match(styles, /\.opportunity-radar\s*{/)
  assert.match(styles, /\.opportunity-radar-list\s*{/)
  assert.match(styles, /\.opportunity-row\s*{/)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.opportunity-row\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
  assert.doesNotMatch(radar, /className="panel[^"]*panel/)
})
