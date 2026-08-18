import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  collectSectorRows,
  mapSectorRow,
} from '../api/sectors.js'

test('概念板块超过单页100条时继续分页并按代码去重', async () => {
  const calls = []
  const pages = {
    1: {
      data: {
        total: 205,
        diff: Array.from({ length: 100 }, (_, index) => ({
          f12: `BK${String(index).padStart(4, '0')}`,
        })),
      },
    },
    2: {
      data: {
        total: 205,
        diff: Array.from({ length: 100 }, (_, index) => ({
          f12: `BK${String(index + 99).padStart(4, '0')}`,
        })),
      },
    },
    3: {
      data: {
        total: 205,
        diff: Array.from({ length: 6 }, (_, index) => ({
          f12: `BK${String(index + 199).padStart(4, '0')}`,
        })),
      },
    },
  }

  const rows = await collectSectorRows(async (page) => {
    calls.push(page)
    return pages[page]
  })

  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(rows.length, 205)
  assert.equal(new Set(rows.map((item) => item.f12)).size, 205)
})

test('行业板块不足一页时只请求一次', async () => {
  const calls = []
  const rows = await collectSectorRows(async (page) => {
    calls.push(page)
    return {
      data: {
        total: 2,
        diff: [{ f12: 'BK0001' }, { f12: 'BK0002' }],
      },
    }
  })

  assert.deepEqual(calls, [1])
  assert.equal(rows.length, 2)
})

test('概念总数超过500时允许读取第六页', async () => {
  const calls = []
  const rows = await collectSectorRows(async (page) => {
    calls.push(page)
    const count = page === 6 ? 4 : 100
    return {
      data: {
        total: 504,
        diff: Array.from({ length: count }, (_, index) => ({
          f12: `BK${String((page - 1) * 100 + index).padStart(4, '0')}`,
        })),
      },
    }
  })

  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6])
  assert.equal(rows.length, 504)
})

test('板块领涨股使用真实领涨字段，不把市场标识f206伪装成涨幅', () => {
  const row = mapSectorRow({
    f12: 'BK1201',
    f14: '电子',
    f3: 3.95,
    f128: '中石科技',
    f140: '300684',
    f136: 20,
    f204: '长鑫科技',
    f205: '688825',
    f206: 1,
  })

  assert.equal(row.leadName, '中石科技')
  assert.equal(row.leadCode, '300684')
  assert.equal(row.leadPct, 20)
  assert.notEqual(row.leadPct, 1)
})

test('板块领涨股涨幅缺失时保持为空，不伪造0%', () => {
  const row = mapSectorRow({
    f12: 'BK0001',
    f14: '测试板块',
    f128: '测试股票',
    f140: '600000',
    f136: '-',
  })

  assert.equal(row.leadPct, null)
})

test('板块资金榜可展示真实0%领涨幅，但缺失值不展示', () => {
  const sectorPanel = readFileSync(
    new URL('../src/components/SectorPanel.jsx', import.meta.url),
    'utf8',
  )

  assert.match(sectorPanel, /s\.leadPct != null/)
  assert.doesNotMatch(sectorPanel, /\{s\.leadPct \?/)
})
