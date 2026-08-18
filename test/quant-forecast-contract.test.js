import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const quantApp = read('qlib-service/app.py')
const aiApi = read('api/ai.js')
const prompts = read('api/_ai_prompts.js')
const today = read('src/components/TodayTab.jsx')

test('生产日线量化保持五日契约并新增下一交易日概率与区间', () => {
  assert.match(quantApp, /"forecast": forecast\(f, days=5\)/)
  assert.match(quantApp, /"nextTradeDayForecast": forecast\(f, days=1\)/)
  assert.match(quantApp, /"rangeType": "P10-P90"/)
  assert.match(quantApp, /"rangeConfidencePct": 80/)
  assert.match(quantApp, /"garchMonteCarlo"/)
  assert.match(quantApp, /"historicalVolMonteCarlo"/)
})

test('日线模型明确拒绝把今日盘中价带冒充同日概率预测', () => {
  assert.match(quantApp, /"currentSession": False/)
  assert.match(
    quantApp,
    /daily_model_has_no_intraday_remaining-session_label/,
  )
  assert.match(prompts, /禁止把盘中支撑压力或实时执行价带冒充同日模型预测/)
  assert.match(prompts, /V2\.1实验头/)
})

test('下一交易日量化结果贯穿军师载荷、进度事件和选股候选', () => {
  assert.match(aiApi, /nextTradeDayForecast: quant\.nextTradeDayForecast/)
  assert.match(aiApi, /nextTradeDayForecast: payload\.quant\.nextTradeDayForecast/)
  assert.match(today, /nextUpProb: next && next\.upProb/)
  assert.match(today, /nextTargetLow: next && next\.targetLow/)
  assert.match(prompts, /nextUpProb\/nextExpRet\/nextTargetLow~nextTargetHigh/)
})
