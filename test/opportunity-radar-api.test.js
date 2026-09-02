import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  readOpportunityRadarSnapshot,
} from '../api/opportunity_radar.js'

const apiSource = readFileSync(
  new URL('../api/opportunity_radar.js', import.meta.url),
  'utf8',
)

const NOW = Date.parse('2026-09-02T10:00:00+08:00')

function sectorState() {
  return {
    market: {
      phase: 'live',
      tradingDay: true,
      day: '2026-09-02',
    },
    intraday: {
      session: 'intraday',
      signalDate: '2026-09-02',
      generatedAt: NOW,
      sectors: [],
    },
    latest: null,
    task: null,
  }
}

function formulaState() {
  return {
    intraday: {
      mode: 'INTRADAY',
      tradeDate: '2026-09-02',
      generatedAt: NOW,
      candidates: [],
    },
    close: null,
    progress: {},
  }
}

test('机会雷达聚合读取会并行启动业务来源与统计基线', async () => {
  const started = []
  const resolvers = []
  const source = (name, value) => () => new Promise((resolve) => {
    started.push(name)
    resolvers.push(() => resolve(value))
  })
  const pending = readOpportunityRadarSnapshot({
    now: NOW,
    readSector: source('sector', sectorState()),
    readFormula: source('formula', formulaState()),
    readTail: source('tail', null),
    readBaseline: source('baseline', {
      schemaVersion: 'opportunity-radar-baseline.v1',
    }),
  })

  await Promise.resolve()
  assert.deepEqual(
    started.sort(),
    ['baseline', 'formula', 'sector', 'tail'],
  )
  resolvers.forEach((resolve) => resolve())
  const result = await pending
  assert.equal(result.schemaVersion, 'opportunity-radar.v1')
  assert.equal(result.sourceStatus.sector.status, 'fresh')
  assert.equal(
    result.baseline.schemaVersion,
    'opportunity-radar-baseline.v1',
  )
})

test('单个来源失败时仍返回其它结果并标记失败来源', async () => {
  const result = await readOpportunityRadarSnapshot({
    now: NOW,
    readSector: async () => sectorState(),
    readFormula: async () => {
      throw new Error('公式存储暂时不可用')
    },
    readTail: async () => null,
  })

  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(result.sourceStatus.sector.status, 'fresh')
  assert.equal(result.sourceStatus.formulaIntraday.status, 'failed')
  assert.equal(result.sourceStatus.formulaClose.status, 'failed')
  assert.match(
    result.sourceStatus.formulaIntraday.error,
    /公式结果读取失败/,
  )
  assert.doesNotMatch(
    result.sourceStatus.formulaIntraday.error,
    /存储暂时不可用/,
  )
})

test('机会雷达接口保持账号鉴权、只读GET和禁缓存', () => {
  assert.match(apiSource, /authenticateAccountRequest/)
  assert.match(apiSource, /includeAdviceRuntime:\s*false/)
  assert.match(apiSource, /Cache-Control',\s*'no-store'/)
  assert.match(apiSource, /req\.method !== 'GET'/)
  assert.match(apiSource, /Promise\.allSettled/)
  assert.match(apiSource, /SOURCE_READ_TIMEOUT_MS/)
  assert.match(apiSource, /withTimeout/)
  assert.doesNotMatch(apiSource, /generateSectorForecastSnapshot/)
  assert.doesNotMatch(apiSource, /runFormulaSelection/)
  assert.doesNotMatch(apiSource, /runTailPick/)
})
