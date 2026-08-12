import test from 'node:test'
import assert from 'node:assert/strict'

import { createLocalAdviceDailyReportGate } from '../src/adviceDailyReport.js'

const NOW = Date.parse('2026-08-12T02:30:00.000Z')
const SUMMARY = {
  day: '2026-08-12',
  session: 'morning',
  sessionCn: '盘前早报',
  text: '控制仓位，等待价格确认。',
}

test('本地军师首次生成先准备日报且后续直接复用', async () => {
  let calls = 0
  const phases = []
  const ensure = createLocalAdviceDailyReportGate({
    now: () => NOW,
    fetchReport: async ({ session, holdings, onPhase }) => {
      calls++
      assert.equal(session, 'morning')
      assert.deepEqual(holdings, [
        { code: '600000', name: '浦发银行' },
      ])
      onPhase({ text: '正在撰写策略日报' })
      return { ok: true, summary: SUMMARY }
    },
  })

  const first = await ensure({
    holdings: [
      { code: '600000', name: '浦发银行' },
      { code: '600000', name: '浦发银行' },
    ],
    onPhase: (text) => phases.push(text),
  })
  const second = await ensure({ holdings: [] })

  assert.equal(calls, 1)
  assert.deepEqual(first.summary, SUMMARY)
  assert.deepEqual(second.summary, SUMMARY)
  assert.ok(phases.includes('正在撰写策略日报'))
})

test('本地日报生成失败时不继续伪造军师建议', async () => {
  const ensure = createLocalAdviceDailyReportGate({
    now: () => NOW,
    fetchReport: async () => ({
      ok: false,
      error: '日报服务超时',
    }),
  })

  await assert.rejects(
    () => ensure({ holdings: [] }),
    /日报服务超时/,
  )
})
