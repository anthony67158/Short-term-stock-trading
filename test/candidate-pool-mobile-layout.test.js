import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const todayTab = fs.readFileSync(
  new URL('../src/components/TodayTab.jsx', import.meta.url),
  'utf8',
)
const styles = fs.readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)

test('选股页撤下重复热度榜，唯一雷达在移动端使用单列', () => {
  assert.doesNotMatch(todayTab, /CandidatePool|今日精选候选池/)
  assert.match(todayTab, /<OpportunityRadar/)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.opportunity-row\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
})
