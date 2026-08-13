import { authenticateAccountRequest } from './_account_auth.js'
import { applyCors, preflight } from './_lib.js'
import {
  compareEvidenceSnapshots,
  findSnapshotLinkedRecords,
  replayEvidenceSnapshot,
} from '../shared/evidenceReplay.js'

export function validSnapshotId(value) {
  return /^ev_[A-Za-z0-9_-]{3,120}$/.test(String(value || ''))
}

export function evidenceSnapshotResponse(account, snapshotId) {
  const snapshot = account?.data?.evidenceSnapshots?.[snapshotId]
  if (!snapshot) {
    return {
      status: 404,
      body: { ok: false, error: '证据快照不存在或已过期' },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      snapshot,
      replay: replayEvidenceSnapshot(snapshot),
      linkedRecords: findSnapshotLinkedRecords(
        account?.data,
        snapshotId,
      ),
    },
  }
}

export function evidenceSnapshotComparisonResponse(
  account,
  snapshotId,
  compareTo,
) {
  const current = evidenceSnapshotResponse(account, snapshotId)
  if (current.status !== 200) return current
  const previous = evidenceSnapshotResponse(account, compareTo)
  if (previous.status !== 200) return previous
  return {
    status: 200,
    body: {
      ...current.body,
      compareSnapshot: previous.body.snapshot,
      compareReplay: previous.body.replay,
      comparison: compareEvidenceSnapshots(
        previous.body.snapshot,
        current.body.snapshot,
      ),
    },
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    return res.status(405).send(JSON.stringify({
      ok: false,
      error: 'GET only',
    }))
  }

  const authentication = await authenticateAccountRequest(req)
  if (!authentication.ok || !authentication.account) {
    return res.status(401).send(JSON.stringify({
      ok: false,
      error: authentication.error || '请先登录',
    }))
  }
  const snapshotId = String(req.query?.snapshotId || '')
  if (!validSnapshotId(snapshotId)) {
    return res.status(422).send(JSON.stringify({
      ok: false,
      error: 'snapshotId格式无效',
    }))
  }
  const compareTo = String(req.query?.compareTo || '')
  if (compareTo && !validSnapshotId(compareTo)) {
    return res.status(422).send(JSON.stringify({
      ok: false,
      error: 'compareTo格式无效',
    }))
  }
  const response = compareTo
    ? evidenceSnapshotComparisonResponse(
      authentication.account,
      snapshotId,
      compareTo,
    )
    : evidenceSnapshotResponse(
      authentication.account,
      snapshotId,
    )
  return res.status(response.status).send(JSON.stringify(response.body))
}
