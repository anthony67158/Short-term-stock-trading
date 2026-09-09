import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { authStore } from '../../src/authStore.js'
import { planStore, usePlanStore } from '../../src/planStore.js'
import { writeAccountSnapshotCache } from '../../src/accountSnapshotCache.js'

if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') throw new Error('Local only')
const nick = 'local-restore-simulation'
const token = 'local-non-authenticating-token'
const data = {
  plan: [{ code: '601318', name: '本地模拟' }], holding: [], closed: [],
  alerts: [{ id: 'test-alert', code: '601318', type: 'price', op: 'gte', value: 60, enabled: true }],
  account: null, settings: {}, advice: {}, decisionLog: [], executionPlans: [],
}
let remote = structuredClone(data)
let release
let writes = 0
localStorage.setItem('cloud_session_v1', JSON.stringify({ nick, token }))
localStorage.removeItem('cloud_save_outbox_v1')
writeAccountSnapshotCache(nick, { data, revision: 1, updatedAt: Date.now() })
window.fetch = async (_url, options = {}) => {
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : {}
  if (body.action === 'get') {
    const before = structuredClone(remote)
    await new Promise((resolve) => { release = resolve })
    return new Response(JSON.stringify({ ok: true, data: before, token, revision: 1, storage: 'oss', updatedAt: Date.now() }))
  }
  if (body.action === 'save') {
    remote = structuredClone(body.data)
    writes++
    return new Response(JSON.stringify({ ok: true, revision: 2, storage: 'oss', updatedAt: Date.now() }))
  }
  return new Response(JSON.stringify({ ok: true, list: [] }))
}
void authStore.boot()
function Preview() {
  const book = usePlanStore()
  const [cloud, setCloud] = useState(null)
  return <>
    <button onClick={() => { planStore.removeAlert('test-alert'); planStore.removePlan('601318') }}>删除本地规则与自选</button>
    <button onClick={() => release?.()}>返回延迟云端快照</button>
    <button onClick={() => setCloud({ plan: remote.plan.length, alerts: remote.alerts.length, writes })}>检查保存结果</button>
    <output data-testid="local">{JSON.stringify({ plan: book.plan.length, alerts: book.alerts.length })}</output>
    <output data-testid="cloud">{JSON.stringify(cloud)}</output>
  </>
}
ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
