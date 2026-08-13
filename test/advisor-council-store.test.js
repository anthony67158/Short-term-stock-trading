import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addCouncilShadowRecord,
  councilRecordsFromData,
} from '../shared/advisorCouncilStore.js'

function record(code, at) {
  return {
    schemaVersion: 'advisor-council-shadow.v1',
    code,
    at,
    shadowOnly: true,
    compiled: { hardGatePassed: false },
  }
}

test('委员会影子记录按时间倒序保存并限制总量与单股数量', () => {
  const data = {}
  for (let index = 0; index < 30; index++) {
    addCouncilShadowRecord(data, record('600001', index), {
      totalLimit: 20,
      perCodeLimit: 5,
    })
  }
  addCouncilShadowRecord(data, record('000001', 100), {
    totalLimit: 20,
    perCodeLimit: 5,
  })

  const records = councilRecordsFromData(data)
  assert.equal(records.length, 6)
  assert.equal(records[0].code, '000001')
  assert.equal(records.filter((item) => item.code === '600001').length, 5)
})

test('非影子或可执行记录绝不进入委员会存储', () => {
  const data = {}

  assert.equal(addCouncilShadowRecord(data, {
    schemaVersion: 'advisor-council-shadow.v1',
    shadowOnly: false,
    actionable: true,
  }), false)
  assert.deepEqual(councilRecordsFromData(data), [])
})
