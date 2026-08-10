import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeAccountEvents } from '../api/account.js'

test('账号保存合并保留服务端较新的执行状态和客户端新增事件', () => {
  const client = [
    { id: 'rec_1', kind: 'recommendation', status: 'pending', at: 100 },
    { id: 'exec_2', kind: 'execution', at: 300 },
  ]
  const server = [
    { id: 'rec_1', kind: 'recommendation', status: 'executed', at: 100, executedAt: 250 },
    { id: 'rec_3', kind: 'recommendation', status: 'pending', at: 200 },
  ]

  const merged = mergeAccountEvents(client, server, 1000)

  assert.deepEqual(merged.map((event) => event.id), ['exec_2', 'rec_3', 'rec_1'])
  assert.equal(merged.find((event) => event.id === 'rec_1').status, 'executed')
  assert.equal(merged.length, 3)
})
