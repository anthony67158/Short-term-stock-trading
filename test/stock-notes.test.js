import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOCK_NOTE_MAX_LENGTH,
  mergeStockNotesByTimestamp,
  normalizeStockNoteText,
  normalizeStockNotes,
  stockNoteText,
  stockNotesAfter,
} from '../shared/stockNotes.js'
import {
  accountSyncDelta,
  applyClientAccountSave,
} from '../api/account.js'
import { planStore } from '../src/planStore.js'

test('股票备注清理控制字符并限制长度', () => {
  const raw = `  关注订单\u0000变化\r\n${'想'.repeat(STOCK_NOTE_MAX_LENGTH)}  `
  const text = normalizeStockNoteText(raw)

  assert.equal(text.includes('\u0000'), false)
  assert.equal(text.includes('\r'), false)
  assert.equal(Array.from(text).length, STOCK_NOTE_MAX_LENGTH)
})

test('股票备注按更新时间合并且保留删除标记', () => {
  const merged = mergeStockNotesByTimestamp({
    '600519': { text: '本机新判断', updatedAt: 300 },
    '000001': { text: '', updatedAt: 400 },
  }, {
    '600519': { text: '云端旧判断', updatedAt: 200 },
    '000001': { text: '已经删除的旧备注', updatedAt: 350 },
    bad: { text: '非法代码', updatedAt: 500 },
  })

  assert.equal(stockNoteText(merged, '600519'), '本机新判断')
  assert.equal(stockNoteText(merged, '000001'), '')
  assert.equal('bad' in merged, false)
})

test('账号保存按股票合并备注且旧客户端不能清空云端备注', () => {
  const account = {
    nick: '备注同步账号',
    clientRevision: 7,
    data: {
      plan: [],
      holding: [],
      closed: [],
      stockNotes: {
        '600519': { text: '云端较新备注', updatedAt: 500 },
        '000001': { text: '仅云端存在', updatedAt: 300 },
      },
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [],
    holding: [],
    closed: [],
    stockNotes: {
      '600519': { text: '本机旧备注', updatedAt: 400 },
      '300750': { text: '本机新增备注', updatedAt: 600 },
    },
  }, 7)

  assert.equal(result.ok, true)
  assert.equal(stockNoteText(account.data.stockNotes, '600519'), '云端较新备注')
  assert.equal(stockNoteText(account.data.stockNotes, '000001'), '仅云端存在')
  assert.equal(stockNoteText(account.data.stockNotes, '300750'), '本机新增备注')
})

test('账号增量同步只返回游标后的备注更新与删除', () => {
  const stockNotes = {
    '600519': { text: '旧备注', updatedAt: 100 },
    '000001': { text: '新备注', updatedAt: 300 },
    '300750': { text: '', updatedAt: 400 },
  }
  const delta = accountSyncDelta({ stockNotes }, 200)

  assert.deepEqual(Object.keys(stockNotesAfter(stockNotes, 200)).sort(), ['000001', '300750'])
  assert.deepEqual(Object.keys(delta.stockNotes).sort(), ['000001', '300750'])
  assert.equal(delta.stockNotes['300750'].text, '')
})

test('planStore 保存、读取和清除股票备注并进入账号快照', async () => {
  let saved = null
  planStore.registerSaver(async (data) => {
    saved = structuredClone(data)
    return true
  })
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    stockNotes: {
      '600519': { text: '原备注', updatedAt: 100 },
    },
  })

  const updated = planStore.setStockNote('600519', '  新备注  ', 200)
  await planStore.flushSave()

  assert.equal(updated.ok, true)
  assert.equal(planStore.getStockNote('600519'), '新备注')
  assert.equal(saved.stockNotes['600519'].text, '新备注')

  planStore.setStockNote('600519', '   ', 300)
  assert.equal(planStore.getStockNote('600519'), '')
  assert.deepEqual(
    normalizeStockNotes(planStore.get().stockNotes)['600519'],
    { text: '', updatedAt: 300 },
  )
})
