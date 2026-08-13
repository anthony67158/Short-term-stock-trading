import test from 'node:test'
import assert from 'node:assert/strict'

import handler, {
  evidenceSnapshotResponse,
  evidenceSnapshotComparisonResponse,
  validSnapshotId,
} from '../api/evidence_snapshots.js'

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    send(value) {
      this.body = typeof value === 'string' ? value : JSON.stringify(value)
      return this
    },
    end(value = '') {
      this.body = typeof value === 'string' ? value : JSON.stringify(value)
      return this
    },
  }
}

test('回放接口只接受规范snapshotId', () => {
  assert.equal(validSnapshotId('ev_mep_abc123'), true)
  assert.equal(validSnapshotId('../current.json'), false)
  assert.equal(validSnapshotId('ev bad'), false)
  assert.equal(validSnapshotId(''), false)
})

test('回放响应按ID返回完整快照且不存在时返回404', () => {
  const account = {
    data: {
      evidenceSnapshots: {
        ev_test: {
          snapshotId: 'ev_test',
          schemaVersion: 'canonical-evidence.v1',
          asOf: '2026-08-13T02:00:00.000Z',
        },
      },
    },
  }

  const response = evidenceSnapshotResponse(account, 'ev_test')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(
    response.body.snapshot,
    account.data.evidenceSnapshots.ev_test,
  )
  assert.equal(response.body.replay.snapshotId, 'ev_test')
  assert.deepEqual(response.body.linkedRecords.decisionEvents, [])
  assert.equal(evidenceSnapshotResponse(account, 'ev_missing').status, 404)
})

test('未登录回放请求返回401且不泄露快照存在性', async () => {
  const req = {
    method: 'GET',
    headers: {},
    query: { snapshotId: 'ev_test' },
  }
  const res = responseCapture()

  await handler(req, res)

  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('对比响应同时返回两个确定性回放和结构化差异', () => {
  const base = {
    snapshotId: 'ev_base',
    schemaVersion: 'canonical-evidence.v1',
    asOf: '2026-08-13T02:00:00.000Z',
    mode: 'hold_advice',
    security: { code: '600001', name: '样本' },
    account: { revision: 1, holdQty: 1, sellableTodayQty: 1 },
    evidence: { quote: { price: 10 } },
  }
  const next = {
    ...base,
    snapshotId: 'ev_next',
    asOf: '2026-08-13T03:00:00.000Z',
    evidence: { quote: { price: 11 } },
  }
  const account = {
    data: {
      evidenceSnapshots: {
        ev_base: base,
        ev_next: next,
      },
      decisionLog: [{
        id: 'd1',
        evidenceSnapshotId: 'ev_next',
        at: 100,
      }],
    },
  }

  const response = evidenceSnapshotComparisonResponse(
    account,
    'ev_next',
    'ev_base',
  )

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.replay.snapshotId, 'ev_next')
  assert.equal(response.body.compareReplay.snapshotId, 'ev_base')
  assert.equal(response.body.comparison.comparable, true)
  assert.deepEqual(
    response.body.linkedRecords.decisionEvents.map((item) => item.id),
    ['d1'],
  )
})

test('compareTo不存在时返回404且不回退成单快照响应', () => {
  const account = {
    data: {
      evidenceSnapshots: {
        ev_base: {
          snapshotId: 'ev_base',
          asOf: '2026-08-13T02:00:00.000Z',
        },
      },
    },
  }

  assert.equal(
    evidenceSnapshotComparisonResponse(
      account,
      'ev_base',
      'ev_missing',
    ).status,
    404,
  )
})
