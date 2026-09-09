import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import { MainApp } from '../../src/App.jsx'
import { planStore } from '../../src/planStore.js'
import { alertStore, useAlertStore } from '../../src/alertStore.js'
import { activateAccountSession } from '../../shared/accountSessionScope.js'

if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') {
  throw new Error('Local replay only')
}
const nativeFetch = window.fetch.bind(window)
async function request(path, data) {
  const response = await nativeFetch(`/__test/${path}`, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('Local replay transport failed')
  return response.json()
}
let snapshot = await request('state')
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.origin)
  if (!url.pathname.startsWith('/api/')) {
    if (url.origin !== location.origin) throw new Error('Replay external network blocked')
    return nativeFetch(input, options)
  }
  if (url.pathname === '/api/cron_advice' && options.body) {
    const body = JSON.parse(options.body)
    if (body.op === 'triggerPriceReview') {
      return new Response(JSON.stringify(await request('trigger', body)))
    }
  }
  const empty = { ok: true, list: [], history: [], updatedAt: Date.now() }
  const market = {
    indices: [{ code: '000001', name: '模拟指数', price: 3200, pct: 0.6 }],
    breadth: { up: 3200, down: 1800, flat: 100, limitUp: 55, limitDown: 3 },
  }
  const body = url.pathname === '/api/quote'
    ? { ...empty, list: Object.values(snapshot.quotes) }
    : url.pathname === '/api/market_snapshot'
      ? { ...empty, market, sectors: empty, limitUp: empty, brokenLimit: empty, movers: empty, speed: empty, errors: {} }
      : empty
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
activateAccountSession('local-simulation')
planStore.setData(snapshot.book)
planStore.registerSaver(async (book) => {
  await request('save', { book })
  return true
})

function Replay() {
  const [state, setState] = useState(snapshot)
  const notifications = useAlertStore()
  async function step(kind) {
    await planStore.flushSave()
    snapshot = await request(kind, { now: Date.now() })
    if (kind === 'touch') {
      alertStore.evaluate(snapshot.quotes, snapshot.now)
      alertStore.evaluate(snapshot.quotes, snapshot.now)
    } else {
      planStore.setData(snapshot.book)
      if (snapshot.notification) alertStore.publish(snapshot.notification)
    }
    setState(snapshot)
  }
  return <>
    <section aria-label="本地回放控制" style={{ padding: 12, borderBottom: '1px solid #888' }}>
      <button onClick={() => step('touch')}>回放价格命中</button>
      <button onClick={() => step('settle')}>完成观察与复核</button>
      <button onClick={() => step('repeat')}>重放终态通知</button>
      <output data-testid="replay-state">
        {JSON.stringify({
          modelCalls: state.modelCalls,
          notifications: notifications.notifications.length,
          banners: notifications.banners.length,
          observedMs: state.observedMs,
        })}
      </output>
    </section>
    <MainApp />
  </>
}
ReactDOM.createRoot(document.getElementById('root')).render(<Replay />)
