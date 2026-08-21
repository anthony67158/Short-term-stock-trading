import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockGroups,
  filterStocksByGroup,
  selectBatchGroupCodes,
  stockGroupName,
  stockGroupNames,
  toggleBatchGroupSelection,
} from '../shared/stockGroupFilter.js'

const holdings = [
  { id: 'h1', code: '600111', name: '北方稀土', industry: '小金属' },
  { id: 'h2', code: '600111', name: '北方稀土', industry: '小金属' },
  { id: 'h3', code: '600222', name: '太龙药业', industry: '中药' },
]

const watchlist = [
  { code: '000001', name: '平安银行', industry: '银行', star: true },
  { code: '300750', name: '宁德时代', industry: '电池' },
]

const tagMap = {
  '600111': {
    primaryTopic: '稀土永磁',
    industry: '小金属',
    concepts: ['稀土永磁', '国企改革'],
  },
  '600222': {
    primaryTopic: '创新药',
    industry: '中药',
    concepts: ['创新药'],
  },
  '000001': {
    primaryTopic: '跨境支付',
    industry: '银行',
    concepts: ['跨境支付'],
  },
  '300750': {
    primaryTopic: '固态电池',
    industry: '电池',
    concepts: ['固态电池'],
  },
}

const quoteMap = {
  '600111': { pct: 2.5, industry: '小金属' },
  '600222': { pct: -1.2, industry: '中药' },
  '000001': { pct: 0.4, industry: '银行' },
  '300750': { pct: 3.1, industry: '电池' },
}

test('默认按核心概念归类，行业模式使用真实行业并允许行情回退', () => {
  assert.equal(stockGroupName(holdings[0], tagMap['600111'], quoteMap['600111']), '稀土永磁')
  assert.deepEqual(
    stockGroupNames(holdings[0], tagMap['600111'], quoteMap['600111']),
    ['稀土永磁'],
  )
  assert.equal(stockGroupName(holdings[0], tagMap['600111'], quoteMap['600111'], 'industry'), '小金属')
  assert.equal(
    stockGroupName(
      { code: '601985' },
      null,
      { industry: '电力' },
      'industry',
    ),
    '电力',
  )
})

test('分组胶囊按股票代码去重且只按核心概念归组', () => {
  const groups = buildStockGroups(holdings, {
    dimension: 'concept',
    tagMap,
    quoteMap,
  })

  assert.deepEqual(Object.fromEntries(
    groups.map(({ name, count, avgPct }) => [name, { count, avgPct }]),
  ), {
    稀土永磁: { count: 1, avgPct: 2.5 },
    创新药: { count: 1, avgPct: -1.2 },
  })
})

test('概念筛选只匹配核心概念并保留同股全部持仓批次', () => {
  const core = filterStocksByGroup(holdings, '稀土永磁', {
    dimension: 'concept',
    tagMap,
    quoteMap,
  })
  const secondary = filterStocksByGroup(holdings, '国企改革', {
    dimension: 'concept',
    tagMap,
    quoteMap,
  })

  assert.deepEqual(core.map((item) => item.id), ['h1', 'h2'])
  assert.deepEqual(secondary, [])
})

test('一次性生成保留持仓、自选和两者范围，并按概念批量选股', () => {
  const base = {
    holdings,
    watchlist,
    dimension: 'concept',
    group: '固态电池',
    tagMap,
    quoteMap,
  }

  assert.deepEqual(selectBatchGroupCodes({ ...base, scope: 'holding' }), [])
  assert.deepEqual(selectBatchGroupCodes({ ...base, scope: 'watchlist' }), ['300750'])
  assert.deepEqual(selectBatchGroupCodes({ ...base, scope: 'all' }), ['300750'])
  assert.deepEqual(
    selectBatchGroupCodes({
      ...base,
      scope: 'holding',
      group: '国企改革',
    }),
    [],
  )
  assert.deepEqual(
    selectBatchGroupCodes({ ...base, scope: 'all', group: '全部' }),
    ['600111', '600222', '000001', '300750'],
  )
})

test('一次性生成支持多选概念组并按股票代码合并去重', () => {
  assert.deepEqual(
    selectBatchGroupCodes({
      holdings,
      watchlist,
      scope: 'all',
      dimension: 'concept',
      groups: ['稀土永磁', '固态电池'],
      tagMap,
      quoteMap,
    }),
    ['600111', '300750'],
  )
  assert.deepEqual(
    selectBatchGroupCodes({
      holdings,
      watchlist,
      scope: 'all',
      dimension: 'concept',
      groups: [],
      tagMap,
      quoteMap,
    }),
    [],
  )
})

test('自选置顶可单独生成并继续与概念板块取交集', () => {
  assert.deepEqual(
    selectBatchGroupCodes({
      holdings,
      watchlist,
      scope: 'watchlist',
      pinnedOnly: true,
      group: '全部',
      tagMap,
      quoteMap,
    }),
    ['000001'],
  )
  assert.deepEqual(
    selectBatchGroupCodes({
      holdings,
      watchlist,
      scope: 'watchlist',
      pinnedOnly: true,
      groups: ['跨境支付'],
      tagMap,
      quoteMap,
    }),
    ['000001'],
  )
  assert.deepEqual(
    selectBatchGroupCodes({
      holdings,
      watchlist,
      scope: 'watchlist',
      pinnedOnly: true,
      groups: ['固态电池'],
      tagMap,
      quoteMap,
    }),
    [],
  )
})

test('多选板块可独立增删，全部与具体板块互斥', () => {
  assert.deepEqual(toggleBatchGroupSelection([], '稀土永磁'), ['稀土永磁'])
  assert.deepEqual(
    toggleBatchGroupSelection(['稀土永磁'], '固态电池'),
    ['稀土永磁', '固态电池'],
  )
  assert.deepEqual(
    toggleBatchGroupSelection(['稀土永磁', '固态电池'], '稀土永磁'),
    ['固态电池'],
  )
  assert.deepEqual(toggleBatchGroupSelection(['固态电池'], '全部'), ['全部'])
  assert.deepEqual(toggleBatchGroupSelection(['全部'], '创新药'), ['创新药'])
  assert.deepEqual(toggleBatchGroupSelection(['全部'], '全部'), [])
})
