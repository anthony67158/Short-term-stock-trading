import test from 'node:test'
import assert from 'node:assert/strict'
import { planStore } from '../src/planStore.js'
import {
  normalizeSelectionOrigin, selectionOriginFromOpportunity, selectionSourcePerformance,
} from '../shared/selectionOrigin.js'
import { adviceGenerationStateFingerprint } from '../shared/accountSync.js'

const row = {
  code: '600001', name: '虚构测试', origin: 'PRE_CATALYST',
  evidence: ['官方订单公告，等待量价确认'],
  blockers: ['尚未触发'],
  entryPlan: { price: 10, trigger: '回踩企稳', validUntil: 2000000000000 },
  exitPlan: { hardStopPrice: 9, takeProfitPrice: 12, timeStopDate: '2026-09-10' },
  event: { eventId: 'test-event', sourceUrl: 'https://example.com/announcement' },
}
const origin = selectionOriginFromOpportunity(row, { generatedAt: 100 }, 200)

test('来源仅保留可追溯字段，不保存任意外部内容或危险链接', () => {
  const value = normalizeSelectionOrigin({ ...origin, sourceUrl: 'javascript:alert(1)', token: 'not-a-real-secret' })
  assert.equal(value.sourceUrl, '')
  assert.equal(value.token, undefined)
  assert.equal(value.entry.price, 10)
  assert.equal(value.exit.stopPrice, 9)
  assert.equal(value.label, '预催化发现')
})

test('雷达来源贯穿自选、买入、部分卖出与清仓回归', () => {
  planStore.setData({ account: { cash: 100000 }, holding: [], plan: [], closed: [] })
  planStore.addPlan(row, '', origin)
  assert.equal(planStore.get().plan[0].selectionOrigin.eventId, 'test-event')
  assert.equal(planStore.get().alerts.length, 0)
  assert.equal(planStore.buy(row.code, 10, 2).ok, true)
  let book = planStore.get()
  assert.equal(book.holding[0].selectionOrigin.entry.price, 10)
  assert.equal(book.closed[0].selectionOrigin.capturedAt, 200)
  planStore.setData({
    ...book,
    holding: book.holding.map((item) => ({ ...item, buyAt: 1 })),
    closed: book.closed.map((item) => ({ ...item, at: 1, buyAt: 1 })),
  })
  const id = planStore.get().holding[0].id
  assert.equal(planStore.sell(id, 11, 1).ok, true)
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.sell(id, 12, 1).ok, true)
  book = planStore.get()
  assert.equal(book.holding.length, 0)
  assert.equal(book.plan[0].selectionOrigin.capturedAt, 200)
  const summary = selectionSourcePerformance(book.closed)
  assert.equal(summary[0].sales, 2)
  assert.equal(summary[0].positions, 1)
  assert.ok(summary[0].netPnl > 0)
  assert.equal(selectionSourcePerformance([...book.closed, ...book.closed])[0].sales, 2)
})

test('选股来源备注不制造交易事实变化或重复生成', () => {
  const original = { plan: [{ code: row.code }] }
  const enriched = { plan: [{ code: row.code, selectionOrigin: origin }] }
  assert.equal(adviceGenerationStateFingerprint(original), adviceGenerationStateFingerprint(enriched))
})
