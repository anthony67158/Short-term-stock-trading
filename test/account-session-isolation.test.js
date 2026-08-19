import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountScopedStorageKey,
  accountSessionMatches,
  activateAccountSession,
  currentAccountSession,
} from '../shared/accountSessionScope.js'
import { planStore } from '../src/planStore.js'

test('账号会话代次会拒绝上一账号的迟到结果', () => {
  activateAccountSession('账号A')
  const stale = currentAccountSession()

  activateAccountSession('账号B')

  assert.equal(accountSessionMatches(stale), false)
  assert.equal(accountSessionMatches(currentAccountSession()), true)
  assert.notEqual(
    accountScopedStorageKey('ai_pick_v1', stale),
    accountScopedStorageKey('ai_pick_v1'),
  )
})

test('注入新账号快照时清空上一账号的撤销历史', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '账号A股票' }],
    holding: [],
    closed: [],
  })
  planStore.buy('600000', 10, 1)
  assert.equal(planStore.canUndo(), true)

  planStore.setData({
    plan: [{ code: '000001', name: '账号B股票' }],
    holding: [],
    closed: [],
  })

  assert.equal(planStore.canUndo(), false)
  assert.equal(planStore.undo(), null)
  assert.deepEqual(planStore.get().plan.map((item) => item.code), ['000001'])
})
