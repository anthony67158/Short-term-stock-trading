import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const component = readFileSync(
  new URL('../src/components/DailyReport.jsx', import.meta.url),
  'utf8',
)

test('日报界面按三个场次渲染固定模板并分离硬数据与分析观点', () => {
  assert.match(component, /MorningReport/)
  assert.match(component, /NoonReport/)
  assert.match(component, /EveningReport/)
  assert.match(component, /客观数据/)
  assert.match(component, /分析师观点/)
  assert.match(component, /今日板块池/)
  assert.match(component, /今日个股池/)
  assert.match(component, /早报验证/)
  assert.match(component, /龙虎榜/)
  assert.match(component, /北向成交/)
})

test('日报界面展示关键价位、来源时间和统一风险声明', () => {
  assert.match(component, /pricePlan/)
  assert.match(component, /publishedAt/)
  assert.match(component, /不构成投资建议/)
  assert.match(component, /官方最终披露为准/)
})
