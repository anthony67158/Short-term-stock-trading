import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const todayTab = readFileSync(
  new URL('../src/components/TodayTab.jsx', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)

test('AI选股请求活跃概念与真实成分股并使用两级龙头保留位', () => {
  assert.match(todayTab, /\/api\/sectors\?type=concept&sort=main/)
  assert.match(todayTab, /\/api\/stocks\?code=\$\{concept\.code\}&sort=main/)
  assert.match(todayTab, /\/api\/stocks\?code=\$\{concept\.code\}&sort=pct/)
  assert.match(todayTab, /rankActiveConcepts\(/)
  assert.match(todayTab, /buildConceptLeaderCandidates\(/)
  assert.match(todayTab, /selectConceptAwareCandidatePool\(/)
  assert.match(todayTab, /conceptQuota:\s*6/)
  assert.match(todayTab, /leadershipReserve:\s*4/)
})

test('龙头身份贯穿量化与LLM短名单并在结果卡展示', () => {
  assert.match(todayTab, /conceptLeadership:\s*c\.conceptLeadership/)
  assert.match(todayTab, /const leadership = c\.conceptLeadership/)
  assert.match(todayTab, /className="pick-leadership"/)
  assert.match(todayTab, /roleLabel/)
  assert.match(todayTab, /conceptStrength/)
  assert.match(todayTab, /leaderScore/)
  assert.match(styles, /\.pick-leadership/)
  assert.match(styles, /\.pick-leadership-role/)
})
