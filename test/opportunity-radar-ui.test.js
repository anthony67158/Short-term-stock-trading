import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  opportunityRadarAutoRefreshDelay,
  opportunityRadarClientError,
  refreshOpportunityRadar,
  refreshTailOpportunity,
} from '../src/opportunityRadarClient.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const today = read('src/components/TodayTab.jsx')
const radar = read('src/components/OpportunityRadar.jsx')
const content = read('src/components/OpportunityRadarContent.jsx')
const intradayNav = read('src/components/OpportunityIntradayNav.jsx')
const candidate = read('src/components/OpportunityCandidateRow.jsx')
const opportunityUi = `${content}\n${intradayNav}\n${candidate}`
const client = read('src/opportunityRadarClient.js')
const styles = read('src/styles/precision.css')
const deployment = read('s.yaml')

test('今日决策只挂载一个机会雷达模块', () => {
  assert.match(today, /import OpportunityRadar from '\.\/OpportunityRadar'/)
  assert.match(today, /<OpportunityRadar/)
  assert.doesNotMatch(today, /<SectorForecast/)
  assert.doesNotMatch(today, /<FormulaSelection/)
})

test('机会雷达只提供盘中机会和次日关注计划两个业务入口', () => {
  assert.match(radar, /盘中机会/)
  assert.match(radar, /次日关注计划/)
  assert.doesNotMatch(radar, /id:\s*'layout'/)
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
  assert.match(content, /只有同时给出入场价/)
  assert.match(opportunityUi, /成交率/)
  assert.match(opportunityUi, /净盈利率/)
  assert.match(opportunityUi, /样本仍在积累/)
  assert.match(opportunityUi, /启动观察分/)
  assert.match(opportunityUi, /尚未定价/)
  assert.match(opportunityUi, /资金试探/)
  assert.match(opportunityUi, /opportunity-event-link/)
  assert.match(opportunityUi, /<Icon name="news" size=\{12\} \/>/)
  assert.match(
    styles,
    /\.opportunity-event-link\s*{[^}]*display:\s*grid[^}]*width:\s*100%/s,
  )
  assert.match(candidate, /className="opportunity-model-pending"/)
  assert.match(
    styles,
    /\.opportunity-context \.opportunity-model-pending\s*\{[\s\S]*grid-template-columns:\s*12px minmax\(0,\s*1fr\)/,
  )
})

test('尾盘严格与接近公式在盘中页使用独立区段展示', () => {
  assert.match(content, /strictTailRows/)
  assert.match(content, /tailWatchRows/)
  assert.match(content, /title:\s*'尾盘反转'/)
  assert.match(content, /今日严格公式未完整命中/)
  assert.match(content, /仅供核对，不可直接买入/)
})

test('盘中机会明确拆分立即买入提前布局和尾盘反转', () => {
  assert.match(content, /可立即买入/)
  assert.match(content, /今日提前布局/)
  assert.match(content, /尾盘反转/)
  assert.match(content, /activeIntradayView/)
  assert.match(content, /activeIntradayRows/)
  assert.match(content, /当前查看/)
  assert.match(intradayNav, /aria-label="盘中机会分类"/)
  assert.match(intradayNav, /role="tab"/)
  assert.match(intradayNav, /count/)
  assert.match(intradayNav, /条件全部通过/)
  assert.match(intradayNav, /等待触发或风险解除/)
  assert.match(intradayNav, /14:50自动扫描/)
  assert.doesNotMatch(content, /rows={readyRows}[\s\S]*rows={layoutRows}/)
  assert.doesNotMatch(content, /方向观察/)
  assert.doesNotMatch(candidate, /方向可看/)
})

test('已算出计划但大盘不支持时仍展示计划并说明为什么先不买', () => {
  assert.match(content, /已算出计划但本次不买/)
  assert.match(candidate, /为什么先不买/)
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
  assert.match(client, /runPreCatalyst/)
  assert.match(client, /Promise\.allSettled/)
  assert.equal(
    opportunityRadarClientError({ status: 503 }),
    '机会数据暂时不可用，请稍后重试',
  )
})

test('预催化来源并入提前布局且展示独立运行状态', () => {
  assert.match(content, /preCatalyst: '预催化发现'/)
  assert.match(content, /\['sector', 'formulaIntraday', 'preCatalyst', 'tail'\]/)
  assert.match(content, /包含预催化潜伏与公式候选/)
  assert.match(radar, /preCatalyst: '预催化发现'/)
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
    runPreCatalystScan: deferred('preCatalyst'),
    runTail: deferred('tail'),
    load: async () => ({ ok: true, lanes: {} }),
  })

  await Promise.resolve()
  assert.deepEqual(
    started.sort(),
    ['formula', 'preCatalyst', 'sector'],
  )
  resolvers.forEach((resolve) => resolve())
  const result = await pending
  assert.deepEqual(result.completed.sort(), ['preCatalyst', 'sector'])
  assert.deepEqual(result.failed, ['formulaIntraday'])
})

test('盘前次日关注只读昨晚计划且不启动生成任务', async () => {
  const calls = []
  await refreshOpportunityRadar({
    lane: 'next',
    snapshot: {
      phase: 'PREOPEN',
      sourceStatus: {},
    },
    runSector: async (session) => calls.push(['sector', session]),
    runFormula: async (mode) => calls.push(['formula', mode]),
    runPreCatalystScan: async () => calls.push(['preCatalyst']),
    runTail: async () => calls.push(['tail']),
    load: async () => ({ ok: true, lanes: {} }),
  })
  assert.deepEqual(calls, [])
})

test('收盘后次日关注只手动运行收盘板块和收盘公式', async () => {
  const calls = []
  await refreshOpportunityRadar({
    lane: 'next',
    snapshot: {
      phase: 'AFTER_CLOSE',
      sourceStatus: {},
    },
    runSector: async (session) => calls.push(['sector', session]),
    runFormula: async (mode) => calls.push(['formula', mode]),
    runPreCatalystScan: async () => calls.push(['preCatalyst']),
    runTail: async () => calls.push(['tail']),
    load: async () => ({ ok: true, lanes: {} }),
  })
  assert.deepEqual(calls.sort(), [
    ['formula', 'close'],
    ['preCatalyst'],
    ['sector', 'close'],
  ])
})

test('尾盘手动扫描使用独立入口且完成后重新读取聚合快照', async () => {
  const calls = []
  const result = await refreshTailOpportunity({
    snapshot: {
      tailSession: {
        canRun: true,
        tradeDate: '2026-09-03',
      },
    },
    runTail: async (tradeDate) => calls.push(['tail', tradeDate]),
    load: async () => {
      calls.push(['load'])
      return { ok: true, lanes: {} }
    },
  })
  assert.deepEqual(calls, [
    ['tail', '2026-09-03'],
    ['load'],
  ])
  assert.equal(result.ok, true)
})

test('次日计划按定时源状态自动等待或追踪最新结果', () => {
  const now = Date.parse('2026-09-03T14:45:00+08:00')
  assert.equal(opportunityRadarAutoRefreshDelay({
    sourceStatus: {
      tail: {
        status: 'scheduled',
        refreshAt: now + 5 * 60 * 1000,
      },
    },
    tasks: {},
  }, now), 5 * 60 * 1000)
  assert.equal(opportunityRadarAutoRefreshDelay({
    sourceStatus: {
      tail: {
        status: 'running',
        refreshAfterMs: 2_500,
      },
    },
    tasks: {},
  }, now), 2_500)
  assert.equal(opportunityRadarAutoRefreshDelay({
    sourceStatus: {
      tail: { status: 'fresh' },
      formulaClose: { status: 'fresh' },
    },
    tasks: {},
  }, now), null)
  assert.match(radar, /opportunityRadarAutoRefreshDelay/)
  assert.match(content, /待生成|更新中|等待结果/)
})

test('收盘公式只保留手动运行且尾盘14:50自动任务继续启用', () => {
  assert.doesNotMatch(deployment, /triggerName:\s*formula-selection-close-timer/)
  assert.match(deployment, /triggerName:\s*tail-pick-1450-timer/)
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

test('机会雷达展示组合层去重与风险预算但不改个股结论', () => {
  // 消费后端 portfolios 字段
  assert.match(content, /portfolios/)
  // 组合概览展示预算占用与独立机会数
  assert.match(content, /风险预算|独立机会|已纳入/)
  // 候选行接收只读组合提示，通过 code 映射而非改写 state
  assert.match(content, /portfolioState|portfolioReason|portfolioNote/)
  assert.match(candidate, /portfolioState|portfolioReason|portfolioNote/)
  // 板块集中/预算受限提示文案
  assert.match(candidate, /板块|预算|集中/)
  // 组合视图不写回个股 state：仍以 opportunity.state 驱动主状态
  assert.match(candidate, /STATE_VIEW\[opportunity\.state\]/)
})

test('漂移检出时展示只读预警且样本不足时不显示噪音', () => {
  // 仅在 DRIFT_DETECTED 时提示
  assert.match(content, /DRIFT_DETECTED/)
  assert.match(content, /drift/)
  // 预警文案与只读语义
  assert.match(content, /漂移|回报|复核/)
})

test('组合与漂移使用统一设计token而非独立视觉体系', () => {
  assert.match(styles, /\.opportunity-portfolio-bar\s*{/)
  assert.match(styles, /\.opportunity-drift\s*{/)
  // 复用现有表面/边框/间距 token
  assert.match(
    styles,
    /\.opportunity-portfolio-bar\s*{[^}]*var\(--color-rule-2\)/s,
  )
})
