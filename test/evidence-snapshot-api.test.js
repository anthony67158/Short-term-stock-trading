import test from 'node:test'
import assert from 'node:assert/strict'

import handler, {
  evidenceSnapshotResponse,
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

  assert.deepEqual(evidenceSnapshotResponse(account, 'ev_test'), {
    status: 200,
    body: {
      ok: true,
      snapshot: account.data.evidenceSnapshots.ev_test,
    },
  })
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
