import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { productionForecastWindow } from '../shared/productionForecastWindow.js'

const stockDetail = readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)
const aiApi = readFileSync(
  new URL('../api/ai.js', import.meta.url),
  'utf8',
)
const prompts = readFileSync(
  new URL('../api/_ai_prompts.js', import.meta.url),
  'utf8',
)

test('开盘前上一交易日信号的下一交易日预测明确标记为今日', () => {
  const result = productionForecastWindow({
    asOf: '2026-08-17',
    now: Date.parse('2026-08-18T00:30:00Z'),
  })

  assert.equal(result.kind, 'today')
  assert.equal(result.label, '今日预测')
  assert.equal(result.shortLabel, '今日')
  assert.match(result.note, /预测今日完整交易日/)
})

test('盘中上一收盘信号只能叫今日整日预测而非剩余时段预测', () => {
  const result = productionForecastWindow({
    asOf: '2026-08-17',
    targetDate: '2026-08-18',
    now: Date.parse('2026-08-18T02:00:00Z'),
  })

  assert.equal(result.kind, 'today-full-session')
  assert.equal(result.isTodayTarget, true)
  assert.equal(result.label, '今日整日预测')
  assert.match(result.note, /不是当前时点到收盘/)
})

test('今日K线已进入信号后保持下一交易日口径', () => {
  const result = productionForecastWindow({
    asOf: '2026-08-18',
    now: Date.parse('2026-08-18T02:00:00Z'),
  })

  assert.equal(result.kind, 'next-trading-day')
  assert.equal(result.label, '下一交易日预测')
  assert.match(result.note, /不提供今日剩余时段概率/)
})

test('收盘后旧信号不冒充仍可执行的今日预测', () => {
  const result = productionForecastWindow({
    asOf: '2026-08-17',
    now: Date.parse('2026-08-18T08:00:00Z'),
  })

  assert.equal(result.kind, 'stale-session')
  assert.equal(result.label, '最近交易日预测')
  assert.match(result.note, /等待今日收盘K线更新/)
})

test('个股详情展示生产模型今日方向概率与价格区间', () => {
  assert.match(stockDetail, /productionForecastWindow/)
  assert.match(stockDetail, /q\.nextTradeDayForecast/)
  assert.match(stockDetail, /production-next-forecast/)
  assert.match(stockDetail, /上涨概率/)
  assert.match(stockDetail, /P10-P90/)
  assert.match(stockDetail, /不是当前时点到收盘/)
})

test('今日完整交易日预测贯穿军师载荷且不冒充盘中剩余时段', () => {
  assert.match(
    aiApi,
    /currentTradingDayForecast:\s*quant\.currentTradingDayForecast/,
  )
  assert.match(
    aiApi,
    /currentTradingDayForecast:\s*payload\.quant\.currentTradingDayForecast/,
  )
  assert.match(prompts, /今日完整交易日预测/)
  assert.match(prompts, /不是“从当前时点到收盘”的盘中预测/)
})
