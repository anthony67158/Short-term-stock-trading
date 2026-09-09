import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import { MainApp } from '../../src/App.jsx'
import { alertStore } from '../../src/alertStore.js'
import { planStore } from '../../src/planStore.js'

if (!import.meta.env.DEV) {
  throw new Error('Local fixture only')
}

const now = Date.now()
const alerts = ['第一条', '第二条', '第三条'].map(
  (name, index) => ({
    id: `banner-fixture-${index + 1}`,
    code: `00000${index + 1}`,
    name,
    type: 'plan-condition',
    opQty: '减仓1手',
    phase: 'triggered',
    enabled: false,
    triggeredAt: now - (index + 1) * 1000,
    triggeredMsg: `测试条件${index + 1}已满足`,
  }),
)

const originalFetch = window.fetch
window.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string' ? input : input.url,
    location.origin,
  )
  if (url.origin !== location.origin) {
    return originalFetch(input, options)
  }
  return new Response(
    JSON.stringify({
      ok: true,
      list: [],
      history: [],
      updatedAt: now,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}

planStore.setData({
  plan: [],
  holding: [],
  closed: [],
  alerts,
  advice: {},
  account: {
    totalAssets: 0,
    cash: 0,
    updatedAt: now,
  },
  settings: {},
})

setTimeout(() => {
  alertStore.syncCloudNotifications([
    ...alerts,
    {
      id: 'banner-fixture-live',
      code: '000004',
      name: '实时新事件',
      type: 'plan-condition',
      opQty: '减仓1手',
      phase: 'triggered',
      enabled: false,
      triggeredAt: Date.now(),
      triggeredMsg: '页面就绪后新条件已满足',
    },
  ])
}, 1000)

ReactDOM.createRoot(
  document.getElementById('root'),
).render(<MainApp />)
