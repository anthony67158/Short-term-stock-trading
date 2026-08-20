import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SECTOR_FORECAST_SORTS,
  sectorForecastActionView,
  sortSectorForecasts,
  summarizeSectorForecastActions,
} from '../src/sectorForecastView.js'

const rows = [{
  code: 'BK1000',
  rank: 2,
  weekRank: 3,
  phase: 'STARTUP',
  actionability: 'WAIT_PULLBACK',
  forecast: {
    next: { score: 72 },
    week: { score: 63 },
  },
}, {
  code: 'BK1001',
  rank: 3,
  weekRank: 1,
  phase: 'ACCUMULATION',
  actionability: 'LAYOUT',
  forecast: {
    next: { score: 68 },
    week: { score: 78 },
  },
}, {
  code: 'BK1002',
  rank: 1,
  weekRank: 2,
  phase: 'ACCELERATION',
  actionability: 'WATCH_ONLY',
  forecast: {
    next: { score: 80 },
    week: { score: 70 },
  },
}, {
  code: 'BK1003',
  rank: 4,
  weekRank: 4,
  phase: 'RETREAT',
  actionability: 'AVOID',
  forecast: {
    next: { score: 50 },
    week: { score: 48 },
  },
}]

test('板块前瞻提供原始排名、结论优先和分数升降序', () => {
  assert.deepEqual(SECTOR_FORECAST_SORTS, [
    'rank',
    'conclusion',
    'score_desc',
    'score_asc',
  ])
  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'next',
      sortMode: 'rank',
    }).map((item) => item.code),
    ['BK1002', 'BK1000', 'BK1001', 'BK1003'],
  )
  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'next',
      sortMode: 'conclusion',
    }).map((item) => item.code),
    ['BK1001', 'BK1000', 'BK1002', 'BK1003'],
  )
  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'next',
      sortMode: 'score_desc',
    }).map((item) => item.code),
    ['BK1002', 'BK1000', 'BK1001', 'BK1003'],
  )
  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'next',
      sortMode: 'score_asc',
    }).map((item) => item.code),
    ['BK1003', 'BK1001', 'BK1000', 'BK1002'],
  )
})

test('一周排序使用weekRank和week score且不修改原数组', () => {
  const original = rows.map((item) => item.code)

  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'week',
      sortMode: 'rank',
    }).map((item) => item.code),
    ['BK1001', 'BK1002', 'BK1000', 'BK1003'],
  )
  assert.deepEqual(
    sortSectorForecasts(rows, {
      horizon: 'week',
      sortMode: 'score_desc',
    }).map((item) => item.code),
    ['BK1001', 'BK1002', 'BK1000', 'BK1003'],
  )
  assert.deepEqual(rows.map((item) => item.code), original)
})

test('无效分数始终排在末尾且同分按原始排名稳定排序', () => {
  const sorted = sortSectorForecasts([{
    code: 'BK2000',
    rank: 2,
    forecast: { next: { score: 70 } },
  }, {
    code: 'BK2001',
    rank: 1,
    forecast: { next: { score: 70 } },
  }, {
    code: 'BK2002',
    rank: 3,
    forecast: { next: { score: null } },
  }], {
    horizon: 'next',
    sortMode: 'score_desc',
  })

  assert.deepEqual(
    sorted.map((item) => item.code),
    ['BK2001', 'BK2000', 'BK2002'],
  )
})

test('板块结论翻译为明确的买入或不买指令', () => {
  assert.deepEqual(
    sectorForecastActionView('LAYOUT'),
    {
      label: '可以买入',
      intent: 'buy',
      instruction:
        '可以小仓分批：优先核心或中军，下一交易日不高开再介入。',
    },
  )
  assert.match(
    sectorForecastActionView('WAIT_PULLBACK').instruction,
    /^先不买：/,
  )
  assert.match(
    sectorForecastActionView('WATCH_ONLY').instruction,
    /^不要追：/,
  )
  assert.match(
    sectorForecastActionView('AVOID').instruction,
    /^不买：/,
  )
  assert.deepEqual(
    sectorForecastActionView('LAYOUT', {
      session: 'intraday',
    }),
    {
      label: '可以买入',
      intent: 'buy',
      instruction:
        '可以小仓分批：优先核心或中军，盘中回踩不破且未明显冲高时介入。',
    },
  )
})

test('板块结论汇总能直接说明当前有几个可以买入', () => {
  const summary = summarizeSectorForecastActions(rows)

  assert.deepEqual(summary.counts, {
    buy: 1,
    wait: 1,
    watch: 1,
    avoid: 1,
  })
  assert.equal(summary.buyable[0].code, 'BK1001')
  assert.equal(summary.noBuy, 2)
})
